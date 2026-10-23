const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../server');
const config = require('../config');
const { pool } = require('../db');
const { hashPassword } = require('../utils/password');
const { resolveUserAllowedMenus } = require('../middleware/auth');

const TABLES = [
  'shipment_allocations', 'shipment_lines', 'shipments', 'inventory_adjustments',
  'batch_lot_allocations', 'batch_packaging', 'production_batches',
  'recipe_packaging_bom', 'recipe_items', 'qbo_item_map', 'recipes',
  'warehouse_lots', 'master_items', 'suppliers', 'audit_log', 'app_settings', 'users'
];

async function resetDb() {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** Create a user and return a bearer token for it (skips the login rate limiter). */
async function userToken(role, email = `${role.replace(/\W+/g, '').toLowerCase()}@test.local`) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4) RETURNING *`,
    [email, 'not-used', role, role]
  );
  const u = rows[0];
  return jwt.sign(
    { id: u.id, email: u.email, name: u.full_name, role: u.role, allowedMenus: resolveUserAllowedMenus(u) },
    config.jwtSecret
  );
}

async function setVaultPasscode(passcode) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('vault_passcode_hash', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [await hashPassword(passcode)]
  );
}

const api = () => request(app);

module.exports = { api, pool, resetDb, userToken, setVaultPasscode };
