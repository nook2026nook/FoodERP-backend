const { api, pool, resetDb, userToken } = require('./helpers');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

let admin; let qa; let clerk; let guest;
const ids = {};

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

/** A packed, released batch that used `lotId` for baking. */
async function batchUsingLot(number, lotId, kg, deltaGrams) {
  const b = await one(
    `INSERT INTO production_batches (batch_number, recipe_id, production_date, bins_count, status, packaged_at,
                                     theoretical_dough_grams, packaged_weight_grams, variance_delta_grams, total_pkg_cost)
     VALUES ($1,$2,CURRENT_DATE,2,'Released',NOW(),6900,$3,$4,2.5) RETURNING id`,
    [number, ids.recipe, 6900 + deltaGrams, deltaGrams]
  );
  await pool.query('INSERT INTO batch_packaging (batch_id, boxes_575g, bags_575g) VALUES ($1,1,0)', [b.id]);
  await pool.query(
    `INSERT INTO batch_lot_allocations (batch_id, lot_id, item_id, stage, quantity) VALUES ($1,$2,$3,'baking',$4)`,
    [b.id, lotId, ids.flour, kg]
  );
  return b.id;
}

beforeAll(async () => {
  await resetDb();
  admin = await userToken('Administrator');
  qa = await userToken('Quality Assurance (QA)');
  clerk = await userToken('Shipping Clerk');
  guest = await userToken('View-Only Guest');

  ids.supplier = (await one("INSERT INTO suppliers (name) VALUES ('Approved Miller') RETURNING id")).id;
  ids.flour = (await one(
    "INSERT INTO master_items (name, category, unit_type, unit_pack_size, cost_per_pack, supplier_id) VALUES ('Flour','Baking','kg',25,25,$1) RETURNING id",
    [ids.supplier]
  )).id;
  ids.lot = (await one(
    `INSERT INTO warehouse_lots (lot_number, item_id, supplier_id, packs_received, total_quantity, remaining_quantity, received_at)
     VALUES ('FL-42',$1,$2,4,100,80,'2026-10-01') RETURNING id`, [ids.flour, ids.supplier]
  )).id;
  ids.recipe = (await one("INSERT INTO recipes (name, total_baking_grams) VALUES ('Honey Almond', 6900) RETURNING id")).id;

  ids.b1 = await batchUsingLot('B-1', ids.lot, 10, 20);    // balanced
  ids.b2 = await batchUsingLot('B-2', ids.lot, 10, -400);  // scrap

  const res = await api().post('/api/shipments').set(auth(clerk)).send({
    customer_name: 'Whole Foods', invoice_number: 'INV-77',
    lines: [{ recipe_id: ids.recipe, format: '575g', unit_type: 'box', quantity: 1, batch_id: ids.b1 }]
  });
  expect(res.status).toBe(201);
});

afterAll(async () => {
  await pool.end();
});

describe('recall', () => {
  test('a shipping clerk can run a recall', async () => {
    const res = await api().get('/api/recall/batch/B-1').set(auth(clerk));
    expect(res.status).toBe(200);
  });

  test('a guest cannot open the recall dossier', async () => {
    const res = await api().get('/api/recall/batch/B-1').set(auth(guest));
    expect(res.status).toBe(403);
  });

  test('by batch: lots upstream, customers downstream, stock still on hand', async () => {
    const res = await api().get('/api/recall/batch/B-1').set(auth(qa));
    expect(res.body.batch.recipe_name).toBe('Honey Almond');
    expect(res.body.upstream_lots).toEqual([expect.objectContaining({ lot_number: 'FL-42', supplier_name: 'Approved Miller', stage: 'baking' })]);
    expect(res.body.shipments).toEqual([expect.objectContaining({ customer_name: 'Whole Foods', invoice_number: 'INV-77', boxes: 1 })]);
    expect(res.body.summary.customers).toEqual(['Whole Foods']);
    expect(res.body.on_hand).toEqual([]);
  });

  test('by lot: every batch that used it, with the customers and unshipped stock', async () => {
    const res = await api().get('/api/recall/lot/FL-42').set(auth(qa));
    expect(res.status).toBe(200);
    expect(res.body.lots[0]).toMatchObject({ item_name: 'Flour', supplier_name: 'Approved Miller' });
    expect(res.body.batches.map(b => b.batch_number)).toEqual(['B-1', 'B-2']);
    expect(res.body.shipments.map(s => s.batch_number)).toEqual(['B-1']);
    expect(res.body.on_hand).toEqual([expect.objectContaining({ batch_number: 'B-2', boxes_on_hand: 1 })]);
  });

  test('unknown numbers return 404', async () => {
    expect((await api().get('/api/recall/lot/NOPE').set(auth(qa))).status).toBe(404);
    expect((await api().get('/api/recall/batch/NOPE').set(auth(qa))).status).toBe(404);
  });

  test('search finds lots and batches', async () => {
    const res = await api().get('/api/recall/search').query({ q: 'B-' }).set(auth(qa));
    expect(res.body.batches).toEqual(['B-1', 'B-2']);
  });
});

describe('reports', () => {
  test('shipment report lists lines with product and batches', async () => {
    const res = await api().get('/api/reports/shipments').query({ timeframe: 'daily' }).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([expect.objectContaining({
      customer_name: 'Whole Foods', product_description: 'Honey Almond 575g', batches: 'B-1', quantity: 1, unit_type: 'box'
    })]);
    expect(res.body.summary).toMatchObject({ shipments: 1, customers: 1, total_bags: 12 });
  });

  test('wastage log classifies variance with the ±50 g rule', async () => {
    const res = await api().get('/api/reports/wastage').set(auth(qa));
    expect(res.status).toBe(200);
    const status = Object.fromEntries(res.body.batches.map(b => [b.batch_number, b.variance_status]));
    expect(status).toEqual({ 'B-1': 'Balanced', 'B-2': 'Scrap / Loss' });
    expect(res.body.summary).toMatchObject({ batches: 2, balanced: 1, scrap: 1, scrap_grams: -400 });
  });

  test('raw material value uses remaining lot stock', async () => {
    const res = await api().get('/api/reports/inventory-value').set(auth(admin));
    expect(res.body).toMatchObject({ Baking: 80, total: 80 });
  });
});
