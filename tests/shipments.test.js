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

test('an administrator can set the counted boxes and bags on hand; others cannot', async () => {
  const batch = await packedBatch('B-COUNT', '2026-10-25', 'Released', 10, 3);
  const set = (token, body) => api().post('/api/inventory/set-stock').set(auth(token)).send({ batch_id: batch, format: '575g', ...body });

  expect((await set(clerk, { boxes: 7, bags: 0 })).status).toBe(403);
  const res = await set(admin, { boxes: 7, bags: 5 });
  expect(res.status).toBe(200);
  expect(await batchStock(batch)).toEqual({ boxes: 7, bags: 5 });
  const adj = await pool.query("SELECT box_delta, bag_delta, reason FROM inventory_adjustments WHERE batch_id = $1", [batch]);
  expect(adj.rows).toEqual([{ box_delta: -3, bag_delta: 2, reason: 'manual_count' }]);

  // Same numbers again: nothing new recorded. Negative counts are refused.
  await set(admin, { boxes: 7, bags: 5 });
  expect((await pool.query('SELECT 1 FROM inventory_adjustments WHERE batch_id = $1', [batch])).rowCount).toBe(1);
  expect((await set(admin, { boxes: -1, bags: 0 })).status).toBe(400);

  // Counted to zero: hidden from shipping's stock list, still listed for Ready to Ship so it can be edited back.
  await set(admin, { boxes: 0, bags: 0 });
  const ids = async (query) => (await api().get(`/api/inventory/batches${query}`).set(auth(admin))).body
    .filter((r) => r.batch_id === batch).map((r) => r.format);
  expect(await ids('')).toEqual([]);
  expect(await ids('?include_empty=true')).toEqual(['575g', '312g']);
});

