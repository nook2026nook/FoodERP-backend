/**
 * Production Planning (client prototype v60): customer box orders -> net boxes
 * to bake (after released stock), gross dough with wastage, batches in half-batch (1 bin) steps,
 * bins, and a material pull list checked against live lot stock.
 *
 * Batch and packaging quantities reuse the Production screen's own math
 * (bakingRequirements / packagingRequirements), so a plan transferred to
 * Baking asks for exactly what the plan showed.
 */
const { loadRecipe } = require('./recipeData');
const { bakingRequirements, packagingRequirements } = require('./production');
const { ROUND } = require('./costing');
const { httpError } = require('./stock');

const PACK_GRAMS = { 575: 575, 312: 312 };
const BAGS_PER_BOX = 12;
const num = (v) => Number(v) || 0;

/**
 * @param db pg pool or client
 * @param {{ lines: {recipe_id, pack_size, boxes_ordered, in_stock_override?}[], deduct_inventory: boolean }} input
 */
async function calculatePlan(db, { lines, deduct_inventory: deduct }) {
  const recipeIds = [...new Set(lines.map(l => l.recipe_id))];
  const recipes = new Map();
  for (const id of recipeIds) {
    const recipe = await loadRecipe(db, id);
    if (!recipe) throw httpError(400, 'A selected flavor no longer exists');
    if (num(recipe.total_baking_grams) <= 0) throw httpError(400, `${recipe.name} has no baking ingredients, so its batch size is unknown`);
    recipes.set(id, recipe);
  }

  // Released boxes on hand per recipe and format (same source as Ready to Ship).
  const stock = new Map();
  const ready = await db.query('SELECT recipe_id, format, boxes FROM ready_to_ship_inventory');
  for (const r of ready.rows) stock.set(`${r.recipe_id}_${String(r.format).replace('g', '')}`, num(r.boxes));

  const lotStock = new Map();
  const lotRows = await db.query(
    'SELECT item_id, SUM(remaining_quantity) AS available FROM warehouse_lots WHERE remaining_quantity > 0 GROUP BY item_id'
  );
  for (const r of lotRows.rows) lotStock.set(r.item_id, num(r.available));

  // Stock is shared across lines of the same flavor and format, first line first.
  const remainingStock = new Map(stock);
  const lineResults = lines.map((line) => {
    const key = `${line.recipe_id}_${line.pack_size}`;
    const systemStock = stock.get(key) || 0;
    const override = line.in_stock_override;
    const available = override === undefined || override === null ? (remainingStock.get(key) || 0) : Math.max(0, num(override));
    const ordered = Math.max(0, Math.trunc(num(line.boxes_ordered)));
    const inStock = deduct ? Math.min(available, ordered) : 0;
    if (override === undefined || override === null) remainingStock.set(key, (remainingStock.get(key) || 0) - inStock);
    const netBoxes = ordered - inStock;
    return {
      recipe_id: line.recipe_id,
      pack_size: line.pack_size,
      boxes_ordered: ordered,
      system_stock_boxes: systemStock,
      in_stock_boxes: inStock,
      net_boxes: netBoxes,
      net_bags: netBoxes * BAGS_PER_BOX,
      net_kg: ROUND((netBoxes * BAGS_PER_BOX * PACK_GRAMS[line.pack_size]) / 1000)
    };
  });

  const flavors = recipeIds.map((id) => {
    const recipe = recipes.get(id);
    const mine = lineResults.filter(l => l.recipe_id === id);
    const net575 = mine.filter(l => l.pack_size === '575').reduce((a, l) => a + l.net_boxes, 0);
    const net312 = mine.filter(l => l.pack_size === '312').reduce((a, l) => a + l.net_boxes, 0);
    const netKg = mine.reduce((a, l) => a + l.net_kg, 0);
    const wastage = num(recipe.wastage_percent);
    const grossKg = netKg > 0 ? netKg / (1 - wastage / 100) : 0;
    const batchSizeKg = num(recipe.total_baking_grams) / 1000;
    const exact = grossKg / batchSizeKg;
    // Whole bins: a batch is 2 bins, so batch-basis recipes can schedule half batches (1.4 -> 1.5).
    // ROUND first drops float noise (e.g. 3.0000000001) before rounding up.
    const basis = recipe.scale_basis === 'bin' ? 'bin' : 'batch';
    const bins = grossKg > 0 ? Math.ceil(ROUND(basis === 'bin' ? exact : exact * 2)) : 0;
    const batches = basis === 'bin' ? bins : bins / 2;
    const totalNet = net575 + net312;
    const binsLarge = totalNet > 0 ? Math.round((net575 / totalNet) * bins) : bins;

    const mark = (req) => {
      const available = ROUND(lotStock.get(req.item_id) || 0);
      const shortage = ROUND(Math.max(0, req.required - available));
      return { ...req, available, shortage, short: shortage > 0 };
    };
    const ingredients = batches > 0 ? bakingRequirements(recipe, basis, bins).map(mark) : [];
    const packaging = batches > 0
      ? packagingRequirements(recipe, basis, bins, { boxes_575g: net575, boxes_312g: net312 }).requirements
        .filter(r => r.required > 0).map(mark)
      : [];

    return {
      recipe_id: id,
      recipe_name: recipe.name,
      scale_basis: basis,
      batch_size_kg: ROUND(batchSizeKg),
      wastage_percent: wastage,
      ordered_boxes: mine.reduce((a, l) => a + l.boxes_ordered, 0),
      net_boxes_575g: net575,
      net_boxes_312g: net312,
      net_bags: (net575 + net312) * BAGS_PER_BOX,
      net_kg: ROUND(netKg),
      gross_kg: ROUND(grossKg),
      exact_batches: ROUND(exact),
      scheduled_batches: batches,
      scheduled_bins: bins,
      bins_large: binsLarge,
      bins_small: bins - binsLarge,
      ingredients,
      packaging,
      shortages: ingredients.filter(i => i.short).length + packaging.filter(p => p.short).length
    };
  });

  const sum = (key) => ROUND(flavors.reduce((a, f) => a + num(f[key]), 0));
  return {
    lines: lineResults,
    flavors,
    totals: {
      scheduled_batches: sum('scheduled_batches'),
      scheduled_bins: sum('scheduled_bins'),
      exact_batches: sum('exact_batches'),
      gross_kg: sum('gross_kg'),
      net_kg: sum('net_kg'),
      net_boxes: flavors.reduce((a, f) => a + f.net_boxes_575g + f.net_boxes_312g, 0),
      net_bags: sum('net_bags'),
      shortages: sum('shortages')
    }
  };
}

module.exports = { calculatePlan };
