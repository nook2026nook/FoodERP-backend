const { api, pool, resetDb, userToken } = require('./helpers');
const { syncInvoices } = require('../utils/qboSync');
const { encrypt, decrypt } = require('../utils/crypto');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

let admin; let clerk;
const ids = {};

/** Fake QuickBooks: serves the invoices in `book`, paged like the real query API. */
function fakeQbo(book) {
  return {
    queries: [],
    async query(sql) {
      this.queries.push(sql);
      const start = Number(/STARTPOSITION (\d+)/.exec(sql)[1]);
      const max = Number(/MAXRESULTS (\d+)/.exec(sql)[1]);
      return { Invoice: book.invoices.slice(start - 1, start - 1 + max) };
    },
    async changedInvoices() { return book.changed; }
  };
}

const invoice = (id, lines, extra = {}) => ({
  Id: id, DocNumber: `INV-${id}`, TxnDate: '2026-10-20', TotalAmt: 100,
  CustomerRef: { value: '77', name: 'Whole Foods' },
  Line: [
    ...lines.map((l, i) => ({
      Id: String(i + 1), DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: l.item, name: l.name || `Item ${l.item}` }, Qty: l.qty, UnitPrice: 10 }
    })),
    { DetailType: 'SubTotalLineDetail', Amount: 100 }
  ],
  ...extra
});

async function packedBatch(number, date, boxes, bags) {
  const { rows } = await pool.query(
    `INSERT INTO production_batches (batch_number, recipe_id, production_date, bins_count, status, packaged_at)
     VALUES ($1,$2,$3,2,'Released',NOW()) RETURNING id`, [number, ids.recipe, date]
  );
  await pool.query('INSERT INTO batch_packaging (batch_id, boxes_575g, bags_575g) VALUES ($1,$2,$3)', [rows[0].id, boxes, bags]);
  return rows[0].id;
}

async function lines() {
  const { rows } = await pool.query(
    `SELECT l.qbo_line_id, l.qbo_item_id, l.quantity, l.allocation_status, s.invoice_number
       FROM shipment_lines l JOIN shipments s ON s.id = l.shipment_id ORDER BY s.invoice_number, l.qbo_line_id`
  );
  return rows;
}

async function boxesLeft(batchId) {
  const { rows } = await pool.query("SELECT boxes_on_hand FROM batch_finished_stock WHERE batch_id = $1 AND format = '575g'", [batchId]);
  return Number(rows[0].boxes_on_hand);
}