describe('mapping an invoice line to a batch', () => {
  async function qboLine(invoice, qboItemId, quantity) {
    const s = await pool.query(
      `INSERT INTO shipments (invoice_number, customer_name, shipped_at, source, qbo_invoice_id)
       VALUES ($1,'Newport Gourmet','2026-11-04','QuickBooks API',$2) RETURNING id`, [invoice, `qbo-${invoice}`]
    );
    const l = await pool.query(
      `INSERT INTO shipment_lines (shipment_id, quantity, qbo_line_id, qbo_item_id, product_description)
       VALUES ($1,$2,'1',$3,'575 Case:Honey Almond 575 Grams') RETURNING id`, [s.rows[0].id, quantity, qboItemId]
    );
    return l.rows[0].id;
  }

  test('an unmapped QuickBooks line maps to the chosen batch and the item is remembered', async () => {
    const batch = await packedBatch('B-MAP', '2026-10-20', 'Released', 6, 0);
    const first = await qboLine('298484', 'ITEM-77', 4);
    const second = await qboLine('298485', 'ITEM-77', 1);

    const res = await api().put(`/api/shipments/lines/${first}/batch`).set(auth(admin))
      .send({ batch_id: batch, format: '575g' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'allocated', batch_number: 'B-MAP', remembered: true });

    const allocs = await pool.query('SELECT batch_id, boxes FROM shipment_allocations WHERE line_id = $1', [first]);
    expect(allocs.rows).toEqual([{ batch_id: batch, boxes: 4 }]);
    const map = await pool.query("SELECT recipe_id, format, unit_type FROM qbo_item_map WHERE qbo_item_id = 'ITEM-77'");
    expect(map.rows[0]).toEqual({ recipe_id: ids.recipe, format: '575g', unit_type: 'box' });
    const other = await pool.query('SELECT recipe_id, allocation_status FROM shipment_lines WHERE id = $1', [second]);
    expect(other.rows[0]).toEqual({ recipe_id: ids.recipe, allocation_status: 'allocated' });
  });

  test('re-mapping moves the line to another batch and returns the stock', async () => {
    const a = await packedBatch('B-REMAP-A', '2026-10-21', 'Released', 3, 0);
    const b = await packedBatch('B-REMAP-B', '2026-10-22', 'Released', 3, 0);
    const line = await qboLine('298486', 'ITEM-78', 2);
    expect((await api().put(`/api/shipments/lines/${line}/batch`).set(auth(clerk)).send({ batch_id: a, format: '575g' })).status).toBe(200);
    expect(await batchStock(a)).toEqual({ boxes: 1, bags: 0 });
    const res = await api().put(`/api/shipments/lines/${line}/batch`).set(auth(clerk)).send({ batch_id: b, format: '575g' });
    expect(res.status).toBe(200);
    expect(res.body.remembered).toBe(false); // only an Administrator saves item mappings
    expect(await batchStock(a)).toEqual({ boxes: 3, bags: 0 });
    expect(await batchStock(b)).toEqual({ boxes: 1, bags: 0 });
  });

  test('a batch without released stock is refused and nothing changes', async () => {
    const held = await packedBatch('B-MAP-HOLD', '2026-10-23', 'Quality Hold', 5, 0);
    const line = await qboLine('298487', 'ITEM-79', 1);
    const res = await api().put(`/api/shipments/lines/${line}/batch`).set(auth(admin)).send({ batch_id: held, format: '575g' });
    expect(res.status).toBe(409);
    const l = await pool.query('SELECT recipe_id, allocation_status FROM shipment_lines WHERE id = $1', [line]);
    expect(l.rows[0]).toEqual({ recipe_id: null, allocation_status: 'unallocated' });
  });

  test('a line with a known flavor cannot be mapped to another flavor or size (invoice 10587)', async () => {
    const other = (await pool.query("INSERT INTO recipes (name, total_baking_grams) VALUES ('Simply Almond', 15000) RETURNING id")).rows[0].id;
    const otherBatch = (await pool.query(
      `INSERT INTO production_batches (batch_number, recipe_id, bins_count, status, packaged_at) VALUES ('B-SA',$1,2,'Released',NOW()) RETURNING id`, [other]
    )).rows[0].id;
    await pool.query('INSERT INTO batch_packaging (batch_id, boxes_575g) VALUES ($1,10)', [otherBatch]);
    const own = await packedBatch('B-OWN', '2026-10-24', 'Released', 5, 0);
    const line = await qboLine('298490', 'ITEM-81', 2);
    await pool.query("UPDATE shipment_lines SET recipe_id = $1, format = '575g', unit_type = 'box' WHERE id = $2", [ids.recipe, line]);

    const wrongFlavor = await api().put(`/api/shipments/lines/${line}/batch`).set(auth(admin)).send({ batch_id: otherBatch, format: '575g' });
    expect(wrongFlavor.status).toBe(409);
    expect(wrongFlavor.body.error).toMatch(/Honey Almond/);
    const wrongSize = await api().put(`/api/shipments/lines/${line}/batch`).set(auth(admin)).send({ batch_id: own, format: '312g' });
    expect(wrongSize.status).toBe(409);

    const l = await pool.query('SELECT recipe_id, format, allocation_status FROM shipment_lines WHERE id = $1', [line]);
    expect(l.rows[0]).toEqual({ recipe_id: ids.recipe, format: '575g', allocation_status: 'unallocated' });
    expect(await pool.query('SELECT 1 FROM shipment_allocations WHERE batch_id = $1', [otherBatch])).toMatchObject({ rowCount: 0 });

    const right = await api().put(`/api/shipments/lines/${line}/batch`).set(auth(admin)).send({ batch_id: own, format: '575g' });
    expect(right.status).toBe(200);
  });

  test('invoice lines are listed in QuickBooks line order', async () => {
    const s = await pool.query(
      `INSERT INTO shipments (invoice_number, customer_name, shipped_at, source, qbo_invoice_id)
       VALUES ('298491','Newport Gourmet','2026-11-05','QuickBooks API','qbo-298491') RETURNING id`
    );
    for (const n of ['10', '2', '9', '1']) {
      await pool.query(
        `INSERT INTO shipment_lines (shipment_id, quantity, qbo_line_id, product_description) VALUES ($1,1,$2,$3)`,
        [s.rows[0].id, n, `Line ${n}`]
      );
    }
    const res = await api().get('/api/shipments').set(auth(admin));
    const inv = res.body.find((x) => x.invoice_number === '298491');
    expect(inv.lines.map((l) => l.qbo_line_id)).toEqual(['1', '2', '9', '10']);
  });

  test('a guest cannot map batches', async () => {
    const line = await qboLine('298488', 'ITEM-80', 1);
    const res = await api().put(`/api/shipments/lines/${line}/batch`).set(auth(guest)).send({ batch_id: ids.new, format: '575g' });
    expect(res.status).toBe(403);
  });
});
