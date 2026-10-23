const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess, requireEdit } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { withTransaction } = require('../db');
const {
  lockBatches, refreshShipStatus, allocateLine, releaseLine
} = require('../utils/finishedStock');
const { requireAdmin } = require('../middleware/auth');
const { httpError } = require('../utils/stock');

const router = express.Router();
router.use(authenticate, requireMenuAccess('shipping', 'reports', 'recall'));

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const shipmentSchema = z.object({
  customer_name: z.string().trim().min(1).max(255),
  invoice_number: z.string().trim().min(1).max(100),
  shipped_at: date.optional(),
  lines: z.array(z.object({
    recipe_id: z.string().uuid(),
    format: z.enum(['575g', '312g']),
    unit_type: z.enum(['box', 'bag']),
    quantity: z.number().int().positive(),
    // Optional: ship from this batch only; otherwise oldest released batch first.
    batch_id: z.string().uuid().nullable().optional()
  })).min(1)
});

function handleError(e, res, next) {
  if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
  if (e.status) return res.status(e.status).json({ error: e.message });
  return next(e);
}

/** Shipments with their lines and the batches each line came from. */
async function listShipments(db, { id = null, from = null, to = null } = {}) {
  const { rows: shipments } = await db.query(
    `SELECT * FROM shipments
      WHERE ($1::uuid IS NULL OR id = $1)
        AND ($2::date IS NULL OR shipped_at >= $2) AND ($3::date IS NULL OR shipped_at <= $3)
      ORDER BY shipped_at DESC, created_at DESC`, [id, from, to]
  );
  if (!shipments.length) return [];
  const ids = shipments.map(s => s.id);
  const { rows: lines } = await db.query(
    `SELECT l.*, r.name AS recipe_name
       FROM shipment_lines l LEFT JOIN recipes r ON r.id = l.recipe_id
      WHERE l.shipment_id = ANY($1::uuid[])
      ORDER BY l.created_at`, [ids]
  );
  const { rows: allocs } = await db.query(
    `SELECT a.line_id, a.batch_id, b.batch_number, a.boxes, a.bags, a.method
       FROM shipment_allocations a JOIN production_batches b ON b.id = a.batch_id
      WHERE a.line_id = ANY($1::uuid[])
      ORDER BY b.batch_number`, [lines.map(l => l.id)]
  );
  for (const l of lines) l.allocations = allocs.filter(a => a.line_id === l.id);
  for (const s of shipments) s.lines = lines.filter(l => l.shipment_id === s.id);
  return shipments;
}

router.get('/', async (req, res, next) => {
  try {
    const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
    res.json(await listShipments(req.db, { from: q.from || null, to: q.to || null }));
  } catch (e) { handleError(e, res, next); }
});

// POST /api/shipments — manual dispatch. Each line is allocated to released
// batches in one transaction; nothing is saved if any line lacks stock.
router.post('/', requireEdit('shipping'), async (req, res, next) => {
  try {
    const d = shipmentSchema.parse(req.body);
    const shipment = await withTransaction(async (client) => {
      const recipes = await client.query('SELECT id, name FROM recipes WHERE id = ANY($1::uuid[])', [d.lines.map(l => l.recipe_id)]);
      const recipeName = Object.fromEntries(recipes.rows.map(r => [r.id, r.name]));

      const header = await client.query(
        `INSERT INTO shipments (invoice_number, customer_name, shipped_at, source, qbo_sync_status)
         VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),'Manual','NOT_REQUIRED') RETURNING id`,
        [d.invoice_number, d.customer_name, d.shipped_at || null]
      );
      const shipmentId = header.rows[0].id;

      for (const line of d.lines) {
        if (!recipeName[line.recipe_id]) throw httpError(400, 'Recipe not found');
        const { rows } = await client.query(
          `INSERT INTO shipment_lines (shipment_id, recipe_id, format, unit_type, quantity, product_description)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [shipmentId, line.recipe_id, line.format, line.unit_type, line.quantity, `${recipeName[line.recipe_id]} ${line.format}`]
        );
        await allocateLine(client, rows[0].id, {
          batchId: line.batch_id || null, userId: req.user.id, strict: true, method: line.batch_id ? 'manual' : 'fifo'
        });
      }

      const [saved] = await listShipments(client, { id: shipmentId });
      await logAudit(client, req.user.id, 'CREATE', 'shipment', shipmentId, null, saved, req.ip);
      return saved;
    });
    res.status(201).json(shipment);
  } catch (e) { handleError(e, res, next); }
});

// GET /api/shipments/open-lines — QuickBooks lines not fully allocated (unmapped item or short stock).
router.get('/open-lines', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT l.id, l.shipment_id, s.invoice_number, s.customer_name, s.shipped_at, s.source,
              l.qbo_item_id, l.product_description, l.recipe_id, l.format, l.unit_type, l.quantity, l.allocation_status,
              COALESCE((SELECT SUM(CASE WHEN l.unit_type = 'box' THEN a.boxes ELSE a.bags END)
                          FROM shipment_allocations a WHERE a.line_id = l.id), 0)::int AS allocated
         FROM shipment_lines l JOIN shipments s ON s.id = l.shipment_id
        WHERE l.allocation_status <> 'allocated'
        ORDER BY s.shipped_at, s.invoice_number`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/shipments/lines/:id/allocate { batch_id? } — admin override: allocate what is
// still open on a line, oldest batch first or from one chosen batch.
router.post('/lines/:id/allocate', requireAdmin, async (req, res, next) => {
  try {
    const { batch_id: batchId } = z.object({ batch_id: z.string().uuid().nullable().optional() }).parse(req.body || {});
    const result = await withTransaction(async (client) => {
      const r = await allocateLine(client, req.params.id, { batchId: batchId || null, userId: req.user.id, method: 'manual' });
      await logAudit(client, req.user.id, 'ALLOCATE', 'shipment_line', req.params.id, null, { batch_id: batchId || null, ...r }, req.ip);
      return r;
    });
    res.json(result);
  } catch (e) { handleError(e, res, next); }
});

// POST /api/shipments/lines/:id/release — admin override: undo a line's allocations to re-allocate them.
router.post('/lines/:id/release', requireAdmin, async (req, res, next) => {
  try {
    const removed = await withTransaction(async (client) => {
      const n = await releaseLine(client, req.params.id);
      await logAudit(client, req.user.id, 'RELEASE_ALLOCATION', 'shipment_line', req.params.id, null, { removed: n }, req.ip);
      return n;
    });
    res.json({ removed });
  } catch (e) { handleError(e, res, next); }
});

// DELETE /api/shipments/:id — manual dispatches only; stock returns to the batches.
// Boxes opened automatically for the shipment stay opened (as loose bags).
router.delete('/:id', requireEdit('shipping'), async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const [before] = await listShipments(client, { id: req.params.id });
      if (!before) throw httpError(404, 'Shipment not found');
      if (before.source !== 'Manual') {
        throw httpError(409, 'QuickBooks shipments are removed by voiding the invoice in QuickBooks');
      }
      const batchIds = before.lines.flatMap(l => l.allocations.map(a => a.batch_id));
      await lockBatches(client, batchIds);
      await client.query('DELETE FROM shipments WHERE id = $1', [req.params.id]);
      await refreshShipStatus(client, batchIds);
      await logAudit(client, req.user.id, 'DELETE', 'shipment', req.params.id, before, null, req.ip);
    });
    res.json({ message: 'Shipment deleted; stock returned to its batches' });
  } catch (e) { handleError(e, res, next); }
});

module.exports = router;
