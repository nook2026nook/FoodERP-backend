const { api, pool, resetDb, userToken } = require('./helpers');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

let admin; let operator; let supplierId;

beforeAll(async () => {
  await resetDb();
  admin = await userToken('Administrator');
  operator = await userToken('Production Operator');
  supplierId = (await pool.query("INSERT INTO suppliers (name) VALUES ('Code Miller') RETURNING id")).rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

const newItem = (token, name, category, unit_type) =>
  api().post('/api/items').set(auth(token)).send({
    name, category, unit_type, unit_pack_size: 10, cost_per_pack: 25, supplier_id: supplierId
  });

describe('item codes', () => {
  test('items get BAKE-nn / PKG-nn codes, unique and increasing', async () => {
    const a = await newItem(operator, 'Code Oats', 'Baking', 'kg');
    const b = await newItem(operator, 'Code Almonds', 'Baking', 'kg');
    const c = await newItem(operator, 'Code Bag', 'Packaging', 'units');
    expect(a.status).toBe(201);
    expect(a.body.item_code).toMatch(/^BAKE-\d{2,}$/);
    expect(c.body.item_code).toMatch(/^PKG-\d{2,}$/);
    expect(b.body.item_code).not.toBe(a.body.item_code);
    expect(parseInt(b.body.item_code.slice(5), 10)).toBe(parseInt(a.body.item_code.slice(5), 10) + 1);
  });

  test('the code survives an edit and is returned by the list', async () => {
    const created = await newItem(operator, 'Code Honey', 'Baking', 'kg');
    const put = await api().put(`/api/items/${created.body.id}`).set(auth(operator)).send({
      name: 'Code Honey 2', category: 'Baking', unit_type: 'kg', unit_pack_size: 20, cost_per_pack: 80, supplier_id: supplierId
    });
    expect(put.status).toBe(200);
    expect(put.body.item_code).toBe(created.body.item_code);
    const list = await api().get('/api/items').set(auth(operator));
    expect(list.body.find(i => i.id === created.body.id).item_code).toBe(created.body.item_code);
  });
});

describe('received lots', () => {
  let lotId;

  test('the spec document name and size are stored and listed with the item code', async () => {
    const item = await newItem(operator, 'Code Flour', 'Baking', 'kg');
    const res = await api().post('/api/lots/receive').set(auth(operator)).send({
      supplier_id: supplierId,
      items: [{
        item_id: item.body.id, lot_number: 'SPEC-1', packs_received: 2,
        spec_doc_name: 'flour-coa.pdf', spec_doc_size: '123.4 KB'
      }]
    });
    expect(res.status).toBe(201);
    lotId = res.body.lots[0].id;
    const list = await api().get('/api/lots').set(auth(operator));
    const lot = list.body.find(l => l.id === lotId);
    expect(lot).toMatchObject({ spec_doc_name: 'flour-coa.pdf', spec_doc_size: '123.4 KB', item_code: item.body.item_code });
  });

  test('a lot number already received for the item can be received again as a new lot', async () => {
    const item = await newItem(operator, 'Repeat Cinnamon', 'Baking', 'kg');
    const other = await newItem(operator, 'Repeat Dates', 'Baking', 'kg');
    const receive = (items) => api().post('/api/lots/receive').set(auth(operator)).send({ supplier_id: supplierId, items });
    expect((await receive([{ item_id: item.body.id, lot_number: '62781', packs_received: 1 }])).status).toBe(201);
    const again = await receive([
      { item_id: item.body.id, lot_number: '62781', packs_received: 2 },
      { item_id: other.body.id, lot_number: '62781', packs_received: 1 }
    ]);
    expect(again.status).toBe(201);
    expect(again.body.lots).toHaveLength(2);
    const list = await api().get('/api/lots').set(auth(operator));
    expect(list.body.filter(l => l.lot_number === '62781')).toHaveLength(3);
  });

  test('only an administrator can delete a lot', async () => {
    const denied = await api().delete(`/api/lots/${lotId}`).set(auth(operator));
    expect(denied.status).toBe(403);
    const ok = await api().delete(`/api/lots/${lotId}`).set(auth(admin));
    expect(ok.status).toBe(200);
  });
});
