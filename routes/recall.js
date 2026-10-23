const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

/**
 * FSMA mock recall dossier. Upstream = ingredient and packaging lots a batch
 * used; downstream = customers who received it (from shipment_allocations).
 */
const router = express.Router();
router.use(authenticate, requireMenuAccess('recall'));

/** Lots consumed by the given batches, with supplier and dates. */
async function upstreamLots(db, batchIds) {
  const { rows } = await db.query(
    `SELECT a.batch_id, b.batch_number, a.stage, l.id AS lot_id, l.lot_number, i.name AS item_name,
            i.category, i.unit_type, a.quantity, s.name AS supplier_name, l.po_number,
            l.received_at, l.expiry_date
       FROM batch_lot_allocations a
       JOIN production_batches b ON b.id = a.batch_id
       JOIN warehouse_lots l ON l.id = a.lot_id
       JOIN master_items i ON i.id = a.item_id
       LEFT JOIN suppliers s ON s.id = l.supplier_id
      WHERE a.batch_id = ANY($1::uuid[])
      ORDER BY b.batch_number, a.stage, i.name, l.lot_number`, [batchIds]
  );
  return rows;
}

/** Customers who received product from the given batches. */
async function downstreamShipments(db, batchIds) {
  const { rows } = await db.query(
    `SELECT b.batch_number, s.shipped_at, s.customer_name, s.invoice_number, s.source, s.qbo_invoice_id,
            l.product_description, l.format, a.boxes, a.bags
       FROM shipment_allocations a
       JOIN production_batches b ON b.id = a.batch_id
       JOIN shipment_lines l ON l.id = a.line_id
       JOIN shipments s ON s.id = l.shipment_id
      WHERE a.batch_id = ANY($1::uuid[])
      ORDER BY s.shipped_at, s.customer_name, b.batch_number`, [batchIds]
  );
  return rows;
}

/** Finished stock still in the warehouse for the given batches. */
async function onHand(db, batchIds) {
  const { rows } = await db.query(
    `SELECT batch_number, format, status, boxes_on_hand, bags_on_hand
       FROM batch_finished_stock
      WHERE batch_id = ANY($1::uuid[]) AND (boxes_on_hand > 0 OR bags_on_hand > 0)
      ORDER BY batch_number, format DESC`, [batchIds]
  );
  return rows;
}

async function batchesById(db, batchIds) {
  const { rows } = await db.query(
    `SELECT b.id, b.batch_number, r.name AS recipe_name, b.production_date, b.status,
            b.bins_count, b.scale_basis, p.bags_575g, p.boxes_575g, p.bags_312g, p.boxes_312g
       FROM production_batches b
       JOIN recipes r ON r.id = b.recipe_id
       LEFT JOIN batch_packaging p ON p.batch_id = b.id
      WHERE b.id = ANY($1::uuid[])
      ORDER BY b.production_date, b.batch_number`, [batchIds]
  );
  return rows;
}

function summarise(shipments) {
  return {
    customers: [...new Set(shipments.map(s => s.customer_name))].sort(),
    invoices: new Set(shipments.map(s => s.invoice_number)).size,
    boxes_shipped: shipments.reduce((a, s) => a + Number(s.boxes), 0),
    bags_shipped: shipments.reduce((a, s) => a + Number(s.bags), 0)
  };
}

// GET /api/recall/search?q= — lot and batch numbers for the search box.
router.get('/search', async (req, res, next) => {
  try {
    const q = `%${String(req.query.q || '').trim()}%`;
    const batches = await req.db.query(
      'SELECT batch_number FROM production_batches WHERE batch_number ILIKE $1 ORDER BY batch_number LIMIT 20', [q]
    );
    const lots = await req.db.query(
      `SELECT DISTINCT l.lot_number FROM warehouse_lots l WHERE l.lot_number ILIKE $1 ORDER BY l.lot_number LIMIT 20`, [q]
    );
    res.json({ batches: batches.rows.map(r => r.batch_number), lots: lots.rows.map(r => r.lot_number) });
  } catch (e) { next(e); }
});

// GET /api/recall/batch/:batchNumber
router.get('/batch/:batchNumber', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      'SELECT id FROM production_batches WHERE batch_number = $1', [req.params.batchNumber]
    );
    if (!rows.length) return res.status(404).json({ error: `No batch numbered ${req.params.batchNumber}` });
    const ids = [rows[0].id];
    const [batch] = await batchesById(req.db, ids);
    const shipments = await downstreamShipments(req.db, ids);
    const dossier = {
      mode: 'batch',
      query: req.params.batchNumber,
      generated_at: new Date().toISOString(),
      batch,
      upstream_lots: await upstreamLots(req.db, ids),
      shipments,
      on_hand: await onHand(req.db, ids),
      summary: summarise(shipments)
    };
    await logAudit(req.db, req.user.id, 'RECALL_RUN', 'production_batch', batch.id, null, { mode: 'batch', query: req.params.batchNumber }, req.ip);
    res.json(dossier);
  } catch (e) { next(e); }
});

// GET /api/recall/lot/:lotNumber — every batch that used the lot, and their customers.
router.get('/lot/:lotNumber', async (req, res, next) => {
  try {
    const lots = await req.db.query(
      `SELECT l.id, l.lot_number, i.name AS item_name, i.category, i.unit_type, s.name AS supplier_name,
              l.po_number, l.dock_temp, l.received_at, l.expiry_date, l.total_quantity, l.remaining_quantity
         FROM warehouse_lots l
         JOIN master_items i ON i.id = l.item_id
         LEFT JOIN suppliers s ON s.id = l.supplier_id
        WHERE l.lot_number = $1
        ORDER BY i.name`, [req.params.lotNumber]
    );
    if (!lots.rows.length) return res.status(404).json({ error: `No lot numbered ${req.params.lotNumber}` });

    const used = await req.db.query(
      `SELECT a.batch_id, a.lot_id, a.stage, SUM(a.quantity) AS quantity
         FROM batch_lot_allocations a
        WHERE a.lot_id = ANY($1::uuid[])
        GROUP BY a.batch_id, a.lot_id, a.stage`, [lots.rows.map(l => l.id)]
    );
    const batchIds = [...new Set(used.rows.map(u => u.batch_id))];
    const batches = (await batchesById(req.db, batchIds)).map(b => ({
      ...b,
      lot_usage: used.rows.filter(u => u.batch_id === b.id)
        .map(u => ({ lot_id: u.lot_id, stage: u.stage, quantity: Number(u.quantity) }))
    }));
    const shipments = batchIds.length ? await downstreamShipments(req.db, batchIds) : [];
    const dossier = {
      mode: 'lot',
      query: req.params.lotNumber,
      generated_at: new Date().toISOString(),
      lots: lots.rows,
      batches,
      shipments,
      on_hand: batchIds.length ? await onHand(req.db, batchIds) : [],
      summary: summarise(shipments)
    };
    await logAudit(req.db, req.user.id, 'RECALL_RUN', 'warehouse_lot', lots.rows[0].id, null, { mode: 'lot', query: req.params.lotNumber }, req.ip);
    res.json(dossier);
  } catch (e) { next(e); }
});

module.exports = router;
