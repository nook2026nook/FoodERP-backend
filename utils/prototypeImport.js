/**
 * Import a backup JSON exported by the old browser-only prototype (localStorage
 * keys: suppliers, bakingIngredients, packagingMaterials, lots, recipes, batches,
 * shippings, usersDatabase) into the database. Runs inside one transaction.
 *
 * - Records that already exist (same name / lot number / batch number / email) are skipped.
 * - Prototype lot quantities are already net of production, so imported batches
 *   record their lot usage WITHOUT deducting stock a second time.
 * - Prototype shipments have no pack format or unit, so they are imported as
 *   unallocated lines for an administrator to review, never guessed.
 * - Users get a random temporary password and must change it at first login;
 *   prototype PINs are never used as passwords.
 */
const crypto = require('crypto');
const { hashPassword } = require('./password');
const { calculateRecipeCost, ROUND } = require('./costing');
const { costPerUnit, loadRecipe } = require('./recipeData');
const { yieldVariance, packagingRequirements } = require('./production');
const { httpError } = require('./stock');

const ROLES = ['Administrator', 'Production Operator', 'Quality Assurance (QA)', 'Shipping Clerk', 'View-Only Guest', 'Custom Staff'];
const MENUS = ['dashboard', 'ingredients_hub', 'receiving', 'recipes', 'production', 'ready_to_ship', 'shipping', 'reports', 'wastage', 'recall', 'help'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v : []);

