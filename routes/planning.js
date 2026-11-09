const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess, requireEdit } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { calculatePlan } = require('../utils/planning');

const router = express.Router();
router.use(authenticate, requireMenuAccess('production_planning'));

const lineSchema = z.object({
  recipe_id: z.string().uuid(),
  pack_size: z.enum(['575', '312']),
  boxes_ordered: z.coerce.number().int().min(0).max(1000000),
  in_stock_override: z.coerce.number().int().min(0).max(1000000).optional().nullable()
});

const calculateSchema = z.object({
  deduct_inventory: z.boolean().default(true),
  lines: z.array(lineSchema).min(1).max(100)
});

const planSchema = z.object({
  title: z.string().trim().min(1).max(200),
  customer_name: z.string().trim().max(255).optional().nullable(),
  po_number: z.string().trim().max(100).optional().nullable(),
  delivery_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  deduct_inventory: z.boolean().default(true),
  order_lines: z.array(lineSchema).min(1).max(100),
  status: z.enum(['Draft', 'Finalized']).default('Draft')
});

const PLAN_COLUMNS = `p.id, p.title, p.customer_name, p.po_number, p.delivery_date, p.deduct_inventory,
  p.order_lines, p.status, p.created_at, p.updated_at, u.full_name AS updated_by_name`;

function handleError(e, res, next) {
  if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
  if (e.status) return res.status(e.status).json({ error: e.message });
  return next(e);
}

async function loadPlan(db, id) {
  const { rows } = await db.query(
    `SELECT ${PLAN_COLUMNS} FROM production_plans p LEFT JOIN users u ON u.id = p.updated_by WHERE p.id = $1`, [id]
  );
  return rows[0] || null;
}

// POST /api/planning/calculate — what-if schedule; writes nothing.
router.post('/calculate', async (req, res, next) => {
  try {
    const d = calculateSchema.parse(req.body);
    res.json(await calculatePlan(req.db, d));
  } catch (e) { handleError(e, res, next); }
});

router.get('/plans', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT ${PLAN_COLUMNS} FROM production_plans p LEFT JOIN users u ON u.id = p.updated_by
        ORDER BY p.updated_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/plans', requireEdit('production_planning'), async (req, res, next) => {
  try {
    const d = planSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO production_plans
         (title, customer_name, po_number, delivery_date, deduct_inventory, order_lines, status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8) RETURNING id`,
      [d.title, d.customer_name || null, d.po_number || null, d.delivery_date || null, d.deduct_inventory,
       JSON.stringify(d.order_lines), d.status, req.user.id]
    );
    const saved = await loadPlan(req.db, rows[0].id);
    await logAudit(req.db, req.user.id, 'CREATE', 'production_plan', saved.id, null, saved, req.ip);
    res.status(201).json(saved);
  } catch (e) { handleError(e, res, next); }
});

// A finalized plan is locked: the only change allowed is putting it back to Draft.
router.put('/plans/:id', requireEdit('production_planning'), async (req, res, next) => {
  try {
    const d = planSchema.parse(req.body);
    const before = await loadPlan(req.db, req.params.id);
    if (!before) return res.status(404).json({ error: 'Plan not found' });
    if (before.status === 'Finalized' && d.status === 'Finalized') {
      return res.status(409).json({ error: 'This plan is finalized. Unfinalize it before editing.' });
    }
    const lines = before.status === 'Finalized' ? before.order_lines : d.order_lines;
    const fields = before.status === 'Finalized'
      ? [before.title, before.customer_name, before.po_number, before.delivery_date, before.deduct_inventory]
      : [d.title, d.customer_name || null, d.po_number || null, d.delivery_date || null, d.deduct_inventory];
    await req.db.query(
      `UPDATE production_plans
          SET title = $1, customer_name = $2, po_number = $3, delivery_date = $4, deduct_inventory = $5,
              order_lines = $6::jsonb, status = $7, updated_by = $8, updated_at = NOW()
        WHERE id = $9`,
      [...fields, JSON.stringify(lines), d.status, req.user.id, req.params.id]
    );
    const saved = await loadPlan(req.db, req.params.id);
    await logAudit(req.db, req.user.id, 'UPDATE', 'production_plan', saved.id, before, saved, req.ip);
    res.json(saved);
  } catch (e) { handleError(e, res, next); }
});

router.delete('/plans/:id', requireEdit('production_planning'), async (req, res, next) => {
  try {
    const before = await loadPlan(req.db, req.params.id);
    if (!before) return res.status(404).json({ error: 'Plan not found' });
    await req.db.query('DELETE FROM production_plans WHERE id = $1', [req.params.id]);
    await logAudit(req.db, req.user.id, 'DELETE', 'production_plan', req.params.id, before, null, req.ip);
    res.json({ message: 'Plan deleted' });
  } catch (e) { next(e); }
});

module.exports = router;
