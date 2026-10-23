/**
 * Loading recipes with their baking formula and packaging BOM, plus the
 * catalog prices the cost model needs. Shared by the recipes and batches routes.
 */

/** Cost of one unit of an item in its own unit (per kg or per unit). */
function costPerUnit(item) {
  const size = Number(item.unit_pack_size);
  return size > 0 ? Number(item.cost_per_pack) / size : 0;
}

async function loadRecipe(db, recipeId) {
  const { rows } = await db.query('SELECT * FROM recipes WHERE id = $1', [recipeId]);
  if (!rows.length) return null;
  const recipe = rows[0];

  const items = await db.query(
    `SELECT ri.item_id, i.name AS item_name, ri.grams_per_batch,
            i.unit_type, i.unit_pack_size, i.cost_per_pack
       FROM recipe_items ri JOIN master_items i ON i.id = ri.item_id
      WHERE ri.recipe_id = $1
      ORDER BY i.name`, [recipeId]
  );
  const packaging = await db.query(
    `SELECT b.packaging_id, i.name AS packaging_name, b.amount, b.measure, b.assignment,
            i.unit_type, i.unit_pack_size, i.cost_per_pack
       FROM recipe_packaging_bom b JOIN master_items i ON i.id = b.packaging_id
      WHERE b.recipe_id = $1
      ORDER BY i.name, b.assignment`, [recipeId]
  );

  recipe.items = items.rows;
  recipe.packaging = packaging.rows;
  return recipe;
}

/** Shape a loaded recipe for the API (drops catalog price columns). */
function presentRecipe(recipe) {
  return {
    ...recipe,
    items: recipe.items.map(({ item_id, item_name, grams_per_batch }) => ({ item_id, item_name, grams_per_batch })),
    packaging: recipe.packaging.map(({ packaging_id, packaging_name, amount, measure, assignment }) =>
      ({ packaging_id, packaging_name, amount, measure, assignment }))
  };
}

module.exports = { costPerUnit, loadRecipe, presentRecipe };
