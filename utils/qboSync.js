/**
 * Pull QuickBooks invoices into shipments (PROMPT.md Phase 4).
 *
 * - Since the last successful sync (first run: QBO_SYNC_START_DATE or 30 days back).
 * - Paged with STARTPOSITION / MAXRESULTS.
 * - One transaction per invoice; one failure is logged and the sync carries on.
 * - Idempotent per invoice LINE (unique shipment_id + qbo_line_id): running twice adds nothing.
 * - Items map to recipe + format + bag/box through qbo_item_map. Unmapped items are
 *   saved as unallocated lines for an admin, never dropped and never guessed.
 * - Mapped lines are allocated oldest released batch first, split across batches;
 *   what can't be covered stays open ('partial') instead of failing the invoice.
 * - Invoices deleted or voided in QuickBooks are removed, returning their stock.
 *
 * `qbo` is { query(sql), changedInvoices(sinceIso) } (utils/qboClient.api, or a fake in tests).
 */
const { withTransaction } = require('../db');
const { allocateLine, lockBatches, refreshShipStatus } = require('./finishedStock');
const { logAudit } = require('./audit');

const PAGE_SIZE = 100;
const OVERLAP_MS = 5 * 60 * 1000;          // re-read a little before last sync (clock skew)
const CDC_WINDOW_MS = 29 * 24 * 3600 * 1000; // QuickBooks change data capture covers 30 days

function isVoided(inv) {
  return /voided/i.test(inv.PrivateNote || '') && Number(inv.TotalAmt) === 0;
}

