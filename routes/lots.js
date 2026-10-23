const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess, requireEdit } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { withTransaction } = require('../db');

const router = express.Router();
router.use(authenticate, requireMenuAccess('receiving', 'ingredients_hub'));

const receiveSchema = z.object({
  supplier_id: z.string().uuid(),
  po_number: z.string().max(100).optional().nullable(),
  dock_temp: z.string().max(30).optional().nullable(),
  received_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  items: z.array(z.object({
    item_id: z.string().uuid(),
    lot_number: z.string().trim().min(1).max(100),
    packs_received: z.number().positive(),
    expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable()
  })).min(1)
});

const editSchema = z.object({
  lot_number: z.string().trim().min(1).max(100).optional(),
  po_number: z.string().max(100).nullable().optional(),
  dock_temp: z.string().max(30).nullable().optional(),
  expiry_date: z.string().nullable().optional(),
  received_at: z.string().optional(),
  remaining_quantity: z.number().min(0).optional()
});

router.get('/', async (req, res, next) => {
  try {
    const activeOnly = req.query.active_only === 'true';
    const params = [];
    let where = '';
    if (activeOnly) where = 'WHERE l.remaining_quantity > 0';
    if (req.query.item_id) { params.push(req.query.item_id); where += `${where ? ' AND' : 'WHERE'} l.item_id = $${params.length}`; }
    const { rows } = await req.db.query(
      `SELECT l.*, i.name AS item_name, i.category, i.unit_type,
              i.unit_pack_size, i.cost_per_pack, i.package_role,
              s.name AS supplier_name
         FROM warehouse_lots l
         JOIN master_items i ON i.id = l.item_id
         LEFT JOIN suppliers s ON s.id = l.supplier_id
         ${where}
        ORDER BY l.received_at DESC, l.created_at DESC`, params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// FIFO suggestion for a required quantity in the item's unit
router.get('/fifo', async (req, res, next) => {
  try {
    const { item_id, quantity } = z.object({
      item_id: z.string().uuid(),
      quantity: z.coerce.number().positive()
    }).parse(req.query);

    const { rows } = await req.db.query(
      `SELECT id, lot_number, remaining_quantity, expiry_date, received_at
         FROM warehouse_lots
        WHERE item_id = $1 AND remaining_quantity > 0
        ORDER BY received_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED`, [item_id]
    );

    let need = quantity;
    const allocations = [];
    for (const lot of rows) {
      if (need <= 0) break;
      const take = Math.min(Number(lot.remaining_quantity), need);
      if (take > 0) {
        allocations.push({ lot_id: lot.id, lot_number: lot.lot_number, quantity: Number(take.toFixed(4)) });
        need -= take;
      }
    }
    res.json({ allocations, shortfall: Number(Math.max(0, need).toFixed(4)) });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
    next(e);
  }
});

// POST /api/lots/receive — all rows validated; nothing silently skipped.
router.post('/receive', requireEdit('receiving'), async (req, res, next) => {
  try {
    const data = receiveSchema.parse(req.body);

    const result = await withTransaction(async (client) => {
      const created = [];
      const seen = new Set();

      for (const line of data.items) {
        if (seen.has(line.lot_number)) {
          const err = new Error(`Duplicate lot number in this receipt: ${line.lot_number}`);
          err.status = 400; throw err;
        }
        seen.add(line.lot_number);

        const item = await client.query(
          'SELECT id, name, unit_type, unit_pack_size FROM master_items WHERE id = $1', [line.item_id]
        );
        if (item.rows.length === 0) {
          const err = new Error(`Item not found for lot ${line.lot_number}`);
          err.status = 400; throw err;
        }
        const i = item.rows[0];
        const total = Number((line.packs_received * Number(i.unit_pack_size)).toFixed(4));

        const ins = await client.query(
          `INSERT INTO warehouse_lots
             (lot_number, item_id, supplier_id, po_number, dock_temp, packs_received,
              total_quantity, remaining_quantity, expiry_date, received_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,COALESCE($9, CURRENT_DATE))
           RETURNING *`,
          [line.lot_number, line.item_id, data.supplier_id, data.po_number || null, data.dock_temp || null,
           line.packs_received, total, line.expiry_date || null, data.received_at || null]
        );
        await logAudit(client, req.user.id, 'CREATE', 'warehouse_lot', ins.rows[0].id, null, ins.rows[0], req.ip);
        created.push({ ...ins.rows[0], item_name: i.name, unit_type: i.unit_type });
      }
      return created;
    });

    res.status(201).json({ message: `Received ${result.length} lot(s)`, lots: result });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === '23505') return res.status(409).json({ error: 'A lot with that lot number already exists for this item' });
    next(e);
  }
});

router.put('/:id', requireEdit('receiving'), async (req, res, next) => {
  try {
    const d = editSchema.parse(req.body);
    const before = await req.db.query('SELECT * FROM warehouse_lots WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Lot not found' });

    const current = before.rows[0];
    if (d.remaining_quantity !== undefined && d.remaining_quantity > Number(current.total_quantity)) {
      return res.status(400).json({ error: 'Remaining quantity cannot exceed the received quantity' });
    }

    const map = {
      lot_number: 'lot_number', po_number: 'po_number', dock_temp: 'dock_temp',
      expiry_date: 'expiry_date', received_at: 'received_at', remaining_quantity: 'remaining_quantity'
    };
    const sets = []; const values = [];
    for (const [k, col] of Object.entries(map)) {
      if (d[k] !== undefined) { values.push(d[k] === '' ? null : d[k]); sets.push(`${col} = $${values.length}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id);
    const { rows } = await req.db.query(
      `UPDATE warehouse_lots SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values
    );
    await logAudit(req.db, req.user.id, 'UPDATE', 'warehouse_lot', req.params.id, current, rows[0], req.ip);
    res.json(rows[0]);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
    if (e.code === '23505') return res.status(409).json({ error: 'A lot with that lot number already exists for this item' });
    next(e);
  }
});

router.delete('/:id', requireEdit('receiving'), async (req, res, next) => {
  try {
    const before = await req.db.query('SELECT * FROM warehouse_lots WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Lot not found' });

    const used = await req.db.query(
      'SELECT COUNT(*)::int AS n FROM batch_lot_allocations WHERE lot_id = $1', [req.params.id]
    );
    if (used.rows[0].n > 0) {
      return res.status(409).json({ error: 'This lot has been consumed by a production batch and cannot be deleted (traceability)' });
    }
    await req.db.query('DELETE FROM warehouse_lots WHERE id = $1', [req.params.id]);
    await logAudit(req.db, req.user.id, 'DELETE', 'warehouse_lot', req.params.id, before.rows[0], null, req.ip);
    res.json({ message: 'Lot deleted' });
  } catch (e) { next(e); }
});

module.exports = router;
