const { api, pool, resetDb, userToken } = require('./helpers');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

let admin; let operator; let qa; let guest;
const ids = {};

async function insertItem(name, category, unitType, packSize) {
  const { rows } = await pool.query(
    `INSERT INTO master_items (name, category, unit_type, unit_pack_size, cost_per_pack, supplier_id)
     VALUES ($1,$2,$3,$4,10,$5) RETURNING id`,
    [name, category, unitType, packSize, ids.supplier]
  );
  return rows[0].id;
}

async function insertLot(lotNumber, itemId, quantity) {
  await pool.query(
    `INSERT INTO warehouse_lots (lot_number, item_id, supplier_id, packs_received, total_quantity, remaining_quantity)
     VALUES ($1,$2,$3,1,$4,$4)`,
    [lotNumber, itemId, ids.supplier, quantity]
  );
}

beforeAll(async () => {
  await resetDb();
  admin = await userToken('Administrator');
  operator = await userToken('Production Operator');
  qa = await userToken('Quality Assurance (QA)');
  guest = await userToken('View-Only Guest');

  ids.supplier = (await pool.query("INSERT INTO suppliers (name) VALUES ('Plan Miller') RETURNING id")).rows[0].id;
  ids.flour = await insertItem('Plan Flour', 'Baking', 'kg', 25);
  ids.oats = await insertItem('Plan Oats', 'Baking', 'kg', 10);
  ids.bag = await insertItem('Plan 575g Bag', 'Packaging', 'units', 1000);
  ids.box = await insertItem('Plan 575g Box', 'Packaging', 'units', 100);
  await insertLot('PF-1', ids.flour, 30);
  await insertLot('PF-2', ids.flour, 50);
  await insertLot('PO-1', ids.oats, 100);
  await insertLot('PB-1', ids.bag, 1000);
  await insertLot('PX-1', ids.box, 100);

  // 20 kg batch: 15 kg flour + 5 kg oats, 2.5% wastage; 1 bag per bag, 1 box per box.
  ids.recipe = (await pool.query(
    `INSERT INTO recipes (name, scale_basis, wastage_percent, total_baking_grams) VALUES ('Plan Granola','batch',2.5,20000) RETURNING id`
  )).rows[0].id;
  await pool.query('INSERT INTO recipe_items (recipe_id, item_id, grams_per_batch) VALUES ($1,$2,15000),($1,$3,5000)',
    [ids.recipe, ids.flour, ids.oats]);
  await pool.query(
    `INSERT INTO recipe_packaging_bom (recipe_id, packaging_id, amount, measure, assignment)
     VALUES ($1,$2,1,'units','bag575'),($1,$3,1,'units','box575')`, [ids.recipe, ids.bag, ids.box]);

  // 10 released 575g boxes on hand.
  const batch = (await pool.query(
    `INSERT INTO production_batches (batch_number, recipe_id, bins_count, status) VALUES ('PLAN-1',$1,2,'Released') RETURNING id`,
    [ids.recipe]
  )).rows[0].id;
  await pool.query('INSERT INTO batch_packaging (batch_id, boxes_575g) VALUES ($1,10)', [batch]);
});

afterAll(async () => {
  await pool.end();
});

const lines = () => [
  { recipe_id: ids.recipe, pack_size: '575', boxes_ordered: 50 },
  { recipe_id: ids.recipe, pack_size: '575', boxes_ordered: 5 }
];

