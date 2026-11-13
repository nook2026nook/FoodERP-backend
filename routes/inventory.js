const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess, requireAdmin, ROLE_CAN_EDIT } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { withTransaction } = require('../db');
const { valueReadyToShip, packagingRowCost, ROUND } = require('../utils/costing');
const { costPerUnit } = require('../utils/recipeData');
const { lockBatches, recordBoxOpening, refreshShipStatus, SHIPPABLE } = require('../utils/finishedStock');
const { httpError } = require('../utils/stock');

const router = express.Router();
router.use(authenticate, requireMenuAccess('ready_to_ship', 'shipping', 'dashboard'));

function handleError(e, res, next) {
  if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
  if (e.status) return res.status(e.status).json({ error: e.message });
  return next(e);
}

/**
 * Packaging material cost per recipe and format, from the BOM rows assigned to
 * bags (per bag) and boxes (per box). The recipe's own cost is material & dough only.
 */
async function packagingCosts(db) {
  const { rows } = await db.query(
    `SELECT b.recipe_id, b.assignment, b.amount, b.measure, i.unit_pack_size, i.cost_per_pack
       FROM recipe_packaging_bom b JOIN master_items i ON i.id = b.packaging_id
      WHERE b.assignment IN ('bag575','bag312','box575','box312')`
  );
  const bag = {};
  const box = {};
  for (const r of rows) {
    const format = r.assignment.endsWith('575') ? '575g' : '312g';
    const key = `${r.recipe_id}:${format}`;
    const target = r.assignment.startsWith('bag') ? bag : box;
    target[key] = (target[key] || 0) + packagingRowCost({ ...r, cost_per_unit: costPerUnit(r) });
  }
  return { bag, box };
}

// GET /api/inventory/ready-to-ship — one row per recipe with both formats.
// Valuation: a bag costs its dough cost + its bag packaging; a box is 12 bags + the outer box.
router.get('/ready-to-ship', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT v.*, r.cost_per_575g, r.cost_per_312g
         FROM ready_to_ship_inventory v JOIN recipes r ON r.id = v.recipe_id
        ORDER BY v.recipe_name, v.format DESC`
    );
    const pkg = await packagingCosts(req.db);

    const byRecipe = new Map();
    for (const r of rows) {
      const entry = byRecipe.get(r.recipe_id) || { recipe_id: r.recipe_id, recipe_name: r.recipe_name, formats: {}, total_value: 0 };
      const doughBagCost = Number(r.format === '575g' ? r.cost_per_575g : r.cost_per_312g);
      const bagCost = doughBagCost + (pkg.bag[`${r.recipe_id}:${r.format}`] || 0);
      const boxCost = pkg.box[`${r.recipe_id}:${r.format}`] || 0;
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

// POST /api/inventory/set-stock — Administrator enters the counted boxes and loose bags on hand
// for one batch and format; the difference is recorded as a 'manual_count' adjustment.
router.post('/set-stock', requireAdmin, async (req, res, next) => {
  try {
    const d = z.object({
      batch_id: z.string().uuid(),
      format: z.enum(['575g', '312g']),
      boxes: z.number().int().min(0).max(100000),
      bags: z.number().int().min(0).max(100000)
    }).parse(req.body);

    const result = await withTransaction(async (client) => {
      await lockBatches(client, [d.batch_id]);
      const stockOf = async () => (await client.query(
        'SELECT * FROM batch_finished_stock WHERE batch_id = $1 AND format = $2', [d.batch_id, d.format]
      )).rows[0];
      const before = await stockOf();
      if (!before) throw httpError(404, 'No packed stock for that batch and format');
      const boxDelta = d.boxes - Number(before.boxes_on_hand);
      const bagDelta = d.bags - Number(before.bags_on_hand);
      if (!boxDelta && !bagDelta) return before;
      await client.query(
        `INSERT INTO inventory_adjustments (recipe_id, batch_id, format, box_delta, bag_delta, reason, user_id)
         VALUES ($1,$2,$3,$4,$5,'manual_count',$6)`,
        [before.recipe_id, d.batch_id, d.format, boxDelta, bagDelta, req.user.id]
      );
      await refreshShipStatus(client, [d.batch_id]);
      const after = await stockOf();
      await logAudit(client, req.user.id, 'SET_STOCK', 'production_batch', d.batch_id,
        { format: d.format, boxes: before.boxes_on_hand, bags: before.bags_on_hand },
        { format: d.format, boxes: after.boxes_on_hand, bags: after.bags_on_hand }, req.ip);
      return after;
    });
    res.json(result);
  } catch (e) { handleError(e, res, next); }
});

module.exports = router;
