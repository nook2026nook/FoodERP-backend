const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess, requireEdit } = require('../middleware/auth');
const { requireVault } = require('../middleware/vault');
const { logAudit } = require('../utils/audit');
const { withTransaction } = require('../db');
const { calculateRecipeCost } = require('../utils/costing');
const { costPerUnit, loadRecipe, presentRecipe } = require('../utils/recipeData');

const router = express.Router();
router.use(authenticate);

const recipeSchema = z.object({
  name: z.string().trim().min(1).max(255),
  scale_basis: z.enum(['batch', 'bin']).default('batch'),
  wastage_percent: z.number().min(0).max(100),
  labor_cost_per_batch: z.number().min(0),
  manufacturer_margin_percent: z.number().min(0).max(100),
  distributor_margin_percent: z.number().min(0).max(100),
  retailer_margin_percent: z.number().min(0).max(100),
  items: z.array(z.object({
    item_id: z.string().uuid(),
    grams_per_batch: z.number().positive()
  })).min(1, 'Specify at least one baking ingredient'),
  packaging: z.array(z.object({
    packaging_id: z.string().uuid(),
    amount: z.number().positive(),
    measure: z.enum(['units', 'grams']),
    assignment: z.enum(['bag575', 'box575', 'bag312', 'box312', 'batch'])
  })).default([])
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function handleError(e, res, next) {
  if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
  if (e.status) return res.status(e.status).json({ error: e.message });
  if (e.code === '23505') return res.status(409).json({ error: 'A recipe with that name already exists' });
  if (e.code === '23503') return res.status(409).json({ error: 'Recipe is used by production batches or shipments and cannot be deleted' });
  return next(e);
}

/**
 * Validate the formula against the catalog and run the cost model.
 * Baking rows must be Baking items; packaging rows must be Packaging items whose
 * unit matches the measure (grams => kg item, units => units item) so stock
 * deductions stay in the item's own unit.
 */
async function costFormula(db, d) {
  const ids = [...new Set([...d.items.map(i => i.item_id), ...d.packaging.map(p => p.packaging_id)])];
  const { rows } = await db.query(
    'SELECT id, name, category, unit_type, unit_pack_size, cost_per_pack FROM master_items WHERE id = ANY($1::uuid[])',
    [ids]
  );
  const byId = new Map(rows.map(r => [r.id, r]));

  const seenItems = new Set();
  const ingredients = d.items.map(row => {
    const item = byId.get(row.item_id);
    if (!item) throw httpError(400, 'A baking ingredient no longer exists in the catalog');
    if (item.category !== 'Baking') throw httpError(400, `${item.name} is not a baking ingredient`);
    if (seenItems.has(row.item_id)) throw httpError(400, `${item.name} is listed twice in the formula`);
    seenItems.add(row.item_id);
    return { grams_per_batch: row.grams_per_batch, cost_per_kg: costPerUnit(item) };
  });

  const seenBom = new Set();
  const packaging = d.packaging.map(row => {
    const item = byId.get(row.packaging_id);
    if (!item) throw httpError(400, 'A packaging material no longer exists in the catalog');
    if (item.category !== 'Packaging') throw httpError(400, `${item.name} is not a packaging material`);
    if (row.measure === 'grams' && item.unit_type !== 'kg') {
      throw httpError(400, `${item.name} is counted in units; measure it in units, not grams`);
    }
    if (row.measure === 'units' && item.unit_type !== 'units') {
      throw httpError(400, `${item.name} is stocked by weight; measure it in grams`);
    }
    const key = `${row.packaging_id}:${row.assignment}`;
    if (seenBom.has(key)) throw httpError(400, `${item.name} is listed twice for the same assignment`);
    seenBom.add(key);
    return { amount: row.amount, measure: row.measure, assignment: row.assignment, cost_per_unit: costPerUnit(item) };
  });

  return calculateRecipeCost({
    ingredients,
    packaging,
    wastagePercent: d.wastage_percent,
    laborCostPerBatch: d.labor_cost_per_batch,
    mfgMargin: d.manufacturer_margin_percent,
    distMargin: d.distributor_margin_percent,
    retMargin: d.retailer_margin_percent
  });
}

const RECIPE_COLUMNS = [
  'name', 'scale_basis', 'wastage_percent', 'labor_cost_per_batch',
  'manufacturer_margin_percent', 'distributor_margin_percent', 'retailer_margin_percent',
  'total_baking_grams', 'total_packaging_grams', 'cost_per_batch', 'dough_cost',
  'bag_material_cost', 'box_material_cost', 'shared_material_cost', 'units_575', 'units_312',
  'cost_per_575g', 'cost_per_312g', 'mfg_price_575g', 'mfg_price_312g',
  'dist_price_575g', 'dist_price_312g', 'retail_price_575g', 'retail_price_312g'
];

function recipeValues(d, c) {
  return [
    d.name, d.scale_basis, d.wastage_percent, d.labor_cost_per_batch,
    d.manufacturer_margin_percent, d.distributor_margin_percent, d.retailer_margin_percent,
    c.totalBakingGrams, c.totalPackagingGrams, c.totalCost, c.doughCost,
    c.bagMaterialCost, c.boxMaterialCost, c.sharedMaterialCost, c.units575, c.units312,
    c.costPer575g, c.costPer312g, c.mfgPrice575g, c.mfgPrice312g,
    c.distPrice575g, c.distPrice312g, c.retailPrice575g, c.retailPrice312g
  ];
}

async function writeFormula(client, recipeId, d) {
  await client.query('DELETE FROM recipe_items WHERE recipe_id = $1', [recipeId]);
  await client.query('DELETE FROM recipe_packaging_bom WHERE recipe_id = $1', [recipeId]);
  for (const row of d.items) {
    await client.query(
      'INSERT INTO recipe_items (recipe_id, item_id, grams_per_batch) VALUES ($1,$2,$3)',
      [recipeId, row.item_id, row.grams_per_batch]
    );
  }
  for (const row of d.packaging) {
    await client.query(
      `INSERT INTO recipe_packaging_bom (recipe_id, packaging_id, amount, measure, assignment)
       VALUES ($1,$2,$3,$4,$5)`,
      [recipeId, row.packaging_id, row.amount, row.measure, row.assignment]
    );
  }
}

// GET /api/recipes/options — names only, for Production; no vault, no costs or grams.
router.get('/options', requireMenuAccess('production', 'recipes'), async (req, res, next) => {
  try {
    const { rows } = await req.db.query('SELECT id, name, scale_basis FROM recipes ORDER BY name');
    res.json(rows);
  } catch (e) { next(e); }
});

// Everything below shows formulations and costs: vault required.
router.use(requireMenuAccess('recipes'), requireVault);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query('SELECT id FROM recipes ORDER BY name');
    const recipes = [];
    for (const r of rows) recipes.push(presentRecipe(await loadRecipe(req.db, r.id)));
    res.json(recipes);
  } catch (e) { next(e); }
});