describe('calculate', () => {
  test('nets released boxes once, rounds up to whole batches and flags shortages', async () => {
    const res = await api().post('/api/planning/calculate').set(auth(operator)).send({ deduct_inventory: true, lines: lines() });
    expect(res.status).toBe(200);
    // Stock is shared across lines of the same flavor/format: the second line gets none.
    expect(res.body.lines.map(l => [l.system_stock_boxes, l.in_stock_boxes, l.net_boxes])).toEqual([[10, 10, 40], [10, 0, 5]]);

    const f = res.body.flavors[0];
    expect(f).toMatchObject({
      net_boxes_575g: 45, net_bags: 540, net_kg: 310.5, gross_kg: 318.4615,
      scheduled_batches: 16, scheduled_bins: 32, bins_large: 32, bins_small: 0, batch_size_kg: 20
    });
    const flour = f.ingredients.find(i => i.item_id === ids.flour);
    expect(flour).toMatchObject({ required: 240, available: 80, shortage: 160, short: true });
    expect(f.ingredients.find(i => i.item_id === ids.oats)).toMatchObject({ required: 80, available: 100, short: false });
    expect(f.packaging.find(p => p.item_id === ids.bag)).toMatchObject({ required: 540, available: 1000, short: false });
    expect(f.packaging.find(p => p.item_id === ids.box)).toMatchObject({ required: 45, available: 100, short: false });
    expect(res.body.totals).toMatchObject({ scheduled_batches: 16, scheduled_bins: 32, net_boxes: 45, shortages: 1 });
  });

  test('a typed in-stock value overrides the system count; offset can be turned off', async () => {
    const override = await api().post('/api/planning/calculate').set(auth(operator)).send({
      lines: [{ recipe_id: ids.recipe, pack_size: '575', boxes_ordered: 50, in_stock_override: 0 }]
    });
    expect(override.body.lines[0]).toMatchObject({ system_stock_boxes: 10, in_stock_boxes: 0, net_boxes: 50 });

    const off = await api().post('/api/planning/calculate').set(auth(operator)).send({ deduct_inventory: false, lines: lines() });
    expect(off.body.totals.net_boxes).toBe(55);
  });

  test('orders covered by stock schedule nothing', async () => {
    const res = await api().post('/api/planning/calculate').set(auth(operator)).send({
      lines: [{ recipe_id: ids.recipe, pack_size: '575', boxes_ordered: 8 }]
    });
    expect(res.body.flavors[0]).toMatchObject({ net_boxes_575g: 0, scheduled_batches: 0, scheduled_bins: 0, ingredients: [] });
  });
});

describe('access', () => {
  test('anyone who can open Production gets Planning; guests do not', async () => {
    expect((await api().post('/api/planning/calculate').set(auth(qa)).send({ lines: lines() })).status).toBe(200);
    expect((await api().post('/api/planning/calculate').set(auth(guest)).send({ lines: lines() })).status).toBe(403);
    expect((await api().get('/api/recipes/options').set(auth(operator))).status).toBe(200);
  });

  test('QA can calculate but not save plans', async () => {
    const res = await api().post('/api/planning/plans').set(auth(qa)).send({ title: 'QA plan', order_lines: lines() });
    expect(res.status).toBe(403);
  });
});

describe('saved plans', () => {
  let planId;

  test('save, list and update a draft', async () => {
    const created = await api().post('/api/planning/plans').set(auth(operator)).send({
      title: 'Sobeys weekly', customer_name: 'Sobeys', po_number: 'PO-1', delivery_date: '2026-11-20', order_lines: lines()
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Sobeys weekly', status: 'Draft', delivery_date: '2026-11-20' });
    planId = created.body.id;

    const list = await api().get('/api/planning/plans').set(auth(qa));
    expect(list.body.map(p => p.id)).toContain(planId);

    const updated = await api().put(`/api/planning/plans/${planId}`).set(auth(operator)).send({
      title: 'Sobeys weekly', order_lines: [lines()[0]]
    });
    expect(updated.status).toBe(200);
    expect(updated.body.order_lines).toHaveLength(1);
  });

  test('a finalized plan is locked until it is put back to Draft', async () => {
    const fin = await api().put(`/api/planning/plans/${planId}`).set(auth(operator)).send({
      title: 'Sobeys weekly', order_lines: [lines()[0]], status: 'Finalized'
    });
    expect(fin.body.status).toBe('Finalized');

    const blocked = await api().put(`/api/planning/plans/${planId}`).set(auth(operator)).send({
      title: 'Changed', order_lines: lines(), status: 'Finalized'
    });
    expect(blocked.status).toBe(409);

    // Unfinalizing keeps the finalized content; edits come after.
    const back = await api().put(`/api/planning/plans/${planId}`).set(auth(operator)).send({
      title: 'Changed', order_lines: lines(), status: 'Draft'
    });
    expect(back.body).toMatchObject({ status: 'Draft', title: 'Sobeys weekly' });
    expect(back.body.order_lines).toHaveLength(1);
  });

  test('delete', async () => {
    expect((await api().delete(`/api/planning/plans/${planId}`).set(auth(admin))).status).toBe(200);
    expect((await api().delete(`/api/planning/plans/${planId}`).set(auth(admin))).status).toBe(404);
  });
});
