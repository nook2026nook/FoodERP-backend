const express = require('express');
const { z } = require('zod');
const config = require('../config');
const { authenticate, requireAdmin, resolveUserAllowedMenus } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { withTransaction } = require('../db');
const { hashPassword } = require('../utils/password');
const { importPrototypeBackup } = require('../utils/prototypeImport');
const { httpError } = require('../utils/stock');

const router = express.Router();
router.use(authenticate, requireAdmin);

const ROLES = ['Administrator', 'Production Operator', 'Quality Assurance (QA)',
  'Shipping Clerk', 'View-Only Guest', 'Custom Staff'];

const userFields = {
  full_name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
  // Empty = the role's default menus.
  allowed_menus: z.array(z.enum(config.menus)).default([]),
  active: z.boolean().default(true)
};
const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(10, 'Use at least 10 characters'),
  ...userFields
});
const updateSchema = z.object({
  ...userFields,
  // Optional reset; the user must choose a new one at next login.
  password: z.string().min(10, 'Use at least 10 characters').optional()
});

function handleError(e, res, next) {
  if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
  if (e.status) return res.status(e.status).json({ error: e.message });
  if (e.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
  return next(e);
}

const USER_COLUMNS = 'id, email, full_name, role, allowed_menus, active, force_password_reset, last_login_at, created_at';
const present = (u) => ({ ...u, effective_menus: resolveUserAllowedMenus(u) });

/** Refuse changes that would leave no active administrator. */
async function assertAnotherActiveAdmin(client, excludingId) {
  const { rows } = await client.query(
    "SELECT COUNT(*)::int AS n FROM users WHERE role = 'Administrator' AND active AND id <> $1", [excludingId]
  );
  if (rows[0].n === 0) throw httpError(409, 'At least one active administrator must remain');
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY active DESC, full_name`);
    res.json({ users: rows.map(present), roles: ROLES, menus: config.menus });
  } catch (e) { next(e); }
});

router.post('/users', async (req, res, next) => {
  try {
    const d = createSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO users (email, password_hash, full_name, role, allowed_menus, active, force_password_reset)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING ${USER_COLUMNS}`,
      [d.email, await hashPassword(d.password), d.full_name, d.role, d.allowed_menus, d.active]
    );
    await logAudit(req.db, req.user.id, 'CREATE', 'user', rows[0].id, null, rows[0], req.ip);
    res.status(201).json(present(rows[0]));
  } catch (e) { handleError(e, res, next); }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    const d = updateSchema.parse(req.body);
    const saved = await withTransaction(async (client) => {
      const before = await client.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!before.rows.length) throw httpError(404, 'User not found');
      const losesAdmin = before.rows[0].role === 'Administrator' && (d.role !== 'Administrator' || !d.active);
      if (losesAdmin) await assertAnotherActiveAdmin(client, req.params.id);

      const params = [d.full_name, d.role, d.allowed_menus, d.active, req.params.id];
      let passwordSql = '';
      if (d.password) {
        params.push(await hashPassword(d.password));
        passwordSql = `, password_hash = $${params.length}, force_password_reset = true`;
      }
      const { rows } = await client.query(
        `UPDATE users SET full_name = $1, role = $2, allowed_menus = $3, active = $4${passwordSql}
          WHERE id = $5 RETURNING ${USER_COLUMNS}`, params
      );
      await logAudit(client, req.user.id, d.password ? 'UPDATE_RESET_PASSWORD' : 'UPDATE', 'user', req.params.id, before.rows[0], rows[0], req.ip);
      return rows[0];
    });
    res.json(present(saved));
  } catch (e) { handleError(e, res, next); }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(409).json({ error: 'You cannot delete your own account' });
    await withTransaction(async (client) => {
      const before = await client.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!before.rows.length) throw httpError(404, 'User not found');
      if (before.rows[0].role === 'Administrator') await assertAnotherActiveAdmin(client, req.params.id);
      await client.query('DELETE FROM users WHERE id = $1', [req.params.id]);
      await logAudit(client, req.user.id, 'DELETE', 'user', req.params.id, before.rows[0], null, req.ip);
    });
    res.json({ message: 'User deleted' });
  } catch (e) { handleError(e, res, next); }
});

// ---------------------------------------------------------------------------
// Backup export / prototype import
// ---------------------------------------------------------------------------

// Tables in the export, parents first. Password hashes, QuickBooks tokens and
// the vault passcode hash are never exported.
const EXPORT_TABLES = [
  ['users', `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at`],
  ['suppliers', 'SELECT * FROM suppliers ORDER BY name'],
  ['master_items', 'SELECT * FROM master_items ORDER BY category, name'],
  ['warehouse_lots', 'SELECT * FROM warehouse_lots ORDER BY received_at, created_at'],
  ['recipes', 'SELECT * FROM recipes ORDER BY name'],
  ['recipe_items', 'SELECT * FROM recipe_items'],
  ['recipe_packaging_bom', 'SELECT * FROM recipe_packaging_bom'],
  ['production_batches', 'SELECT * FROM production_batches ORDER BY production_date, created_at'],
  ['batch_packaging', 'SELECT * FROM batch_packaging'],
  ['batch_lot_allocations', 'SELECT * FROM batch_lot_allocations'],
  ['inventory_adjustments', 'SELECT * FROM inventory_adjustments ORDER BY created_at'],
  ['shipments', 'SELECT * FROM shipments ORDER BY shipped_at, created_at'],
  ['shipment_lines', 'SELECT * FROM shipment_lines'],
  ['shipment_allocations', 'SELECT * FROM shipment_allocations'],
  ['qbo_item_map', 'SELECT * FROM qbo_item_map'],
  ['app_settings', "SELECT key, value, updated_at FROM app_settings WHERE key <> 'vault_passcode_hash'"]
];

// GET /api/admin/export — full JSON snapshot for safekeeping and auditors.
router.get('/export', async (req, res, next) => {
  try {
    const migrations = await req.db.query('SELECT filename FROM schema_migrations ORDER BY filename').catch(() => ({ rows: [] }));
    const data = {};
    for (const [name, sql] of EXPORT_TABLES) data[name] = (await req.db.query(sql)).rows;
    await logAudit(req.db, req.user.id, 'EXPORT', 'database', null, null, null, req.ip);
    res.json({
      format: 'foodtrace-erp-export',
      version: 1,
      exported_at: new Date().toISOString(),
      schema_migrations: migrations.rows.map(r => r.filename),
      counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
      data
    });
  } catch (e) { next(e); }
});

// POST /api/admin/import — load a backup file from the old browser-only app.
// One transaction: either everything in the file is imported or nothing is.
router.post('/import', async (req, res, next) => {
  try {
    const backup = z.object({}).passthrough().parse(req.body);
    const summary = await withTransaction((client) => importPrototypeBackup(client, backup, req.user.id));
    await logAudit(req.db, req.user.id, 'IMPORT_PROTOTYPE', 'database', null, null, {
      created: summary.created, skipped: summary.skipped, warnings: summary.warnings.length
    }, req.ip);
    res.json(summary);
  } catch (e) { handleError(e, res, next); }
});

module.exports = router;
