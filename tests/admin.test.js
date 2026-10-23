const { api, pool, resetDb, userToken } = require('./helpers');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

let admin; let operator;

// Shaped like a backup downloaded from the v45 browser prototype.
const prototypeBackup = {
  suppliers: ['Approved Commercial Miller', 'EcoBox Packaging'],
  bakingIngredients: [
    { id: 'BAKE-0001', name: 'Rolled Oats', unitPackKg: 25, costPerPack: 50, supplier: 'Approved Commercial Miller' }
  ],
  packagingMaterials: [
    { id: 'PKG-0001', name: '575g Pouch', unitType: 'units', unitPackKg: 1000, costPerPack: 100 }
  ],
  lots: [
    { id: 'LOT-1', lotNumber: 'OAT-01', ingredientId: 'BAKE-0001', supplier: 'Approved Commercial Miller', remainingKg: 40 },
    { id: 'LOT-2', lotNumber: 'POUCH-01', ingredientId: 'PKG-0001', supplier: 'EcoBox Packaging', remainingKg: 950 }
  ],
  recipes: [{
    id: 'REC-0001', name: 'Classic Granola', wastagePercent: 2.5, laborCostPerBatch: 150,
    items: [{ ingredientId: 'BAKE-0001', gramsPerUnit: 5750 }],
    packagingItems: [{ packagingId: 'PKG-0001', amount: 1, measure: 'grams', assignment: 'bag575' }]
  }],
  batches: [{
    id: 'BATCH-1', batchNumber: 'BATCH-260101-111', productionDate: '2026-01-01', recipeId: 'REC-0001',
    binsCount: 4, scaleBasis: 'batch',
    bakingDeductions: { 'OAT-01': 11.5 }, pkgDeductions: { 'POUCH-01': 20 },
    packagingBreakdown: { pack575: { bagsCount: 20, boxesCount: 0 }, pack312: { bagsCount: 0, boxesCount: 0 } }
  }],
  shippings: [{ id: 'SHIP-1', customer: 'Corner Store', invoiceNumber: 'INV-9', batchId: 'BATCH-260101-111', quantityShipped: '5', shippedAt: '1/15/2026' }],
  usersDatabase: [
    { email: 'operator@naturesmix.com', pin: 'op123', name: 'John Operator', role: 'Production Operator', allowedMenus: ['dashboard', 'production'] }
  ]
};

beforeAll(async () => {
  await resetDb();
  admin = await userToken('Administrator');
  operator = await userToken('Production Operator', 'op@test.local');
});

afterAll(async () => {
  await pool.end();
});

describe('user management', () => {
  test('only administrators can manage users', async () => {
    expect((await api().get('/api/admin/users').set(auth(operator))).status).toBe(403);
  });

  test('create a user who must change the password at first login', async () => {
    const res = await api().post('/api/admin/users').set(auth(admin)).send({
      email: 'Dave@NaturesMix.com', password: 'Temporary-123', full_name: 'Dave Dispatcher', role: 'Shipping Clerk'
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'dave@naturesmix.com', force_password_reset: true, active: true });
    expect(res.body.password_hash).toBeUndefined();
    expect(res.body.effective_menus).toContain('shipping');
  });

  test('duplicate email and short password are rejected', async () => {
    const dup = await api().post('/api/admin/users').set(auth(admin)).send({
      email: 'dave@naturesmix.com', password: 'Temporary-123', full_name: 'Again', role: 'Shipping Clerk'
    });
    expect(dup.status).toBe(409);
    const short = await api().post('/api/admin/users').set(auth(admin)).send({
      email: 'x@naturesmix.com', password: 'short', full_name: 'X', role: 'Shipping Clerk'
    });
    expect(short.status).toBe(400);
  });

  test('the last active administrator cannot be demoted or deleted', async () => {
    const { rows } = await pool.query("SELECT id FROM users WHERE role = 'Administrator'");
    const demote = await api().put(`/api/admin/users/${rows[0].id}`).set(auth(admin)).send({ full_name: 'Admin', role: 'View-Only Guest' });
    expect(demote.status).toBe(409);
    const self = await api().delete(`/api/admin/users/${rows[0].id}`).set(auth(admin));
    expect(self.status).toBe(409);
  });

  test('custom menus and deactivation are saved', async () => {
    const { rows } = await pool.query("SELECT id FROM users WHERE email = 'dave@naturesmix.com'");
    const res = await api().put(`/api/admin/users/${rows[0].id}`).set(auth(admin)).send({
      full_name: 'Dave D.', role: 'Shipping Clerk', allowed_menus: ['dashboard', 'shipping'], active: false
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: false, allowed_menus: ['dashboard', 'shipping'], effective_menus: ['dashboard', 'shipping'] });
  });
});