function firstSyncDate() {
  const configured = process.env.QBO_SYNC_START_DATE;
  if (configured && /^\d{4}-\d{2}-\d{2}$/.test(configured)) return configured;
  return new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

async function pagedQuery(qbo, where) {
  const invoices = [];
  for (let start = 1; ; start += PAGE_SIZE) {
    const page = (await qbo.query(`SELECT * FROM Invoice WHERE ${where} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`)).Invoice || [];
    invoices.push(...page);
    if (page.length < PAGE_SIZE) return invoices;
  }
}

/** Remove a QuickBooks invoice that was deleted or voided there; stock returns to its batches. */
async function removeInvoice(client, qboInvoiceId, reason, userId) {
  const { rows } = await client.query('SELECT * FROM shipments WHERE qbo_invoice_id = $1 FOR UPDATE', [qboInvoiceId]);
  if (!rows.length) return false;
  const batches = await client.query(
    `SELECT DISTINCT a.batch_id FROM shipment_allocations a JOIN shipment_lines l ON l.id = a.line_id
      WHERE l.shipment_id = $1`, [rows[0].id]
  );
  const batchIds = batches.rows.map(r => r.batch_id);
  await lockBatches(client, batchIds);
  await client.query('DELETE FROM shipments WHERE id = $1', [rows[0].id]);
  await refreshShipStatus(client, batchIds);
  await client.query(
    "INSERT INTO qbo_sync_log (direction, invoice_number, status, message) VALUES ('pull',$1,'REMOVED',$2)",
    [rows[0].invoice_number, reason]
  );
  await logAudit(client, userId, 'QBO_REMOVE', 'shipment', rows[0].id, rows[0], { reason }, null);
  return true;
}

/** Store one invoice; returns per-line counts. */
async function storeInvoice(client, inv, userId) {
  const counts = { created: 0, skipped: 0, unmapped: 0, partial: 0, changed: [] , rounded: [] };
  const invoiceNumber = inv.DocNumber || `QBO-${inv.Id}`;
  const { rows: [shipment] } = await client.query(
    `INSERT INTO shipments (invoice_number, customer_name, shipped_at, source, qbo_invoice_id, qbo_customer_id, qbo_sync_status)
     VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),'QuickBooks API',$4,$5,'SYNCED')
     ON CONFLICT (qbo_invoice_id) WHERE qbo_invoice_id IS NOT NULL DO UPDATE
       SET invoice_number = EXCLUDED.invoice_number, customer_name = EXCLUDED.customer_name,
           shipped_at = EXCLUDED.shipped_at, qbo_customer_id = EXCLUDED.qbo_customer_id,
           qbo_sync_status = 'SYNCED', last_error = NULL
     RETURNING id`,
    [invoiceNumber, inv.CustomerRef?.name || 'Unknown customer', inv.ShipDate || inv.TxnDate || null,
     String(inv.Id), inv.CustomerRef?.value || null]
  );

  for (const line of inv.Line || []) {
    if (line.DetailType !== 'SalesItemLineDetail') continue;
    const detail = line.SalesItemLineDetail || {};
    const rawQty = Number(detail.Qty) || 0;
    if (rawQty <= 0) continue;
    const quantity = Math.round(rawQty);
    if (quantity !== rawQty) counts.rounded.push(`${invoiceNumber}: ${rawQty} rounded to ${quantity}`);
    if (quantity <= 0) continue;
    const lineId = String(line.Id || line.LineNum);

    const existing = await client.query(
      'SELECT id, quantity FROM shipment_lines WHERE shipment_id = $1 AND qbo_line_id = $2', [shipment.id, lineId]
    );
    if (existing.rows.length) {
      counts.skipped++;
      if (existing.rows[0].quantity !== quantity) {
        counts.changed.push(`${invoiceNumber} line ${lineId}: quantity changed in QuickBooks from ${existing.rows[0].quantity} to ${quantity}; review it`);
      }
      continue;
    }

    const itemId = detail.ItemRef?.value ? String(detail.ItemRef.value) : null;
    const description = detail.ItemRef?.name || line.Description || 'QuickBooks item';
    const map = itemId
      ? (await client.query('SELECT recipe_id, format, unit_type FROM qbo_item_map WHERE qbo_item_id = $1', [itemId])).rows[0]
      : null;

    const { rows: [saved] } = await client.query(
      `INSERT INTO shipment_lines (shipment_id, recipe_id, format, unit_type, quantity, unit_price,
                                   qbo_line_id, qbo_item_id, product_description, allocation_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unallocated') RETURNING id`,
      [shipment.id, map?.recipe_id || null, map?.format || null, map?.unit_type || null, quantity,
       detail.UnitPrice != null ? Number(detail.UnitPrice) : null, lineId, itemId, description]
    );
    counts.created++;
    if (!map) { counts.unmapped++; continue; }
    const result = await allocateLine(client, saved.id, { userId, strict: false, method: 'fifo' });
    if (result.status !== 'allocated') counts.partial++;
  }
  return counts;
}

async function syncInvoices(db, qbo, { userId = null } = {}) {
  const startedAt = new Date();
  const { rows: [conn] } = await db.query('SELECT realm_id, last_sync_at FROM qbo_auth_tokens ORDER BY updated_at DESC LIMIT 1');
  if (!conn) {
    const err = new Error('QuickBooks is not connected');
    err.status = 409;
    throw err;
  }

  // Fetch what changed.
  let invoices;
  let mode;
  const last = conn.last_sync_at ? new Date(conn.last_sync_at) : null;
  if (!last) {
    mode = `first sync from ${firstSyncDate()}`;
    invoices = await pagedQuery(qbo, `TxnDate >= '${firstSyncDate()}'`);
  } else {
    const since = new Date(last.getTime() - OVERLAP_MS);
    if (startedAt - since < CDC_WINDOW_MS) {
      mode = 'changes since last sync';
      invoices = await qbo.changedInvoices(since.toISOString());
    } else {
      mode = 'changes since last sync (older than 30 days; deletions not detected)';
      invoices = await pagedQuery(qbo, `MetaData.LastUpdatedTime >= '${since.toISOString()}'`);
    }
  }

  const summary = {
    mode, invoices: invoices.length, created: 0, skipped: 0, unmapped: 0, partial: 0, removed: 0,
    errors: [], notes: []
  };

  for (const inv of invoices) {
    const label = inv.DocNumber || `QBO-${inv.Id}`;
    try {
      await withTransaction(async (client) => {
        if (inv.status === 'Deleted') {
          if (await removeInvoice(client, String(inv.Id), 'Deleted in QuickBooks', userId)) summary.removed++;
          return;
        }
        if (isVoided(inv)) {
          if (await removeInvoice(client, String(inv.Id), 'Voided in QuickBooks', userId)) summary.removed++;
          return;
        }
        const c = await storeInvoice(client, inv, userId);
        summary.created += c.created;
        summary.skipped += c.skipped;
        summary.unmapped += c.unmapped;
        summary.partial += c.partial;
        summary.notes.push(...c.changed, ...c.rounded);
      });
    } catch (e) {
      summary.errors.push({ invoice: label, error: e.message });
      await db.query(
        "INSERT INTO qbo_sync_log (direction, invoice_number, status, message) VALUES ('pull',$1,'FAILED',$2)",
        [label, e.message]
      ).catch(() => {});
    }
  }

  // Failed invoices are retried next time: only advance the clock when nothing failed.
  if (summary.errors.length === 0) {
    await db.query('UPDATE qbo_auth_tokens SET last_sync_at = $1 WHERE realm_id = $2', [startedAt, conn.realm_id]);
  }
  summary.finished_at = new Date().toISOString();
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ('qbo_last_sync_summary', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(summary)]
  );
  await db.query(
    "INSERT INTO qbo_sync_log (direction, status, message) VALUES ('pull',$1,$2)",
    [summary.errors.length ? 'PARTIAL' : 'OK', JSON.stringify({ ...summary, notes: summary.notes.length })]
  );
  return summary;
}

/** After new item mappings: map open lines with that item and allocate them. */
async function applyMappings(db, userId) {
  const { rows } = await db.query(
    `SELECT l.id FROM shipment_lines l JOIN qbo_item_map m ON m.qbo_item_id = l.qbo_item_id
      WHERE l.allocation_status <> 'allocated' ORDER BY l.created_at`
  );
  const result = { lines: rows.length, allocated: 0, still_open: 0 };
  for (const { id } of rows) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE shipment_lines l SET recipe_id = m.recipe_id, format = m.format, unit_type = m.unit_type
           FROM qbo_item_map m
          WHERE l.id = $1 AND m.qbo_item_id = l.qbo_item_id AND l.recipe_id IS NULL`, [id]
      );
      const r = await allocateLine(client, id, { userId, strict: false });
      if (r.status === 'allocated') result.allocated++; else result.still_open++;
    });
  }
  return result;
}

module.exports = { syncInvoices, applyMappings, isVoided };
