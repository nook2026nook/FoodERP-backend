/**
 * Production run-cost reconciliation per batch (client's semi-final prototype, DECISIONS.md #40):
 *
 *   gross material cost = recipe batch material cost x batch multiplier
 *   gross production    = gross material cost + packaging cost actually used
 *   wastage             = per baking ingredient: quantity used x cost per kg x wastage %
 *   net production      = gross production - wastage cost
 *
 * Quantity used is what was really taken from lots (batch_lot_allocations, baking stage);
 * a batch that has no allocations yet falls back to the formula grams x multiplier.
 */
const { scaleMultiplier, ROUND } = require('./costing');

const n = (v) => Number(v) || 0;

/**
 * @param db  pg client or pool
 * @param {{batchIds?: string[]|null, includeIngredients?: boolean}} opts  null batchIds = every batch
 * @returns {Promise<Map<string, object>>} batch id -> cost summary
 */
async function batchRunCosts(db, { batchIds = null, includeIngredients = false } = {}) {
  const { rows: batches } = await db.query(
    `SELECT b.id, b.recipe_id, b.bins_count, b.scale_basis, b.total_pkg_cost,
            r.wastage_percent, r.cost_per_batch
       FROM production_batches b JOIN recipes r ON r.id = b.recipe_id
      WHERE ($1::uuid[] IS NULL OR b.id = ANY($1::uuid[]))`,
    [batchIds]
  );
  const result = new Map();
  if (!batches.length) return result;

  const ids = batches.map((b) => b.id);
  const recipeIds = [...new Set(batches.map((b) => b.recipe_id))];

  const [{ rows: formula }, { rows: used }] = await Promise.all([
    db.query(
      `SELECT ri.recipe_id, ri.item_id, ri.grams_per_batch, i.name, i.item_code, i.cost_per_pack, i.unit_pack_size
         FROM recipe_items ri JOIN master_items i ON i.id = ri.item_id
        WHERE ri.recipe_id = ANY($1::uuid[])
        ORDER BY i.name`,
      [recipeIds]
    ),
    db.query(
      `SELECT batch_id, item_id, SUM(quantity)::float8 AS qty
         FROM batch_lot_allocations
        WHERE stage = 'baking' AND batch_id = ANY($1::uuid[])
        GROUP BY batch_id, item_id`,
      [ids]
    )
  ]);

  const usedKey = new Map(used.map((u) => [`${u.batch_id}:${u.item_id}`, n(u.qty)]));
  const formulaByRecipe = new Map();
  for (const f of formula) {
    if (!formulaByRecipe.has(f.recipe_id)) formulaByRecipe.set(f.recipe_id, []);
    formulaByRecipe.get(f.recipe_id).push(f);
  }

  for (const b of batches) {
    const multiplier = scaleMultiplier(b.scale_basis, n(b.bins_count));
    const wastagePercent = n(b.wastage_percent);
    const ingredients = [];
    let totalIngredientCost = 0;
    let wastageKg = 0;
    let wastageCost = 0;

    for (const f of formulaByRecipe.get(b.recipe_id) || []) {
      const packSize = n(f.unit_pack_size) > 0 ? n(f.unit_pack_size) : 1;
      const costPerKg = n(f.cost_per_pack) / packSize;
      const allocated = usedKey.get(`${b.id}:${f.item_id}`);
      const usedKg = allocated > 0 ? allocated : (n(f.grams_per_batch) * multiplier) / 1000;
      const ingredientCost = usedKg * costPerKg;
      const ingWastageKg = usedKg * (wastagePercent / 100);
      const ingWastageCost = ingredientCost * (wastagePercent / 100);
      totalIngredientCost += ingredientCost;
      wastageKg += ingWastageKg;
      wastageCost += ingWastageCost;
      if (includeIngredients) {
        ingredients.push({
          item_id: f.item_id,
          item_code: f.item_code,
          item_name: f.name,
          cost_per_kg: ROUND(costPerKg),
          used_kg: ROUND(usedKg),
          ingredient_cost: ROUND(ingredientCost),
          wastage_percent: wastagePercent,
          wastage_kg: ROUND(ingWastageKg),
          wastage_cost: ROUND(ingWastageCost)
        });
      }
    }

    const summary = summarise({
      multiplier,
      wastagePercent,
      grossMaterialCost: n(b.cost_per_batch) * multiplier,
      packagingCost: n(b.total_pkg_cost),
      totalIngredientCost,
      wastageKg,
      wastageCost
    });
    if (includeIngredients) summary.ingredients = ingredients;
    result.set(b.id, summary);
  }
  return result;
}

function summarise({ multiplier, wastagePercent, grossMaterialCost, packagingCost, totalIngredientCost, wastageKg, wastageCost }) {
  const gross = grossMaterialCost + packagingCost;
  return {
    multiplier,
    wastage_percent: wastagePercent,
    gross_material_cost: ROUND(grossMaterialCost),
    packaging_cost: ROUND(packagingCost),
    gross_production_cost: ROUND(gross),
    total_ingredient_cost: ROUND(totalIngredientCost),
    wastage_kg: ROUND(wastageKg),
    wastage_cost: ROUND(wastageCost),
    net_production_cost: ROUND(Math.max(0, gross - wastageCost))
  };
}

/** Same summary with a different packaging cost (live preview while counts are being typed). */
function withPackagingCost(run, packagingCost) {
  return summarise({
    multiplier: run.multiplier,
    wastagePercent: run.wastage_percent,
    grossMaterialCost: run.gross_material_cost,
    packagingCost: n(packagingCost),
    totalIngredientCost: run.total_ingredient_cost,
    wastageKg: run.wastage_kg,
    wastageCost: run.wastage_cost
  });
}

module.exports = { batchRunCosts, withPackagingCost };
