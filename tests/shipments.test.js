const { api, pool, resetDb, userToken } = require('./helpers');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

let admin; let clerk; let guest;
const ids = {};

/**
 * Insert a packed batch directly (production itself is covered in batches.test.js).
 * 575g only: `boxes` full boxes and `bags` loose bags.
 */
async function packedBatch(number, date, status, boxes, bags) {
  const { rows } = await pool.query(
    `INSERT INTO production_batches (batch_number, recipe_id, production_date, bins_count, status, packaged_at)
     VALUES ($1,$2,$3,2,$4,NOW()) RETURNING id`,
    [number, ids.recipe, date, status]
  );
  await pool.query(
    'INSERT INTO batch_packaging (batch_id, boxes_575g, bags_575g) VALUES ($1,$2,$3)',
    [rows[0].id, boxes, bags]
  );
  return rows[0].id;
}

async function batchStock(batchId) {
  const { rows } = await pool.query(
    "SELECT boxes_on_hand, bags_on_hand FROM batch_finished_stock WHERE batch_id = $1 AND format = '575g'", [batchId]
  );
  return { boxes: Number(rows[0].boxes_on_hand), bags: Number(rows[0].bags_on_hand) };
}

async function status(batchId) {
  const { rows } = await pool.query('SELECT status FROM production_batches WHERE id = $1', [batchId]);
  return rows[0].status;
}

const ship = (token, lines, extra = {}) => api().post('/api/shipments').set(auth(token)).send({
  customer_name: 'Whole Foods', invoice_number: 'INV-1', shipped_at: '2026-10-22', lines, ...extra
});

beforeAll(async () => {
  await resetDb();
  admin = await userToken('Administrator');
  clerk = await userToken('Shipping Clerk');
  guest = await userToken('View-Only Guest');
  ids.recipe = (await pool.query(
    "INSERT INTO recipes (name, total_baking_grams, cost_per_575g, cost_per_312g) VALUES ('Honey Almond', 15000, 5, 3) RETURNING id"
  )).rows[0].id;
  ids.old = await packedBatch('B-OLD', '2026-10-01', 'Released', 2, 5);
  ids.new = await packedBatch('B-NEW', '2026-10-10', 'Released', 3, 0);
  ids.held = await packedBatch('B-HELD', '2026-09-01', 'Quality Hold', 10, 0);
});

afterAll(async () => {
  await pool.end();
});

test('ready-to-ship counts only released stock and values boxes as bag x 12 + outer box', async () => {
  const res = await api().get('/api/inventory/ready-to-ship').set(auth(guest));
  expect(res.status).toBe(200);
  const f = res.body.products[0].formats['575g'];
  expect(f).toMatchObject({ boxes: 5, bags: 5, awaiting_qa_boxes: 10, box_cost: 60 });
  expect(res.body.total_value).toBe(5 * 60 + 5 * 5);
});

test('a guest cannot record shipments', async () => {
  const res = await ship(guest, [{ recipe_id: ids.recipe, format: '575g', unit_type: 'box', quantity: 1 }]);
  expect(res.status).toBe(403);
});

test('boxes ship oldest released batch first, skipping batches on QA hold', async () => {
  const res = await ship(clerk, [{ recipe_id: ids.recipe, format: '575g', unit_type: 'box', quantity: 3 }]);
  expect(res.status).toBe(201);
  const allocs = res.body.lines[0].allocations.map(a => [a.batch_number, a.boxes]);
  expect(allocs).toEqual([['B-NEW', 1], ['B-OLD', 2]]);
  expect(await batchStock(ids.old)).toEqual({ boxes: 0, bags: 5 });
  expect(await batchStock(ids.held)).toEqual({ boxes: 10, bags: 0 });
  expect(await status(ids.new)).toBe('Partially Shipped');
  ids.firstShipment = res.body.id;
});

test('bags use loose bags first, then open a box automatically', async () => {
  const res = await ship(clerk, [{ recipe_id: ids.recipe, format: '575g', unit_type: 'bag', quantity: 8, batch_id: ids.new }]);
  expect(res.status).toBe(201);
  expect(res.body.lines[0].allocations[0]).toMatchObject({ batch_number: 'B-NEW', bags: 8, method: 'manual' });
  // B-NEW had 2 boxes left, no loose bags: one box opened -> 1 box + 4 bags left
  expect(await batchStock(ids.new)).toEqual({ boxes: 1, bags: 4 });
});

test('not enough released stock blocks the whole shipment', async () => {
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM shipments');
  const res = await ship(clerk, [
    { recipe_id: ids.recipe, format: '575g', unit_type: 'bag', quantity: 1 },
    { recipe_id: ids.recipe, format: '575g', unit_type: 'box', quantity: 5 }
  ]);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe('Honey Almond 575g: only 1 boxes are released and in stock; 5 requested');
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM shipments');
  expect(after.rows[0].n).toBe(before.rows[0].n);
});

test('shipping everything marks the batch Fully Shipped', async () => {
  const res = await ship(clerk, [{ recipe_id: ids.recipe, format: '575g', unit_type: 'bag', quantity: 5, batch_id: ids.old }]);
  expect(res.status).toBe(201);
  expect(await status(ids.old)).toBe('Fully Shipped');
});

test('deleting a shipment returns its stock and status', async () => {
  const res = await api().delete(`/api/shipments/${ids.firstShipment}`).set(auth(clerk));
  expect(res.status).toBe(200);
  expect(await batchStock(ids.old)).toEqual({ boxes: 2, bags: 0 });
  expect(await status(ids.old)).toBe('Partially Shipped');
});

test('open-box turns full boxes into loose bags', async () => {
  const res = await api().post('/api/inventory/open-box').set(auth(clerk)).send({ batch_id: ids.old, format: '575g', boxes: 1 });
  expect(res.status).toBe(200);
  expect(await batchStock(ids.old)).toEqual({ boxes: 1, bags: 12 });
  const tooMany = await api().post('/api/inventory/open-box').set(auth(clerk)).send({ batch_id: ids.old, format: '575g', boxes: 5 });
  expect(tooMany.status).toBe(409);
});

test('a batch with shipments cannot be deleted', async () => {
  const res = await api().delete(`/api/batches/${ids.new}`).set(auth(admin));
  expect(res.status).toBe(409);
});
