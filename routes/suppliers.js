const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess, requireEdit } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const schema = z.object({
  name: z.string().trim().min(1).max(255),
  contact_info: z.string().max(2000).optional().nullable()
});

router.use(authenticate, requireMenuAccess('ingredients_hub'));

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT s.id, s.name, s.contact_info, s.created_at,
              COUNT(DISTINCT i.id)::int AS item_count
         FROM suppliers s
         LEFT JOIN master_items i ON i.supplier_id = s.id
        GROUP BY s.id ORDER BY s.name`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', requireEdit('ingredients_hub'), async (req, res, next) => {
  try {
    const data = schema.parse(req.body);
    const { rows } = await req.db.query(
      'INSERT INTO suppliers (name, contact_info) VALUES ($1,$2) RETURNING *',
      [data.name, data.contact_info || null]
    );
    await logAudit(req.db, req.user.id, 'CREATE', 'supplier', rows[0].id, null, rows[0], req.ip);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
    next(e);
  }
});

router.put('/:id', requireEdit('ingredients_hub'), async (req, res, next) => {
  try {
    const data = schema.parse(req.body);
    const before = await req.db.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Supplier not found' });
    const { rows } = await req.db.query(
      'UPDATE suppliers SET name = $1, contact_info = $2 WHERE id = $3 RETURNING *',
      [data.name, data.contact_info || null, req.params.id]
    );
    await logAudit(req.db, req.user.id, 'UPDATE', 'supplier', req.params.id, before.rows[0], rows[0], req.ip);
    res.json(rows[0]);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
    next(e);
  }
});

router.delete('/:id', requireEdit('ingredients_hub'), async (req, res, next) => {
  try {
    const before = await req.db.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Supplier not found' });
    await req.db.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
    await logAudit(req.db, req.user.id, 'DELETE', 'supplier', req.params.id, before.rows[0], null, req.ip);
    res.json({ message: 'Supplier deleted' });
  } catch (e) { next(e); }
});

module.exports = router;
