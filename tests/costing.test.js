const { calculateRecipeCost } = require('../utils/costing');

test('180g units use total formula weight (baking + gram packaging), 2 decimals; 575g/312g unchanged', () => {
  // The client's example: 10,331 g baking + 2,750 g dried cranberries added at packaging = 13,081 g.
  const c = calculateRecipeCost({
    ingredients: [{ grams_per_batch: 10331, cost_per_kg: 10 }],
    packaging: [{ amount: 2750, measure: 'grams', assignment: 'batch', cost_per_unit: 0 }],
    wastagePercent: 0, laborCostPerBatch: 0, mfgMargin: 40, distMargin: 20, retMargin: 35
  });
  expect(c.totalFormulaGrams).toBe(13081);
  expect(c.units180).toBe(72.67);
  expect(c.costPer180g).toBeCloseTo(103.31 / 72.67, 4);
  expect(c.mfgPrice180g).toBeCloseTo(c.costPer180g / 0.6, 3);
  expect(c.units575).toBe(18); // baking grams only, whole bags, as before
  expect(c.units312).toBe(33);
});
