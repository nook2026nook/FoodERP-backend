/**
 * Production math ported from v45 ProductionView (HTML lines 1641-1833),
 * with the client's scale-basis rule (DECISIONS.md #21) applied.
 */
const { scaleMultiplier, packagedGrams, ROUND } = require('./costing');
const { costPerUnit } = require('./recipeData');

const BAGS_PER_BOX = 12;

/** Kg of each baking ingredient needed for a batch. */
function bakingRequirements(recipe, basis, bins) {
  const mult = scaleMultiplier(basis, bins);
  return recipe.items.map(row => ({
    item_id: row.item_id,
    item_name: row.item_name,
    unit_type: row.unit_type,
    required: ROUND((Number(row.grams_per_batch) * mult) / 1000)
  }));
}

function normaliseCounts(c = {}) {
  const n = (v) => Math.max(0, Math.trunc(Number(v) || 0));
  const counts = { bags_575g: n(c.bags_575g), boxes_575g: n(c.boxes_575g), bags_312g: n(c.bags_312g), boxes_312g: n(c.boxes_312g) };
  counts.total_bags_575g = counts.bags_575g + counts.boxes_575g * BAGS_PER_BOX;
  counts.total_bags_312g = counts.bags_312g + counts.boxes_312g * BAGS_PER_BOX;
  return counts;
}

/** How many bags/boxes/batches a BOM assignment applies to. */
function assignmentCount(assignment, counts, mult) {
  switch (assignment) {
    case 'bag575': return counts.total_bags_575g;
    case 'bag312': return counts.total_bags_312g;
    case 'box575': return counts.boxes_575g;
    case 'box312': return counts.boxes_312g;
    default: return mult;
  }
}

/**
 * Packaging materials needed for the packed counts, summed per material in the
 * material's own unit (units, or kg for gram-measured rows), plus the actual
 * packaging cost breakdown the HTML stores on the batch.
 */
function packagingRequirements(recipe, basis, bins, rawCounts) {
  const counts = normaliseCounts(rawCounts);
  const mult = scaleMultiplier(basis, bins);
  const byItem = new Map();
  const cost = { bag575: 0, box575: 0, bag312: 0, box312: 0, other: 0 };

  for (const row of recipe.packaging) {
    const amount = Number(row.amount) || 0;
    const count = assignmentCount(row.assignment, counts, mult);
    const qty = row.measure === 'grams' ? (amount * count) / 1000 : amount * count;
    const rowCost = qty * costPerUnit(row);

    if (row.assignment === 'batch') cost.other += rowCost;
    else cost[row.assignment] += rowCost;

    const entry = byItem.get(row.packaging_id)
      || { item_id: row.packaging_id, item_name: row.packaging_name, unit_type: row.unit_type, required: 0 };
    entry.required += qty;
    byItem.set(row.packaging_id, entry);
  }

  const requirements = [...byItem.values()].map(r => ({ ...r, required: ROUND(r.required) }));
  const total = cost.bag575 + cost.box575 + cost.bag312 + cost.box312 + cost.other;
  return {
    counts,
    requirements,
    cost: {
      bag575: ROUND(cost.bag575), box575: ROUND(cost.box575),
      bag312: ROUND(cost.bag312), box312: ROUND(cost.box312),
      other: ROUND(cost.other), total: ROUND(total)
    }
  };
}

/** Theoretical dough, packed grams and the live delta for a batch. */
function yieldVariance(recipe, basis, bins, rawCounts) {
  const counts = normaliseCounts(rawCounts);
  const theoretical = ROUND(Number(recipe.total_baking_grams) * scaleMultiplier(basis, bins));
  const packaged = packagedGrams(counts);
  return { theoretical_dough_grams: theoretical, packaged_weight_grams: packaged, variance_delta_grams: ROUND(packaged - theoretical) };
}

/** Oldest-first split of a required quantity over lots ({id, lot_number, available}). */
function fifoSplit(lots, required) {
  let need = Number(required) || 0;
  const splits = [];
  for (const lot of lots) {
    if (need <= 0.0001) break;
    const take = Math.min(need, Number(lot.available));
    if (take > 0) {
      splits.push({ lot_id: lot.id, lot_number: lot.lot_number, quantity: ROUND(take) });
      need -= take;
    }
  }
  return { splits, shortfall: ROUND(Math.max(0, need)) };
}

module.exports = {
  BAGS_PER_BOX, bakingRequirements, packagingRequirements, yieldVariance, normaliseCounts, fifoSplit
};