/** The prototype stored dates as ISO strings or toLocaleDateString() output. */
function toIsoDate(value) {
  if (typeof value === 'string' && ISO_DATE.test(value.slice(0, 10))) return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Locale strings parse as local midnight; toISOString() would shift them a day in UTC+ zones.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function importPrototypeBackup(client, backup, userId) {
  const known = ['suppliers', 'bakingIngredients', 'packagingMaterials', 'lots', 'recipes', 'batches', 'shippings', 'usersDatabase'];
  if (!known.some(k => Array.isArray(backup[k]))) {
    throw httpError(400, 'This file is not a backup from the browser version of the app (no suppliers, ingredients, lots, recipes, batches, shippings or users found)');
  }

  const created = {}; const skipped = {}; const warnings = []; const temporaryPasswords = [];
  const bump = (bag, key) => { bag[key] = (bag[key] || 0) + 1; };

  // ---- suppliers (strings in v45; objects with a name in some versions) ----
  const supplierId = new Map();
  const ensureSupplier = async (name) => {
    const n = text(name);
    if (!n) return null;
    if (supplierId.has(n.toLowerCase())) return supplierId.get(n.toLowerCase());
    const found = await client.query('SELECT id FROM suppliers WHERE lower(name) = lower($1)', [n]);
    let id = found.rows[0]?.id;
    if (id) bump(skipped, 'suppliers');
    else {
      id = (await client.query('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [n])).rows[0].id;
      bump(created, 'suppliers');
    }
    supplierId.set(n.toLowerCase(), id);
    return id;
  };
  for (const s of list(backup.suppliers)) await ensureSupplier(typeof s === 'string' ? s : s?.name);

  // ---- catalog items ----
  const itemId = new Map(); // prototype id -> { id, unit_type, unit_pack_size, cost_per_pack, name }
  const importItem = async (raw, category) => {
    const name = text(raw?.name);
    if (!name) { warnings.push(`Skipped a ${category.toLowerCase()} item with no name`); return; }
    const unitType = category === 'Baking' ? 'kg' : (raw.unitType === 'kg' ? 'kg' : 'units');
    const packSize = num(raw.unitPackKg, 1) > 0 ? num(raw.unitPackKg, 1) : 1;
    const cost = Math.max(0, num(raw.costPerPack));
    const found = await client.query(
      'SELECT id, unit_type, unit_pack_size, cost_per_pack, name FROM master_items WHERE lower(name) = lower($1) AND category = $2',
      [name, category]
    );
    let row = found.rows[0];
    if (row) bump(skipped, 'items');
    else {
      const supplier = await ensureSupplier(raw.supplier);
      row = (await client.query(
        `INSERT INTO master_items (name, category, unit_type, unit_pack_size, cost_per_pack, supplier_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, unit_type, unit_pack_size, cost_per_pack, name`,
        [name, category, unitType, packSize, cost, supplier]
      )).rows[0];
      bump(created, 'items');
    }
    if (raw.id) itemId.set(String(raw.id), row);
  };
  for (const raw of list(backup.bakingIngredients)) await importItem(raw, 'Baking');
  for (const raw of list(backup.packagingMaterials)) await importItem(raw, 'Packaging');

  // ---- lots (prototype keeps only the remaining quantity) ----
  const lotByNumber = new Map(); // lot number -> [{ id, item_id }]
  for (const raw of list(backup.lots)) {
    const lotNumber = text(raw?.lotNumber);
    const item = itemId.get(String(raw?.ingredientId));
    if (!lotNumber || !item) { warnings.push(`Skipped lot ${lotNumber || '(no number)'}: its item is not in the backup`); bump(skipped, 'lots'); continue; }
    const remaining = Math.max(0, num(raw.remainingKg));
    const found = await client.query('SELECT id, item_id FROM warehouse_lots WHERE lot_number = $1 AND item_id = $2', [lotNumber, item.id]);
    let lot = found.rows[0];
    if (lot) bump(skipped, 'lots');
    else if (remaining <= 0) {
      warnings.push(`Lot ${lotNumber} was used up in the prototype; recorded with zero stock`);
    }
    if (!lot) {
      // Received quantity is unknown; record what was left (at least one pack so the row is valid).
      const total = remaining > 0 ? remaining : Number(item.unit_pack_size);
      lot = (await client.query(
        `INSERT INTO warehouse_lots (lot_number, item_id, supplier_id, po_number, dock_temp, packs_received,
                                     total_quantity, remaining_quantity, expiry_date, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, CURRENT_DATE)) RETURNING id, item_id`,
        [lotNumber, item.id, await ensureSupplier(raw.supplier), text(raw.poNumber) || null, raw.dockTemp != null ? String(raw.dockTemp) : null,
         ROUND(total / Number(item.unit_pack_size)), total, remaining, toIsoDate(raw.expiryDate), toIsoDate(raw.receivedAt || raw.createdAt)]
      )).rows[0];
      bump(created, 'lots');
    }
    const entries = lotByNumber.get(lotNumber) || [];
    entries.push(lot);
    lotByNumber.set(lotNumber, entries);
  }

  // ---- recipes ----
  const recipeId = new Map(); // prototype id -> uuid
  for (const raw of list(backup.recipes)) {
    const name = text(raw?.name);
    if (!name) continue;
    const found = await client.query('SELECT id FROM recipes WHERE lower(name) = lower($1)', [name]);
    if (found.rows[0]) { recipeId.set(String(raw.id), found.rows[0].id); bump(skipped, 'recipes'); continue; }

    const items = list(raw.items)
      .map(i => ({ item: itemId.get(String(i.ingredientId)), grams: num(i.gramsPerUnit) }))
      .filter(i => i.item && i.grams > 0);
    if (!items.length) { warnings.push(`Skipped recipe ${name}: none of its ingredients are in the backup`); bump(skipped, 'recipes'); continue; }
    const packaging = list(raw.packagingItems)
      .map(p => ({ item: itemId.get(String(p.packagingId)), amount: num(p.amount), assignment: p.assignment || 'bag575', measure: p.measure }))
      .filter(p => p.item && p.amount > 0)
      .map(p => {
        // Measure follows how the material is stocked (DECISIONS.md #28).
        const measure = p.item.unit_type === 'kg' ? 'grams' : 'units';
        if (p.measure && p.measure !== measure) warnings.push(`Recipe ${name}: ${p.item.name} changed from ${p.measure} to ${measure} to match how it is stocked`);
        return { ...p, measure };
      });

    const cost = calculateRecipeCost({
      ingredients: items.map(i => ({ grams_per_batch: i.grams, cost_per_kg: costPerUnit(i.item) })),
      packaging: packaging.map(p => ({ amount: p.amount, measure: p.measure, assignment: p.assignment, cost_per_unit: costPerUnit(p.item) })),
      wastagePercent: num(raw.wastagePercent, 2.5),
      laborCostPerBatch: num(raw.laborCostPerBatch, 150),
      mfgMargin: num(raw.manufacturerMarginPercent, 40),
      distMargin: num(raw.distributorMarginPercent, 20),
      retMargin: num(raw.retailerMarginPercent, 35)
    });
    const { rows } = await client.query(
      `INSERT INTO recipes (name, scale_basis, wastage_percent, labor_cost_per_batch, manufacturer_margin_percent,
         distributor_margin_percent, retailer_margin_percent, total_baking_grams, total_packaging_grams, cost_per_batch,
         dough_cost, bag_material_cost, box_material_cost, shared_material_cost, units_575, units_312,
         cost_per_575g, cost_per_312g, mfg_price_575g, mfg_price_312g, dist_price_575g, dist_price_312g,
         retail_price_575g, retail_price_312g)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
      [name, raw.scaleBasis === 'bin' ? 'bin' : 'batch', num(raw.wastagePercent, 2.5), num(raw.laborCostPerBatch, 150),
       num(raw.manufacturerMarginPercent, 40), num(raw.distributorMarginPercent, 20), num(raw.retailerMarginPercent, 35),
       cost.totalBakingGrams, cost.totalPackagingGrams, cost.totalCost, cost.doughCost, cost.bagMaterialCost,
       cost.boxMaterialCost, cost.sharedMaterialCost, cost.units575, cost.units312, cost.costPer575g, cost.costPer312g,
       cost.mfgPrice575g, cost.mfgPrice312g, cost.distPrice575g, cost.distPrice312g, cost.retailPrice575g, cost.retailPrice312g]
    );
    const id = rows[0].id;
    for (const i of items) {
      await client.query(
        'INSERT INTO recipe_items (recipe_id, item_id, grams_per_batch) VALUES ($1,$2,$3) ON CONFLICT (recipe_id, item_id) DO UPDATE SET grams_per_batch = recipe_items.grams_per_batch + EXCLUDED.grams_per_batch',
        [id, i.item.id, i.grams]
      );
    }
    for (const p of packaging) {
      await client.query(
        `INSERT INTO recipe_packaging_bom (recipe_id, packaging_id, amount, measure, assignment) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (recipe_id, packaging_id, assignment) DO UPDATE SET amount = recipe_packaging_bom.amount + EXCLUDED.amount`,
        [id, p.item.id, p.amount, p.measure, p.assignment]
      );
    }
    recipeId.set(String(raw.id), id);
    bump(created, 'recipes');
  }

  // ---- batches (usage recorded, stock not deducted again) ----
  const batchId = new Map(); // batch number -> uuid
  for (const raw of list(backup.batches)) {
    const number = text(raw?.batchNumber) || text(raw?.id);
    const rid = recipeId.get(String(raw?.recipeId));
    if (!number || !rid) { warnings.push(`Skipped batch ${number || '(no number)'}: its recipe is not in the backup`); bump(skipped, 'batches'); continue; }
    const found = await client.query('SELECT id FROM production_batches WHERE batch_number = $1', [number]);
    if (found.rows[0]) { batchId.set(number, found.rows[0].id); bump(skipped, 'batches'); continue; }

    const recipe = await loadRecipe(client, rid);
    const bins = num(raw.binsCount, 40) > 0 ? num(raw.binsCount, 40) : 40;
    const basis = raw.scaleBasis === 'bin' ? 'bin' : 'batch';
    const pack = raw.packagingBreakdown;
    const counts = pack ? {
      bags_575g: Math.trunc(num(pack.pack575?.bagsCount)), boxes_575g: Math.trunc(num(pack.pack575?.boxesCount)),
      bags_312g: Math.trunc(num(pack.pack312?.bagsCount)), boxes_312g: Math.trunc(num(pack.pack312?.boxesCount))
    } : null;
    const v = yieldVariance(recipe, basis, bins, counts || {});
    const cost = counts ? packagingRequirements(recipe, basis, bins, counts).cost : null;

    const { rows } = await client.query(
      `INSERT INTO production_batches (batch_number, recipe_id, production_date, bins_count, scale_basis, theoretical_dough_grams,
         packaged_weight_grams, variance_delta_grams, bag575_cost, box575_cost, bag312_cost, box312_cost, other_pkg_cost,
         total_pkg_cost, status, packaged_at, status_note)
       VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'Imported from the browser version')
       RETURNING id`,
      [number, rid, toIsoDate(raw.productionDate || raw.createdAt), bins, basis, v.theoretical_dough_grams,
       counts ? v.packaged_weight_grams : 0, counts ? v.variance_delta_grams : 0,
       cost?.bag575 || 0, cost?.box575 || 0, cost?.bag312 || 0, cost?.box312 || 0, cost?.other || 0, cost?.total || 0,
       counts ? 'Completed' : 'In Production', counts ? new Date() : null]
    );
    const id = rows[0].id;
    if (counts) {
      await client.query(
        'INSERT INTO batch_packaging (batch_id, bags_575g, boxes_575g, bags_312g, boxes_312g) VALUES ($1,$2,$3,$4,$5)',
        [id, counts.bags_575g, counts.boxes_575g, counts.bags_312g, counts.boxes_312g]
      );
    }
    for (const [stage, deductions] of [['baking', raw.bakingDeductions], ['packaging', raw.pkgDeductions]]) {
      for (const [lotNumber, qty] of Object.entries(deductions || {})) {
        const lot = (lotByNumber.get(lotNumber) || [])[0];
        if (!lot) { warnings.push(`Batch ${number}: lot ${lotNumber} is not in the backup; its ${stage} usage was not recorded`); continue; }
        if (num(qty) <= 0) continue;
        await client.query(
          `INSERT INTO batch_lot_allocations (batch_id, lot_id, item_id, stage, quantity) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (batch_id, lot_id, stage, item_id) DO UPDATE SET quantity = batch_lot_allocations.quantity + EXCLUDED.quantity`,
          [id, lot.id, lot.item_id, stage, num(qty)]
        );
      }
    }
    batchId.set(number, id);
    bump(created, 'batches');
  }
  if (created.batches) warnings.push(`${created.batches} imported batch(es) are Completed or In Production; QA must release them before they can ship`);

  // ---- shipments: kept for the record, unallocated (format/unit unknown) ----
  for (const raw of list(backup.shippings)) {
    const customer = text(raw?.customer) || text(raw?.customerName);
    const invoice = text(raw?.invoiceNumber) || `IMPORTED-${text(raw?.id) || crypto.randomBytes(3).toString('hex')}`;
    if (!customer) { bump(skipped, 'shipments'); continue; }
    const dup = await client.query(
      "SELECT 1 FROM shipments WHERE invoice_number = $1 AND customer_name = $2 AND source = 'Manual'", [invoice, customer]
    );
    if (dup.rows.length) { bump(skipped, 'shipments'); continue; }
    const s = (await client.query(
      `INSERT INTO shipments (invoice_number, customer_name, shipped_at, source, qbo_sync_status, last_error)
       VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),'Manual','NOT_REQUIRED',$4) RETURNING id`,
      [invoice, customer, toIsoDate(raw.shippedAt), 'Imported from the browser version; product and batch need review']
    )).rows[0];
    const qty = Math.max(1, Math.trunc(num(raw.quantityShipped, 1)));
    await client.query(
      `INSERT INTO shipment_lines (shipment_id, quantity, product_description, allocation_status)
       VALUES ($1,$2,$3,'unallocated')`,
      [s.id, qty, `Imported: ${qty} units from batch ${text(raw.batchId) || 'unknown'}`]
    );
    bump(created, 'shipments');
  }
  if (created.shipments) warnings.push(`${created.shipments} imported shipment(s) are unallocated: the old app did not record pack size or unit, so stock was not reduced`);

  // ---- users: temporary passwords, never the old PINs ----
  for (const raw of list(backup.usersDatabase)) {
    const email = text(raw?.email).toLowerCase();
    if (!email) continue;
    const exists = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
    if (exists.rows.length) { bump(skipped, 'users'); continue; }
    const role = ROLES.includes(raw.role) ? raw.role : 'View-Only Guest';
    if (role !== raw.role) warnings.push(`User ${email}: unknown role "${raw.role}" imported as View-Only Guest`);
    const temp = crypto.randomBytes(9).toString('base64url');
    await client.query(
      `INSERT INTO users (email, password_hash, full_name, role, allowed_menus, force_password_reset)
       VALUES ($1,$2,$3,$4,$5,true)`,
      [email, await hashPassword(temp), text(raw.name) || email, role, list(raw.allowedMenus).filter(m => MENUS.includes(m))]
    );
    temporaryPasswords.push({ email, temporary_password: temp });
    bump(created, 'users');
  }

  return { created, skipped, warnings, temporary_passwords: temporaryPasswords, imported_by: userId };
}

module.exports = { importPrototypeBackup, toIsoDate };
