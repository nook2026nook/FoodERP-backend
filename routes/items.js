const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess, requireEdit } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate, requireMenuAccess('ingredients_hub'));

const itemSchema = z.object({
  name: z.string().trim().min(1).max(255),
  category: z.enum(['Baking', 'Packaging']),
  unit_type: z.enum(['kg', 'units']),
  unit_pack_size: z.number().positive(),
  cost_per_pack: z.number().min(0),
  supplier_id: z.string().uuid().nullable().optional(),
  package_role: z.enum(['bag', 'box']).nullable().optional()
});

router.get('/', async (req, res, next) => {
  try {
    const { category } = req.query;
    const params = [];
    let where = '';
    if (category === 'Baking' || category === 'Packaging') {
      params.push(category);
      where = 'WHERE i.category = $1';
    }
    const { rows } = await req.db.query(
      `SELECT i.*, s.name AS supplier_name,
              COALESCE((SELECT SUM(l.remaining_quantity) FROM warehouse_lots l
                         WHERE l.item_id = i.id), 0)::numeric AS remaining_quantity
         FROM master_items i LEFT JOIN suppliers s ON s.id = i.supplier_id
         ${where}
        ORDER BY i.category, i.name`, params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', requireEdit('ingredients_hub'), async (req, res, next) => {
  try {
    const d = itemSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO master_items (name, category, unit_type, unit_pack_size, cost_per_pack, supplier_id, package_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.name, d.category, d.unit_type, d.unit_pack_size, d.cost_per_pack, d.supplier_id || null, d.package_role || null]
    );
    await logAudit(req.db, req.user.id, 'CREATE', 'master_item', rows[0].id, null, rows[0], req.ip);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
    next(e);
  }
});

router.put('/:id', requireEdit('ingredients_hub'), async (req, res, next) => {
  try {
    const d = itemSchema.parse(req.body);
    const before = await req.db.query('SELECT * FROM master_items WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Item not found' });
    const { rows } = await req.db.query(
      `UPDATE master_items SET name=$1, category=$2, unit_type=$3, unit_pack_size=$4,
              cost_per_pack=$5, supplier_id=$6, package_role=$7 WHERE id=$8 RETURNING *`,
      [d.name, d.category, d.unit_type, d.unit_pack_size, d.cost_per_pack, d.supplier_id || null, d.package_role || null, req.params.id]
    );
    await logAudit(req.db, req.user.id, 'UPDATE', 'master_item', req.params.id, before.rows[0], rows[0], req.ip);
    res.json(rows[0]);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
    next(e);
  }
});

router.delete('/:id', requireEdit('ingredients_hub'), async (req, res, next) => {
  try {
    const before = await req.db.query('SELECT * FROM master_items WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Item not found' });
    const used = await req.db.query('SELECT COUNT(*)::int AS n FROM warehouse_lots WHERE item_id = $1', [req.params.id]);
    if (used.rows[0].n > 0) {
      return res.status(409).json({ error: 'Item has received lots — delete the lots first or deactivate the item' });
    }
    const recipes = await req.db.query(
      `SELECT DISTINCT r.name FROM recipes r
         WHERE r.id IN (SELECT recipe_id FROM recipe_items WHERE item_id = $1
                        UNION SELECT recipe_id FROM recipe_packaging_bom WHERE packaging_id = $1)
         ORDER BY r.name`,
      [req.params.id]
    );
    if (recipes.rows.length) {
      const names = recipes.rows.map(r => r.name).join(', ');
      return res.status(409).json({ error: `Item is used in recipe(s): ${names}. Remove it from them first, or deactivate the item.` });
    }
    await req.db.query('DELETE FROM master_items WHERE id = $1', [req.params.id]);
    await logAudit(req.db, req.user.id, 'DELETE', 'master_item', req.params.id, before.rows[0], null, req.ip);
    res.json({ message: 'Item deleted' });
  } catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'Item is referenced by a recipe or lot' });
    next(e);
  }
});

module.exports = router;