describe('prototype import', () => {
  let summary;

  test('imports catalog, lots, recipes, batches, shipments and users in one go', async () => {
    const res = await api().post('/api/admin/import').set(auth(admin)).send(prototypeBackup);
    expect(res.status).toBe(200);
    summary = res.body;
    expect(summary.created).toEqual({ suppliers: 2, items: 2, lots: 2, recipes: 1, batches: 1, shipments: 1, users: 1 });
    expect(summary.temporary_passwords[0].email).toBe('operator@naturesmix.com');
    expect(summary.temporary_passwords[0].temporary_password).not.toBe('op123');
  });

  test('lot stock is taken as-is; batch usage is recorded without deducting again', async () => {
    const lots = await pool.query("SELECT lot_number, remaining_quantity FROM warehouse_lots ORDER BY lot_number");
    expect(lots.rows.map(r => [r.lot_number, Number(r.remaining_quantity)])).toEqual([['OAT-01', 40], ['POUCH-01', 950]]);
    const usage = await pool.query(
      `SELECT a.stage, a.quantity FROM batch_lot_allocations a
         JOIN production_batches b ON b.id = a.batch_id WHERE b.batch_number = 'BATCH-260101-111' ORDER BY a.stage`
    );
    expect(usage.rows.map(r => [r.stage, Number(r.quantity)])).toEqual([['baking', 11.5], ['packaging', 20]]);
  });

  test('packaging measured in grams on a counted item is converted, with a warning', async () => {
    const bom = await pool.query('SELECT measure FROM recipe_packaging_bom');
    expect(bom.rows[0].measure).toBe('units');
    expect(summary.warnings.some(w => w.includes('changed from grams to units'))).toBe(true);
  });

  test('old shipments come in unallocated for review; dates are parsed', async () => {
    const { rows } = await pool.query(
      "SELECT s.shipped_at::text AS d, l.allocation_status FROM shipments s JOIN shipment_lines l ON l.shipment_id = s.id"
    );
    expect(rows).toEqual([{ d: '2026-01-15', allocation_status: 'unallocated' }]);
  });

  test('importing the same file again creates nothing new', async () => {
    const res = await api().post('/api/admin/import').set(auth(admin)).send(prototypeBackup);
    expect(res.status).toBe(200);
    expect(res.body.created).toEqual({});
  });

  test('a file that is not a prototype backup is rejected', async () => {
    const res = await api().post('/api/admin/import').set(auth(admin)).send({ hello: 'world' });
    expect(res.status).toBe(400);
  });
});

describe('export', () => {
  test('contains every table but no password hashes or vault secret', async () => {
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('vault_passcode_hash', 'secret-hash') ON CONFLICT DO NOTHING");
    const res = await api().get('/api/admin/export').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ recipes: 1, production_batches: 1, warehouse_lots: 2 });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/password_hash/);
    expect(text).not.toMatch(/secret-hash/);
  });
});

describe('forced password change', () => {
  test('a temporary password only allows changing the password', async () => {
    await api().post('/api/admin/users').set(auth(admin)).send({
      email: 'newbie@naturesmix.com', password: 'Temporary-456', full_name: 'New Person', role: 'Production Operator'
    });
    const login = await api().post('/api/auth/login').send({ email: 'newbie@naturesmix.com', password: 'Temporary-456' });
    expect(login.status).toBe(200);
    expect(login.body.user.forcePasswordReset).toBe(true);
    const blocked = await api().get('/api/items').set(auth(login.body.token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const same = await api().post('/api/auth/change-password').set(auth(login.body.token))
      .send({ currentPassword: 'Temporary-456', newPassword: 'Temporary-456' });
    expect(same.status).toBe(400);

    const changed = await api().post('/api/auth/change-password').set(auth(login.body.token))
      .send({ currentPassword: 'Temporary-456', newPassword: 'My-Own-Password-1' });
    expect(changed.status).toBe(200);
    expect(changed.body.user.forcePasswordReset).toBe(false);
    expect((await api().get('/api/items').set(auth(changed.body.token))).status).toBe(200);
  });
});
