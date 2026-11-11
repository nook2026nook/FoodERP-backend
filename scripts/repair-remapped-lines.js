/**
 * One-off repair (2026-11-11): before the fix in routes/shipments.js, choosing a batch of a
 * different flavor in Shipping's "Map Batch #" overwrote a QuickBooks line's flavor and size
 * and took stock from that other flavor (invoice 10587: Chocolate Chip 300g became Simply
 * Almond 575g, Apple Cranberry 575g became Cranberry Maple 575g).
 *
 * For every QuickBooks line whose flavor/size differs from its qbo_item_map entry:
 *   1. release its allocations (the stock goes back to the wrong batches),
 *   2. restore flavor, size and unit from the item map,
 *   3. allocate it oldest released batch first, as a normal sync does (partial if short).
 *
 * Dry run by default; `node scripts/repair-remapped-lines.js --apply` writes, in one transaction.
 */
require('dotenv').config();
const { pool, withTransaction } = require('../db');
const { allocateLine, releaseLine } = require('../utils/finishedStock');
const { logAudit } = require('../utils/audit');

const FIND = `
  SELECT l.id, s.invoice_number, l.qbo_line_id, l.product_description, l.quantity,
         l.recipe_id, l.format, l.unit_type, rl.name AS now_recipe,
         m.recipe_id AS map_recipe_id, m.format AS map_format, m.unit_type AS map_unit, rm.name AS map_recipe
    FROM shipment_lines l
    JOIN shipments s ON s.id = l.shipment_id
    JOIN qbo_item_map m ON m.qbo_item_id = l.qbo_item_id
    LEFT JOIN recipes rl ON rl.id = l.recipe_id
    LEFT JOIN recipes rm ON rm.id = m.recipe_id
   WHERE l.recipe_id IS DISTINCT FROM m.recipe_id OR l.format IS DISTINCT FROM m.format
   ORDER BY s.invoice_number, l.qbo_line_id`;

async function allocationsOf(db, lineId) {
  const { rows } = await db.query(
    `SELECT b.batch_number, r.name AS recipe, a.boxes, a.bags
       FROM shipment_allocations a JOIN production_batches b ON b.id = a.batch_id JOIN recipes r ON r.id = b.recipe_id
      WHERE a.line_id = $1 ORDER BY b.batch_number`, [lineId]
  );
  return rows.map(a => `${a.batch_number} ${a.recipe}: ${a.boxes} box ${a.bags} bag`).join('; ') || 'none';
}

(async () => {
  const apply = process.argv.includes('--apply');
  const { rows } = await pool.query(FIND);
  if (!rows.length) { console.log('Nothing to repair.'); return; }

  for (const l of rows) {
    console.log(`Invoice ${l.invoice_number} line ${l.qbo_line_id} "${l.product_description}" x${l.quantity}`);
    console.log(`   now:    ${l.now_recipe} ${l.format}  (allocations: ${await allocationsOf(pool, l.id)})`);
    console.log(`   should: ${l.map_recipe} ${l.map_format}`);
  }
  if (!apply) { console.log('\nDry run. Re-run with --apply to repair.'); return; }

  await withTransaction(async (client) => {
    for (const l of rows) {
      const before = { recipe_id: l.recipe_id, format: l.format, unit_type: l.unit_type, allocations: await allocationsOf(client, l.id) };
      await releaseLine(client, l.id);
      await client.query('UPDATE shipment_lines SET recipe_id = $1, format = $2, unit_type = $3 WHERE id = $4',
        [l.map_recipe_id, l.map_format, l.map_unit, l.id]);
      const r = await allocateLine(client, l.id, { strict: false });
      const after = { recipe_id: l.map_recipe_id, format: l.map_format, unit_type: l.map_unit, ...r, allocations: await allocationsOf(client, l.id) };
      await logAudit(client, null, 'REPAIR_REMAPPED_LINE', 'shipment_line', l.id, before, after, null);
      console.log(`Repaired invoice ${l.invoice_number} line ${l.qbo_line_id}: ${l.map_recipe} ${l.map_format} -> ${r.status} (${after.allocations})`);
    }
  });
})()
  .catch((e) => { console.error('Repair failed, nothing changed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