beforeAll(async () => {
  await resetDb();
  await pool.query('DELETE FROM qbo_auth_tokens');
  await pool.query('DELETE FROM qbo_sync_log');
  admin = await userToken('Administrator');
  clerk = await userToken('Shipping Clerk');
  ids.recipe = (await pool.query("INSERT INTO recipes (name, total_baking_grams) VALUES ('Honey Almond', 6900) RETURNING id")).rows[0].id;
  ids.old = await packedBatch('B-OLD', '2026-10-01', 2, 0);
  ids.new = await packedBatch('B-NEW', '2026-10-10', 5, 0);
  // Item 10 = Honey Almond 575g box. Item 20 is not mapped.
  await pool.query(
    "INSERT INTO qbo_item_map (qbo_item_id, qbo_item_name, recipe_id, format, unit_type) VALUES ('10','Honey Almond 575g Case',$1,'575g','box')",
    [ids.recipe]
  );
  await pool.query(
    `INSERT INTO qbo_auth_tokens (realm_id, access_token_enc, refresh_token_enc, access_token_expires_at, refresh_token_expires_at)
     VALUES ('realm-1',$1,$2,NOW() + INTERVAL '1 hour', NOW() + INTERVAL '100 days')`,
    [encrypt('access'), encrypt('refresh')]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM qbo_auth_tokens');
  await pool.end();
});

test('tokens are stored encrypted', async () => {
  const { rows } = await pool.query('SELECT access_token_enc FROM qbo_auth_tokens');
  expect(rows[0].access_token_enc).not.toContain('access');
  expect(decrypt(rows[0].access_token_enc)).toBe('access');
});

test('first sync: mapped lines allocate FIFO across batches, unmapped lines are kept for review', async () => {
  const book = { invoices: [invoice(1, [{ item: '10', qty: 3 }, { item: '20', qty: 4, name: 'Gift Basket' }])], changed: [] };
  const qbo = fakeQbo(book);
  const summary = await syncInvoices(pool, qbo);
  expect(qbo.queries[0]).toMatch(/^SELECT \* FROM Invoice WHERE TxnDate >= '\d{4}-\d{2}-\d{2}' STARTPOSITION 1 MAXRESULTS 100$/);
  expect(summary).toMatchObject({ invoices: 1, created: 2, unmapped: 1, partial: 0, errors: [] });
  expect(await lines()).toEqual([
    { qbo_line_id: '1', qbo_item_id: '10', quantity: 3, allocation_status: 'allocated', invoice_number: 'INV-1' },
    { qbo_line_id: '2', qbo_item_id: '20', quantity: 4, allocation_status: 'unallocated', invoice_number: 'INV-1' }
  ]);
  expect(await boxesLeft(ids.old)).toBe(0);
  expect(await boxesLeft(ids.new)).toBe(4);
  const { rows } = await pool.query('SELECT last_sync_at FROM qbo_auth_tokens');
  expect(rows[0].last_sync_at).not.toBeNull();
});

test('syncing the same invoices again creates no duplicates (idempotent per line)', async () => {
  const book = { invoices: [], changed: [invoice(1, [{ item: '10', qty: 3 }, { item: '20', qty: 4 }])] };
  const summary = await syncInvoices(pool, fakeQbo(book));
  expect(summary).toMatchObject({ created: 0, skipped: 2 });
  expect(await lines()).toHaveLength(2);
  expect(await boxesLeft(ids.new)).toBe(4);
});

test('more boxes than released stock: allocates what exists and leaves the line partial', async () => {
  const book = { invoices: [], changed: [invoice(2, [{ item: '10', qty: 6 }])] };
  const summary = await syncInvoices(pool, fakeQbo(book));
  expect(summary).toMatchObject({ created: 1, partial: 1 });
  const line = (await lines()).find(l => l.invoice_number === 'INV-2');
  expect(line.allocation_status).toBe('partial');
  expect(await boxesLeft(ids.new)).toBe(0);
});

test('one bad invoice is logged without stopping the others; the clock does not advance', async () => {
  const before = (await pool.query('SELECT last_sync_at FROM qbo_auth_tokens')).rows[0].last_sync_at;
  const bad = invoice(3, [{ item: '10', qty: 1 }], { TxnDate: 'not-a-date' });
  const good = invoice(4, [{ item: '20', qty: 1 }]);
  const summary = await syncInvoices(pool, fakeQbo({ invoices: [], changed: [bad, good] }));
  expect(summary.errors).toHaveLength(1);
  expect(summary.errors[0].invoice).toBe('INV-3');
  expect(summary.created).toBe(1);
  const after = (await pool.query('SELECT last_sync_at FROM qbo_auth_tokens')).rows[0].last_sync_at;
  expect(after).toEqual(before);
});

test('invoices deleted in QuickBooks are removed and their stock returns', async () => {
  const summary = await syncInvoices(pool, fakeQbo({ invoices: [], changed: [{ Id: 2, status: 'Deleted' }] }));
  expect(summary.removed).toBe(1);
  expect(await boxesLeft(ids.new)).toBe(4);
  expect((await lines()).some(l => l.invoice_number === 'INV-2')).toBe(false);
});

test('mapping an item later allocates the lines that were waiting for it', async () => {
  const res = await api().post('/api/qbo/item-mappings').set(auth(admin)).send({
    qbo_item_id: '20', qbo_item_name: 'Gift Basket', recipe_id: ids.recipe, format: '575g', unit_type: 'bag'
  });
  expect(res.status).toBe(201);
  expect(res.body.applied).toEqual({ lines: 2, allocated: 2, still_open: 0 });
  // 4 + 1 bags from B-NEW: one box opened (12 bags), 7 loose bags left
  const { rows } = await pool.query("SELECT boxes_on_hand, bags_on_hand FROM batch_finished_stock WHERE batch_id = $1 AND format = '575g'", [ids.new]);
  expect(rows[0]).toEqual({ boxes_on_hand: 3, bags_on_hand: 7 });
});

test('admin can release and re-allocate a line to a chosen batch', async () => {
  const { rows } = await pool.query("SELECT l.id FROM shipment_lines l JOIN shipments s ON s.id = l.shipment_id WHERE s.invoice_number = 'INV-1' AND l.qbo_line_id = '1'");
  const release = await api().post(`/api/shipments/lines/${rows[0].id}/release`).set(auth(admin));
  expect(release.body.removed).toBe(2);
  expect(await boxesLeft(ids.old)).toBe(2);
  const alloc = await api().post(`/api/shipments/lines/${rows[0].id}/allocate`).set(auth(admin)).send({ batch_id: ids.new });
  expect(alloc.status).toBe(200);
  expect(alloc.body).toMatchObject({ allocated: 3, status: 'allocated' });
  expect(await boxesLeft(ids.old)).toBe(2);
  // B-NEW had 3 boxes; the release returned 1 more, then 3 were taken.
  expect(await boxesLeft(ids.new)).toBe(1);
});

test('status reports the connection; a clerk can see it but cannot change mappings', async () => {
  const status = await api().get('/api/qbo/status').set(auth(clerk));
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ connected: true, realm_id: 'realm-1' });
  expect(status.body.last_sync_summary).toBeTruthy();
  const map = await api().post('/api/qbo/item-mappings').set(auth(clerk)).send({});
  expect(map.status).toBe(403);
});

test('OAuth callback rejects a missing or wrong state', async () => {
  const res = await api().get('/api/qbo/callback').query({ code: 'x', state: 'forged', realmId: '1' });
  expect(res.status).toBe(302);
  expect(res.headers.location).toMatch(/qbo=error/);
});

test('connect-url issues a single-use state', async () => {
  const res = await api().post('/api/qbo/connect-url').set(auth(admin));
  expect(res.status).toBe(200);
  const state = new URL(res.body.url).searchParams.get('state');
  const saved = await pool.query("SELECT value FROM app_settings WHERE key = 'qbo_oauth_state'");
  expect(JSON.parse(saved.rows[0].value).state).toBe(state);
});