// POST /api/recipes/preview — live cost calculation for the formulation form; saves nothing.
router.post('/preview', async (req, res, next) => {
  try {
    const d = recipeSchema.parse(req.body);
    res.json(await costFormula(req.db, d));
  } catch (e) { handleError(e, res, next); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const recipe = await loadRecipe(req.db, req.params.id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
    res.json(presentRecipe(recipe));
  } catch (e) { next(e); }
});

router.post('/', requireEdit('recipes'), async (req, res, next) => {
  try {
    const d = recipeSchema.parse(req.body);
    const recipe = await withTransaction(async (client) => {
      const cost = await costFormula(client, d);
      const placeholders = RECIPE_COLUMNS.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await client.query(
        `INSERT INTO recipes (${RECIPE_COLUMNS.join(',')}) VALUES (${placeholders}) RETURNING id`,
        recipeValues(d, cost)
      );
      await writeFormula(client, rows[0].id, d);
      const saved = presentRecipe(await loadRecipe(client, rows[0].id));
      await logAudit(client, req.user.id, 'CREATE', 'recipe', saved.id, null, saved, req.ip);
      return saved;
    });
    res.status(201).json(recipe);
  } catch (e) { handleError(e, res, next); }
});

router.put('/:id', requireEdit('recipes'), async (req, res, next) => {
  try {
    const d = recipeSchema.parse(req.body);
    const recipe = await withTransaction(async (client) => {
      const before = await loadRecipe(client, req.params.id);
      if (!before) throw httpError(404, 'Recipe not found');
      const cost = await costFormula(client, d);
      const sets = RECIPE_COLUMNS.map((col, i) => `${col} = $${i + 1}`).join(', ');
      await client.query(
        `UPDATE recipes SET ${sets} WHERE id = $${RECIPE_COLUMNS.length + 1}`,
        [...recipeValues(d, cost), req.params.id]
      );
      await writeFormula(client, req.params.id, d);
      const saved = presentRecipe(await loadRecipe(client, req.params.id));
      await logAudit(client, req.user.id, 'UPDATE', 'recipe', req.params.id, presentRecipe(before), saved, req.ip);
      return saved;
    });
    res.json(recipe);
  } catch (e) { handleError(e, res, next); }
});

router.delete('/:id', requireEdit('recipes'), async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const before = await loadRecipe(client, req.params.id);
      if (!before) throw httpError(404, 'Recipe not found');
      await client.query('DELETE FROM recipes WHERE id = $1', [req.params.id]);
      await logAudit(client, req.user.id, 'DELETE', 'recipe', req.params.id, presentRecipe(before), null, req.ip);
    });
    res.json({ message: 'Recipe deleted' });
  } catch (e) { handleError(e, res, next); }
});

module.exports = router;
