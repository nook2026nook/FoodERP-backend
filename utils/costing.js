/**
 * THE single implementation of the client's recipe cost model.
 * Ported from v45 RecipesView.calculatedBatchCostData (HTML lines 1324-1397):
 *   - wastage % applies to baking ingredient cost only
 *   - yield (575g / 312g units) comes from baking grams only
 *   - 'batch' packaging is shared across the yield; bag rows add per bag;
 *     box rows add cost / 12 per bag
 */

const ROUND = (n) => Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;

/** Cost of one BOM row in dollars, before batch/bag/box assignment. */
function packagingRowCost(row) {
  const amount = Number(row.amount) || 0;
  const costPerUnit = Number(row.cost_per_unit) || 0;
  return row.measure === 'grams' ? (amount / 1000) * costPerUnit : amount * costPerUnit;
}

/**
 * @param {object} p
 * @param {Array<{grams_per_batch:number, cost_per_kg:number}>} p.ingredients
 * @param {Array<{amount:number, measure:'units'|'grams', assignment:string,
 *                cost_per_unit:number}>} p.packaging  cost_per_unit = cost_per_pack / unit_pack_size
 * @param {number} p.wastagePercent
 * @param {number} p.laborCostPerBatch
 * @param {number} p.mfgMargin
 * @param {number} p.distMargin
 * @param {number} p.retMargin
 */
function calculateRecipeCost(p) {
  const ingredients = p.ingredients || [];
  const packaging = p.packaging || [];

  // ---- baking ingredients ----
  let doughCost = 0;
  let totalBakingGrams = 0;
  for (const ing of ingredients) {
    const grams = Number(ing.grams_per_batch) || 0;
    totalBakingGrams += grams;
    doughCost += (grams / 1000) * (Number(ing.cost_per_kg) || 0);
  }

  const labor = Number(p.laborCostPerBatch) || 0;
  const wastage = doughCost * ((Number(p.wastagePercent) || 0) / 100);
  const baseBatchCost = doughCost + labor + wastage;

  const units575 = totalBakingGrams > 0 ? Math.round(totalBakingGrams / 575) : 1;
  const units312 = totalBakingGrams > 0 ? Math.round(totalBakingGrams / 312) : 1;

  // ---- packaging, split by assignment ----
  let sharedMaterialCost = 0;   // 'batch' rows, per batch
  let bag575Cost = 0;           // per 575g bag
  let bag312Cost = 0;           // per 312g bag
  let box575Cost = 0;           // per 575g box
  let box312Cost = 0;           // per 312g box
  let totalPackagingGrams = 0;

  for (const row of packaging) {
    if (row.measure === 'grams') totalPackagingGrams += Number(row.amount) || 0;
    const cost = packagingRowCost(row);
    if (row.assignment === 'bag575') bag575Cost += cost;
    else if (row.assignment === 'bag312') bag312Cost += cost;
    else if (row.assignment === 'box575') box575Cost += cost;
    else if (row.assignment === 'box312') box312Cost += cost;
    else sharedMaterialCost += cost;
  }

  const costPer575g = (units575 > 0 ? (baseBatchCost + sharedMaterialCost) / units575 : 0)
    + bag575Cost + box575Cost / 12;
  const costPer312g = (units312 > 0 ? (baseBatchCost + sharedMaterialCost) / units312 : 0)
    + bag312Cost + box312Cost / 12;
  const totalCost = baseBatchCost + sharedMaterialCost;

  const mfg = Number(p.mfgMargin) || 0;
  const dist = Number(p.distMargin) || 0;
  const ret = Number(p.retMargin) || 0;

  const markup = (value, marginPercent) =>
    marginPercent < 100 ? value / (1 - marginPercent / 100) : value * 1.5;

  const mfg575 = markup(costPer575g, mfg);
  const mfg312 = markup(costPer312g, mfg);
  const dist575 = markup(mfg575, dist);
  const dist312 = markup(mfg312, dist);
  const ret575 = markup(dist575, ret);
  const ret312 = markup(dist312, ret);

  return {
    doughCost: ROUND(doughCost),
    bagMaterialCost: ROUND(bag575Cost + bag312Cost),
    boxMaterialCost: ROUND(box575Cost + box312Cost),
    sharedMaterialCost: ROUND(sharedMaterialCost),
    bag575Cost: ROUND(bag575Cost),
    bag312Cost: ROUND(bag312Cost),
    box575Cost: ROUND(box575Cost),
    box312Cost: ROUND(box312Cost),
    ingCost: ROUND(doughCost + sharedMaterialCost),
    labor: ROUND(labor),
    wastage: ROUND(wastage),
    totalCost: ROUND(totalCost),
    totalBakingGrams: ROUND(totalBakingGrams),
    totalPackagingGrams: ROUND(totalPackagingGrams),
    units575,
    units312,
    costPer575g: ROUND(costPer575g),
    costPer312g: ROUND(costPer312g),
    mfgPrice575g: ROUND(mfg575),
    mfgPrice312g: ROUND(mfg312),
    distPrice575g: ROUND(dist575),
    distPrice312g: ROUND(dist312),
    retailPrice575g: ROUND(ret575),
    retailPrice312g: ROUND(ret312)
  };
}

/**
 * Ready-to-ship valuation (client's documented formula, isolated here).
 * Box = bag cost x 12 + outer box cost; bags valued at bag cost.
 */
function valueReadyToShip({ boxes, bags, bagCost, boxCost }) {
  const b = Number(boxes) || 0;
  const g = Number(bags) || 0;
  const boxValue = b * (Number(bagCost) * 12 + (Number(boxCost) || 0));
  const bagValue = g * Number(bagCost);
  return { boxValue: ROUND(boxValue), bagValue: ROUND(bagValue), total: ROUND(boxValue + bagValue) };
}

/** Multiplier for batch scaling: bin => bins, batch => bins / 2. */
function scaleMultiplier(basis, bins) {
  const b = Number(bins) || 0;
  return basis === 'bin' ? b : b / 2;
}

/** Theoretical dough grams for a batch. */
function theoreticalDoughGrams(totalBakingGrams, basis, bins) {
  return (Number(totalBakingGrams) || 0) * scaleMultiplier(basis, bins);
}

/** Packaged weight in grams from the packaging breakdown. */
function packagedGrams({ boxes_575g = 0, bags_575g = 0, boxes_312g = 0, bags_312g = 0 }) {
  return (Number(boxes_575g) * 12 + Number(bags_575g)) * 575
       + (Number(boxes_312g) * 12 + Number(bags_312g)) * 312;
}

/** +/- 50 g thresholds from v45. */
function varianceStatus(deltaGrams) {
  if (deltaGrams > 50) return 'Over-Yield';
  if (deltaGrams < -50) return 'Scrap / Loss';
  return 'Balanced';
}

module.exports = {
  calculateRecipeCost, packagingRowCost, valueReadyToShip, scaleMultiplier,
  theoreticalDoughGrams, packagedGrams, varianceStatus, ROUND
};
