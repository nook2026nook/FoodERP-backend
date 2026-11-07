/**
 * Convert the server export tables into the localStorage shape used by the
 * single-file browser app (bakingIngredients, packagingMaterials, suppliers,
 * lots, recipes, batches, shippings). That app's "Restore"
 * only reads those top-level keys, so the export carries them alongside the
 * raw tables and the same file restores in both places.
 *
 * Lossy by nature: the browser app has no QA statuses, shipment formats or
 * passwords. Users are left out on purpose: server accounts have no PIN, so
 * restoring them would lock everyone out of the browser app.
 */
const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const isoDate = (v) => {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const groupBy = (rows, key) => {
  const map = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
};

function toPrototypeBackup(data) {
  const supplierName = new Map(data.suppliers.map(s => [s.id, s.name]));
  const items = new Map(data.master_items.map(i => [i.id, i]));
  const lots = new Map(data.warehouse_lots.map(l => [l.id, l]));
  const recipes = new Map(data.recipes.map(r => [r.id, r]));
  const batches = new Map(data.production_batches.map(b => [b.id, b]));

  const item = (i) => ({
    id: i.id,
    itemCode: i.item_code || '',
    name: i.name,
    unitType: i.unit_type,
    unitPackKg: n(i.unit_pack_size),
    costPerPack: n(i.cost_per_pack),
    supplier: supplierName.get(i.supplier_id) || '',
    category: i.category
  });
  const bakingIngredients = data.master_items.filter(i => i.category === 'Baking').map(item);
  const packagingMaterials = data.master_items.filter(i => i.category === 'Packaging').map(item);

  const protoLots = data.warehouse_lots.map(l => {
    const i = items.get(l.item_id) || {};
    return {
      id: l.id,
      lotNumber: l.lot_number,
      ingredientId: l.item_id,
      ingredientName: i.name || '',
      category: i.category || '',
      supplier: supplierName.get(l.supplier_id) || '',
      poNumber: l.po_number || '',
      dockTemp: l.dock_temp || '',
      packsReceived: n(l.packs_received),
      initialKg: n(l.total_quantity),
      remainingKg: n(l.remaining_quantity),
      receivedDate: isoDate(l.received_at),
      expiryDate: isoDate(l.expiry_date),
      specDocName: l.spec_doc_name || '',
      specDocSize: l.spec_doc_size || '',
      createdAt: isoDate(l.received_at || l.created_at)
    };
  });

  const recipeItems = groupBy(data.recipe_items, 'recipe_id');
  const recipeBom = groupBy(data.recipe_packaging_bom, 'recipe_id');
  const protoRecipes = data.recipes.map(r => ({
    id: r.id,
    name: r.name,
    scaleBasis: r.scale_basis,
    wastagePercent: n(r.wastage_percent),
    laborCostPerBatch: n(r.labor_cost_per_batch),
    manufacturerMarginPercent: n(r.manufacturer_margin_percent),
    distributorMarginPercent: n(r.distributor_margin_percent),
    retailerMarginPercent: n(r.retailer_margin_percent),
    totalBakingGrams: n(r.total_baking_grams),
    costPerBatch: n(r.cost_per_batch),
    costPer575g: n(r.cost_per_575g),
    costPer312g: n(r.cost_per_312g),
    mfgPrice575: n(r.mfg_price_575g),
    mfgPrice312: n(r.mfg_price_312g),
    distPrice575: n(r.dist_price_575g),
    distPrice312: n(r.dist_price_312g),
    retPrice575: n(r.retail_price_575g),
    retPrice312: n(r.retail_price_312g),
    items: (recipeItems.get(r.id) || []).map(ri => ({
      ingredientId: ri.item_id,
      ingredientName: items.get(ri.item_id)?.name || 'Unknown',
      gramsPerUnit: n(ri.grams_per_batch)
    })),
    packagingItems: (recipeBom.get(r.id) || []).map(p => ({
      packagingId: p.packaging_id,
      packagingName: items.get(p.packaging_id)?.name || 'Unknown',
      amount: n(p.amount),
      measure: p.measure,
      assignment: p.assignment
    }))
  }));

  const allocations = groupBy(data.batch_lot_allocations, 'batch_id');
  const packaging = new Map(data.batch_packaging.map(p => [p.batch_id, p]));
  const protoBatches = data.production_batches.map(b => {
    const splits = { baking: {}, packaging: {} };
    const deductions = { baking: {}, packaging: {} };
    for (const a of allocations.get(b.id) || []) {
      const lotNumber = lots.get(a.lot_id)?.lot_number || '';
      const qty = n(a.quantity);
      (splits[a.stage][a.item_id] ||= []).push({ lotNumber, kg: qty.toFixed(3) });
      deductions[a.stage][lotNumber] = (deductions[a.stage][lotNumber] || 0) + qty;
    }
    const pack = packaging.get(b.id);
    const bins = n(b.bins_count);
    const bakingEmployees = Array.isArray(b.baking_employees) ? b.baking_employees : [];
    const packagingEmployees = Array.isArray(b.packaging_employees) ? b.packaging_employees : [];
    const recipe = recipes.get(b.recipe_id);
    return {
      id: b.id,
      batchNumber: b.batch_number,
      productionDate: isoDate(b.production_date),
      bakingEmployees,
      employeeName: bakingEmployees.join(', '),
      recipeId: b.recipe_id,
      recipeName: recipe?.name || '',
      scaleBasis: b.scale_basis,
      binsLargeBoxesBags: n(b.bins_large_count),
      binsSmallBoxesBags: n(b.bins_small_count),
      binsCount: bins,
      batchesCount: bins / 2,
      bakingLotSplits: splits.baking,
      bakingDeductions: deductions.baking,
      packagingLotSplits: splits.packaging,
      pkgDeductions: deductions.packaging,
      packagingBreakdown: pack ? {
        pack575: { boxesCount: n(pack.boxes_575g), bagsCount: n(pack.bags_575g) },
        pack312: { boxesCount: n(pack.boxes_312g), bagsCount: n(pack.bags_312g) }
      } : null,
      actualPackagingCost: {
        bag575: n(b.bag575_cost), box575: n(b.box575_cost),
        bag312: n(b.bag312_cost), box312: n(b.box312_cost),
        other: n(b.other_pkg_cost), total: n(b.total_pkg_cost)
      },
      packagingDate: isoDate(b.packaging_date),
      packagingEmployees,
      packagingEmployeeName: packagingEmployees.join(', '),
      // The browser app only knows these two states.
      status: pack ? 'Fully Packaged & Dispatched' : 'Baked (Awaiting Packaging)',
      serverStatus: b.status,
      createdAt: isoDate(b.production_date || b.created_at)
    };
  });

  // One browser-app shipping row per batch a line was shipped from.
  // The browser app counts quantity in bags (12 bags per box).
  const lineAllocations = groupBy(data.shipment_allocations, 'line_id');
  const shipmentLines = groupBy(data.shipment_lines, 'shipment_id');
  const shippings = [];
  for (const s of data.shipments) {
    for (const line of shipmentLines.get(s.id) || []) {
      const parts = (lineAllocations.get(line.id) || []).map(a => ({
        batchId: a.batch_id, bags: n(a.boxes) * 12 + n(a.bags)
      }));
      if (!parts.length) {
        parts.push({ batchId: line.batch_id || null, bags: line.unit_type === 'box' ? n(line.quantity) * 12 : n(line.quantity) });
      }
      parts.forEach((p, idx) => {
        const batch = batches.get(p.batchId);
        shippings.push({
          id: parts.length > 1 ? `${line.id}-${idx + 1}` : line.id,
          customer: s.customer_name,
          invoiceNumber: s.invoice_number,
          batchId: batch?.batch_number || '',
          batchRunId: p.batchId || '',
          productName: recipes.get(batch?.recipe_id || line.recipe_id)?.name || line.product_description || '',
          format: line.format || '',
          quantityShipped: p.bags,
          unitPrice: line.unit_price === null || line.unit_price === undefined ? null : n(line.unit_price),
          shippedDate: isoDate(s.shipped_at),
          shippedAt: isoDate(s.shipped_at),
          qbSynced: s.qbo_sync_status === 'SYNCED',
          qbSyncedAt: null
        });
      });
    }
  }

  return {
    suppliers: data.suppliers.map(s => s.name),
    bakingIngredients,
    packagingMaterials,
    lots: protoLots,
    recipes: protoRecipes,
    batches: protoBatches,
    shippings
  };
}

module.exports = { toPrototypeBackup };
