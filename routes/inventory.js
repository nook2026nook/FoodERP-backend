const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess, ROLE_CAN_EDIT } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { withTransaction } = require('../db');
const { valueReadyToShip, packagingRowCost, ROUND } = require('../utils/costing');
const { costPerUnit } = require('../utils/recipeData');
const { lockBatches, recordBoxOpening, SHIPPABLE } = require('../utils/finishedStock');
const { httpError } = require('../utils/stock');

const router = express.Router();
router.use(authenticate, requireMenuAccess('ready_to_ship', 'shipping', 'dashboard'));

function handleError(e, res, next) {
  if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
  if (e.status) return res.status(e.status).json({ error: e.message });
  return next(e);
}

/** Outer-box material cost per recipe and format (BOM rows assigned to boxes). */
async function outerBoxCosts(db) {
  const { rows } = await db.query(
    `SELECT b.recipe_id, b.assignment, b.amount, b.measure, i.unit_pack_size, i.cost_per_pack
       FROM recipe_packaging_bom b JOIN master_items i ON i.id = b.packaging_id
      WHERE b.assignment IN ('box575','box312')`
  );
  const costs = {};
  for (const r of rows) {
    const key = `${r.recipe_id}:${r.assignment === 'box575' ? '575g' : '312g'}`;
    costs[key] = (costs[key] || 0) + packagingRowCost({ ...r, cost_per_unit: costPerUnit(r) });
  }
  return costs;
}

// GET /api/inventory/ready-to-ship — one row per recipe with both formats and the
// HTML's valuation: box = (bag cost x 12) + outer box cost; loose bags at bag cost.
router.get('/ready-to-ship', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT v.*, r.cost_per_575g, r.cost_per_312g
         FROM ready_to_ship_inventory v JOIN recipes r ON r.id = v.recipe_id
        ORDER BY v.recipe_name, v.format DESC`
    );
    const boxCosts = await outerBoxCosts(req.db);

    const byRecipe = new Map();
    for (const r of rows) {
      const entry = byRecipe.get(r.recipe_id) || { recipe_id: r.recipe_id, recipe_name: r.recipe_name, formats: {}, total_value: 0 };
      const bagCost = Number(r.format === '575g' ? r.cost_per_575g : r.cost_per_312g);
      const boxCost = boxCosts[`${r.recipe_id}:${r.format}`] || 0;
      const value = valueReadyToShip({ boxes: r.boxes, bags: r.bags, bagCost, boxCost });
      entry.formats[r.format] = {
        boxes: r.boxes, bags: r.bags, total_bags: r.total_bags,
        awaiting_qa_boxes: r.awaiting_qa_boxes, awaiting_qa_bags: r.awaiting_qa_bags,
        bag_cost: ROUND(bagCost), outer_box_cost: ROUND(boxCost),
        box_cost: ROUND(bagCost * 12 + boxCost),
        box_value: value.boxValue, bag_value: value.bagValue
      };
      entry.total_value = ROUND(entry.total_value + value.total);
      byRecipe.set(r.recipe_id, entry);
    }
    const products = [...byRecipe.values()];
    res.json({ products, total_value: ROUND(products.reduce((a, p) => a + p.total_value, 0)) });
  } catch (e) { next(e); }
});

// GET /api/inventory/batches?recipe_id&format — per-batch finished stock (released and awaiting QA).
router.get('/batches', async (req, res, next) => {
  try {
    const q = z.object({
      recipe_id: z.string().uuid().optional(),
      format: z.enum(['575g', '312g']).optional()
    }).parse(req.query);
    const { rows } = await req.db.query(
      `SELECT s.*, r.name AS recipe_name, s.status = ANY($3::text[]) AS shippable
         FROM batch_finished_stock s JOIN recipes r ON r.id = s.recipe_id
        WHERE ($1::uuid IS NULL OR s.recipe_id = $1) AND ($2::text IS NULL OR s.format = $2)
          AND (s.boxes_on_hand > 0 OR s.bags_on_hand > 0)
        ORDER BY r.name, s.format DESC, s.production_date, s.batch_number`,
      [q.recipe_id || null, q.format || null, SHIPPABLE]
    );
    res.json(rows);
  } catch (e) { handleError(e, res, next); }
});

// POST /api/inventory/open-box — turn full boxes of one batch into loose bags.
router.post('/open-box', async (req, res, next) => {
  try {
    const d = z.object({
      batch_id: z.string().uuid(),
      format: z.enum(['575g', '312g']),
      boxes: z.number().int().positive()
    }).parse(req.body);
    const role = req.user.role;
    if (![...(ROLE_CAN_EDIT.shipping || []), ...(ROLE_CAN_EDIT.production || [])].includes(role)) {
      return res.status(403).json({ error: 'Your role cannot open boxes' });
    }

    const result = await withTransaction(async (client) => {
      await lockBatches(client, [d.batch_id]);
      const { rows } = await client.query(
        'SELECT * FROM batch_finished_stock WHERE batch_id = $1 AND format = $2', [d.batch_id, d.format]
      );
      const s = rows[0];
      if (!s) throw httpError(404, 'No packed stock for that batch and format');
      if (Number(s.boxes_on_hand) < d.boxes) {
        throw httpError(409, `Batch ${s.batch_number} has ${s.boxes_on_hand} full ${d.format} boxes; ${d.boxes} requested`);
      }
      await recordBoxOpening(client, {
        batchId: d.batch_id, recipeId: s.recipe_id, format: d.format, boxes: d.boxes, reason: 'open_box', userId: req.user.id
      });
      await logAudit(client, req.user.id, 'OPEN_BOX', 'production_batch', d.batch_id, null, d, req.ip);
      const after = await client.query(
        'SELECT * FROM batch_finished_stock WHERE batch_id = $1 AND format = $2', [d.batch_id, d.format]
      );
      return after.rows[0];
    });
    res.json(result);
  } catch (e) { handleError(e, res, next); }
});

module.exports = router;
