const { api, pool, resetDb, userToken, setVaultPasscode } = require('./helpers');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

let admin; let operator; let qa; let guest; let vault;
const ids = {};

async function insertItem(name, category, unitType, packSize, costPerPack) {
  const { rows } = await pool.query(
    `INSERT INTO master_items (name, category, unit_type, unit_pack_size, cost_per_pack, supplier_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name, category, unitType, packSize, costPerPack, ids.supplier]
  );
  return rows[0].id;
}

async function insertLot(lotNumber, itemId, quantity, receivedAt) {
  const { rows } = await pool.query(
    `INSERT INTO warehouse_lots (lot_number, item_id, supplier_id, packs_received, total_quantity, remaining_quantity, received_at)
     VALUES ($1,$2,$3,1,$4,$4,$5) RETURNING id`,
    [lotNumber, itemId, ids.supplier, quantity, receivedAt]
  );
  return rows[0].id;
}

async function remaining(lotId) {
  const { rows } = await pool.query('SELECT remaining_quantity FROM warehouse_lots WHERE id = $1', [lotId]);
  return Number(rows[0].remaining_quantity);
}

/** Turn the suggested FIFO splits into a save payload. */
function splitsFrom(requirements) {
  return requirements.flatMap(r => r.splits.map(s => ({ item_id: r.item_id, lot_id: s.lot_id, quantity: s.quantity })));
}

beforeAll(async () => {
  await resetDb();
  admin = await userToken('Administrator');
  operator = await userToken('Production Operator');
  qa = await userToken('Quality Assurance (QA)');
  guest = await userToken('View-Only Guest');

  ids.supplier = (await pool.query("INSERT INTO suppliers (name) VALUES ('Test Miller') RETURNING id")).rows[0].id;
  ids.flour = await insertItem('Flour', 'Baking', 'kg', 25, 25);      // $1.00 / kg
  ids.oats = await insertItem('Oats', 'Baking', 'kg', 10, 20);        // $2.00 / kg
  ids.bag = await insertItem('575g Bag', 'Packaging', 'units', 1000, 100); // $0.10 / bag
  ids.box = await insertItem('575g Box', 'Packaging', 'units', 100, 120);  // $1.20 / box

  ids.flourLot1 = await insertLot('F-001', ids.flour, 30, '2026-01-01');
  ids.flourLot2 = await insertLot('F-002', ids.flour, 50, '2026-02-01');
  ids.oatsLot = await insertLot('O-001', ids.oats, 100, '2026-01-01');
  ids.bagLot = await insertLot('B-001', ids.bag, 1000, '2026-01-01');
  ids.boxLot = await insertLot('X-001', ids.box, 100, '2026-01-01');

  await setVaultPasscode('vault-pass-123');
});

afterAll(async () => {
  await pool.end();
});

describe('recipes', () => {
  test('formulations are locked without the vault passcode', async () => {
    const res = await api().get('/api/recipes').set(auth(operator));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('VAULT_LOCKED');
  });

  test('wrong vault passcode is rejected', async () => {
    const res = await api().post('/api/vault/unlock').set(auth(operator)).send({ passcode: 'nope' });
    expect(res.status).toBe(401);
  });

  test('create recipe computes v45 costs', async () => {
    const unlock = await api().post('/api/vault/unlock').set(auth(operator)).send({ passcode: 'vault-pass-123' });
    expect(unlock.status).toBe(200);
    vault = unlock.body.vaultToken;

    const res = await api().post('/api/recipes').set(auth(operator)).set('x-vault-token', vault).send({
      name: 'Honey Almond',
      scale_basis: 'batch',
      wastage_percent: 2.5,
      labor_cost_per_batch: 150,
      manufacturer_margin_percent: 40,
      distributor_margin_percent: 20,
      retailer_margin_percent: 35,
      items: [
        { item_id: ids.flour, grams_per_batch: 10000 },
        { item_id: ids.oats, grams_per_batch: 5000 }
      ],
      packaging: [
        { packaging_id: ids.bag, amount: 1, measure: 'units', assignment: 'bag575' },
        { packaging_id: ids.box, amount: 1, measure: 'units', assignment: 'box575' }
      ]
    });
    expect(res.status).toBe(201);
    ids.recipe = res.body.id;

    // dough $10 + $10, wastage 2.5% of dough, labor $150; 15000 g => 26 x 575g
    const base = 20 + 0.5 + 150;
    expect(Number(res.body.total_baking_grams)).toBe(15000);
    expect(Number(res.body.units_575)).toBe(26);
    expect(Number(res.body.cost_per_575g)).toBeCloseTo(base / 26 + 0.1 + 1.2 / 12, 3);
    expect(res.body.items).toHaveLength(2);
  });

  test('packaging measured in grams must be a kg item', async () => {
    const res = await api().post('/api/recipes/preview').set(auth(operator)).set('x-vault-token', vault).send({
      name: 'Bad', wastage_percent: 0, labor_cost_per_batch: 0,
      manufacturer_margin_percent: 0, distributor_margin_percent: 0, retailer_margin_percent: 0,
      items: [{ item_id: ids.flour, grams_per_batch: 100 }],
      packaging: [{ packaging_id: ids.bag, amount: 5, measure: 'grams', assignment: 'batch' }]
    });
    expect(res.status).toBe(400);
  });

  test('production can list recipe names without the vault', async () => {
    const res = await api().get('/api/recipes/options').set(auth(operator));
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ id: ids.recipe, name: 'Honey Almond', scale_basis: 'batch' });
  });
});

describe('scale basis (decision 21)', () => {
  test('batch basis multiplies by bins / 2', async () => {
    const res = await api().get('/api/batches/baking-requirements').set(auth(operator))
      .query({ recipe_id: ids.recipe, bins_count: 4, scale_basis: 'batch' });
    expect(res.status).toBe(200);
    const flour = res.body.requirements.find(r => r.item_id === ids.flour);
    expect(flour.required).toBe(20);
    expect(flour.splits).toEqual([{ lot_id: ids.flourLot1, lot_number: 'F-001', quantity: 20 }]);
  });

  test('bin basis multiplies by bins and splits FIFO across lots', async () => {
    const res = await api().get('/api/batches/baking-requirements').set(auth(operator))
      .query({ recipe_id: ids.recipe, bins_count: 4, scale_basis: 'bin' });
    const flour = res.body.requirements.find(r => r.item_id === ids.flour);
    expect(flour.required).toBe(40);
    expect(flour.splits.map(s => [s.lot_number, s.quantity])).toEqual([['F-001', 30], ['F-002', 10]]);
  });
});

describe('baking batch', () => {
  test('saving deducts the lots', async () => {
    const reqs = await api().get('/api/batches/baking-requirements').set(auth(operator))
      .query({ recipe_id: ids.recipe, bins_count: 4 });
    const res = await api().post('/api/batches/baking').set(auth(operator)).send({
      batch_number: 'B-100', recipe_id: ids.recipe, bins_count: 4, production_date: '2026-10-20',
      splits: splitsFrom(reqs.body.requirements)
    });
    expect(res.status).toBe(201);
    ids.batch = res.body.id;
    expect(res.body.status).toBe('In Production');
    expect(Number(res.body.theoretical_dough_grams)).toBe(30000);
    expect(await remaining(ids.flourLot1)).toBe(10);
    expect(await remaining(ids.oatsLot)).toBe(90);
  });

  test('re-saving the same batch number refunds the old deduction first', async () => {
    const res = await api().post('/api/batches/baking').set(auth(operator)).send({
      batch_number: 'B-100', recipe_id: ids.recipe, bins_count: 4,
      splits: [
        { item_id: ids.flour, lot_id: ids.flourLot2, quantity: 20 },
        { item_id: ids.oats, lot_id: ids.oatsLot, quantity: 10 }
      ]
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ids.batch);
    expect(await remaining(ids.flourLot1)).toBe(30);
    expect(await remaining(ids.flourLot2)).toBe(30);
    expect(await remaining(ids.oatsLot)).toBe(90);
  });

  test('splits that do not add up to the requirement are rejected', async () => {
    const res = await api().post('/api/batches/baking').set(auth(operator)).send({
      batch_number: 'B-101', recipe_id: ids.recipe, bins_count: 4,
      splits: [
        { item_id: ids.flour, lot_id: ids.flourLot1, quantity: 5 },
        { item_id: ids.oats, lot_id: ids.oatsLot, quantity: 10 }
      ]
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Flour/);
  });

  test('insufficient lot stock blocks the save and changes nothing (decision 24)', async () => {
    const res = await api().post('/api/batches/baking').set(auth(operator)).send({
      batch_number: 'B-102', recipe_id: ids.recipe, bins_count: 8, // 40 kg flour
      splits: [
        { item_id: ids.flour, lot_id: ids.flourLot1, quantity: 40 },
        { item_id: ids.oats, lot_id: ids.oatsLot, quantity: 20 }
      ]
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Lot F-001 (Flour) has 30 kg available; 40 kg requested');
    expect(await remaining(ids.flourLot1)).toBe(30);
    expect(await remaining(ids.oatsLot)).toBe(90);
    const missing = await pool.query("SELECT 1 FROM production_batches WHERE batch_number = 'B-102'");
    expect(missing.rows).toHaveLength(0);
  });

  test('a guest cannot save batches', async () => {
    const res = await api().post('/api/batches/baking').set(auth(guest)).send({});
    expect(res.status).toBe(403);
  });
});

describe('packaging', () => {
  const counts = { boxes_575g: 2, bags_575g: 6, boxes_312g: 0, bags_312g: 0 };

  test('requirements give live delta and packaging in units', async () => {
    const res = await api().get(`/api/batches/${ids.batch}/packaging-requirements`).set(auth(operator)).query(counts);
    expect(res.status).toBe(200);
    expect(res.body.theoretical_dough_grams).toBe(30000);
    expect(res.body.packaged_weight_grams).toBe(30 * 575);
    expect(res.body.variance_delta_grams).toBe(30 * 575 - 30000);
    expect(res.body.variance_status).toBe('Scrap / Loss');
    const bag = res.body.requirements.find(r => r.item_id === ids.bag);
    expect(bag.required).toBe(30);
    expect(res.body.cost).toMatchObject({ bag575: 3, box575: 2.4, total: 5.4 });
  });

  test('saving deducts packaging units and completes the batch', async () => {
    const reqs = await api().get(`/api/batches/${ids.batch}/packaging-requirements`).set(auth(operator)).query(counts);
    const res = await api().put(`/api/batches/${ids.batch}/packaging`).set(auth(operator))
      .send({ ...counts, splits: splitsFrom(reqs.body.requirements) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Completed');
    expect(Number(res.body.total_pkg_cost)).toBe(5.4);
    expect(await remaining(ids.bagLot)).toBe(970);
    expect(await remaining(ids.boxLot)).toBe(98);
  });

  test('re-packing refunds the earlier packaging deduction', async () => {
    const fewer = { boxes_575g: 1, bags_575g: 0, boxes_312g: 0, bags_312g: 0 };
    const reqs = await api().get(`/api/batches/${ids.batch}/packaging-requirements`).set(auth(operator)).query(fewer);
    const res = await api().put(`/api/batches/${ids.batch}/packaging`).set(auth(operator))
      .send({ ...fewer, splits: splitsFrom(reqs.body.requirements) });
    expect(res.status).toBe(200);
    expect(await remaining(ids.bagLot)).toBe(988);
    expect(await remaining(ids.boxLot)).toBe(99);

    // back to the original counts for the rest of the suite
    const again = await api().get(`/api/batches/${ids.batch}/packaging-requirements`).set(auth(operator)).query(counts);
    await api().put(`/api/batches/${ids.batch}/packaging`).set(auth(operator))
      .send({ ...counts, splits: splitsFrom(again.body.requirements) });
  });
});

describe('QA release and ready-to-ship stock', () => {
  async function stock() {
    const { rows } = await pool.query(
      "SELECT * FROM ready_to_ship_inventory WHERE recipe_id = $1 AND format = '575g'", [ids.recipe]
    );
    return rows[0];
  }

  test('packed stock waits for QA before it can ship', async () => {
    const s = await stock();
    expect(s.boxes).toBe(0);
    expect(s.awaiting_qa_boxes).toBe(2);
    expect(s.awaiting_qa_bags).toBe(6);
  });

  test('an operator cannot release a batch', async () => {
    const res = await api().patch(`/api/batches/${ids.batch}/status`).set(auth(operator)).send({ status: 'Released' });
    expect(res.status).toBe(403);
  });

  test('QA releases the batch and stock becomes shippable', async () => {
    const res = await api().patch(`/api/batches/${ids.batch}/status`).set(auth(qa)).send({ status: 'Released', note: 'Checked' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Released');
    const s = await stock();
    expect(s.boxes).toBe(2);
    expect(s.bags).toBe(6);
    expect(s.total_bags).toBe(30);
  });

  test('a released batch can no longer be re-baked', async () => {
    const res = await api().post('/api/batches/baking').set(auth(operator)).send({
      batch_number: 'B-100', recipe_id: ids.recipe, bins_count: 4,
      splits: [
        { item_id: ids.flour, lot_id: ids.flourLot2, quantity: 20 },
        { item_id: ids.oats, lot_id: ids.oatsLot, quantity: 10 }
      ]
    });
    expect(res.status).toBe(409);
  });
});

describe('cancel and delete refund every lot', () => {
  test('cancelling a baked batch refunds its lots', async () => {
    const baked = await api().post('/api/batches/baking').set(auth(operator)).send({
      batch_number: 'B-200', recipe_id: ids.recipe, bins_count: 2,
      splits: [
        { item_id: ids.flour, lot_id: ids.flourLot1, quantity: 10 },
        { item_id: ids.oats, lot_id: ids.oatsLot, quantity: 5 }
      ]
    });
    expect(baked.status).toBe(201);
    expect(await remaining(ids.flourLot1)).toBe(20);

    const res = await api().patch(`/api/batches/${baked.body.id}/status`).set(auth(operator)).send({ status: 'Cancelled' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Cancelled');
    expect(await remaining(ids.flourLot1)).toBe(30);
    expect(res.body.baking_allocations).toHaveLength(0);
  });

  test('deleting a batch refunds baking and packaging', async () => {
    const res = await api().delete(`/api/batches/${ids.batch}`).set(auth(operator));
    expect(res.status).toBe(200);
    expect(await remaining(ids.flourLot1)).toBe(30);
    expect(await remaining(ids.flourLot2)).toBe(50);
    expect(await remaining(ids.oatsLot)).toBe(100);
    expect(await remaining(ids.bagLot)).toBe(1000);
    expect(await remaining(ids.boxLot)).toBe(100);
  });
});
