const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const config = require('../config');
const { authenticate, requireAdmin, requireMenuAccess, requireEdit } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const qboClient = require('../utils/qboClient');
const { syncInvoices, applyMappings } = require('../utils/qboSync');

const router = express.Router();
const STATE_TTL_MS = 10 * 60 * 1000;

function handleError(e, res, next) {
  if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
  if (e.status) return res.status(e.status).json({ error: e.message });
  if (e.code === '23503') return res.status(400).json({ error: 'Recipe not found' });
  return next(e);
}

const backToApp = (params) => `${config.frontendUrl}/?${new URLSearchParams(params)}`;

// GET /api/qbo/callback — Intuit redirects the admin's browser here after consent.
// No JWT on this request, so the one-time `state` from /connect-url is what proves it.
router.get('/callback', async (req, res) => {
  try {
    const { rows } = await req.db.query("DELETE FROM app_settings WHERE key = 'qbo_oauth_state' RETURNING value");
    const saved = rows[0] ? JSON.parse(rows[0].value) : null;
    const given = Buffer.from(String(req.query.state || ''));
    const expected = Buffer.from(String(saved?.state || ''));
    const valid = saved && Date.now() < saved.expires_at
      && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!valid) return res.redirect(backToApp({ qbo: 'error', message: 'The connection link expired or was already used. Try Connect again.' }));
    if (req.query.error) return res.redirect(backToApp({ qbo: 'error', message: `QuickBooks: ${req.query.error}` }));

    const realmId = await qboClient.exchangeCode(req.db, req.originalUrl, req.query.realmId);
    await logAudit(req.db, saved.user_id, 'QBO_CONNECT', 'qbo', realmId, null, { realmId, environment: config.qbo.environment }, req.ip);
    return res.redirect(backToApp({ qbo: 'connected' }));
  } catch (e) {
    return res.redirect(backToApp({ qbo: 'error', message: e.message || 'QuickBooks connection failed' }));
  }
});

router.use(authenticate);

// GET /api/qbo/status — connection, last sync and how many lines need attention.
router.get('/status', requireMenuAccess('shipping'), async (req, res, next) => {
  try {
    const conn = await qboClient.connection(req.db);
    const summary = await req.db.query("SELECT value, updated_at FROM app_settings WHERE key = 'qbo_last_sync_summary'");
    const open = await req.db.query(
      `SELECT COUNT(*) FILTER (WHERE l.recipe_id IS NULL)::int AS unmapped,
              COUNT(*) FILTER (WHERE l.recipe_id IS NOT NULL)::int AS short
         FROM shipment_lines l WHERE l.allocation_status <> 'allocated' AND l.qbo_item_id IS NOT NULL`
    );
    res.json({
      configured: qboClient.isConfigured(),
      environment: config.qbo.environment,
      connected: Boolean(conn),
      realm_id: conn?.realm_id || null,
      refresh_expires_at: conn?.refresh_token_expires_at || null,
      last_sync_at: conn?.last_sync_at || null,
      last_sync_summary: summary.rows[0] ? JSON.parse(summary.rows[0].value) : null,
      open_lines: open.rows[0]
    });
  } catch (e) { next(e); }
});

// POST /api/qbo/connect-url (admin) — one-time state, then the browser goes to Intuit.
router.post('/connect-url', requireAdmin, async (req, res, next) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    const url = qboClient.authorizeUri(state);
    await req.db.query(
      `INSERT INTO app_settings (key, value) VALUES ('qbo_oauth_state', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({ state, user_id: req.user.id, expires_at: Date.now() + STATE_TTL_MS })]
    );
    res.json({ url });
  } catch (e) { handleError(e, res, next); }
});

router.post('/disconnect', requireAdmin, async (req, res, next) => {
  try {
    await qboClient.disconnect(req.db);
    await logAudit(req.db, req.user.id, 'QBO_DISCONNECT', 'qbo', null, null, null, req.ip);
    res.json({ message: 'QuickBooks disconnected' });
  } catch (e) { handleError(e, res, next); }
});

// POST /api/qbo/sync-invoices (admin, shipping clerk)
router.post('/sync-invoices', requireEdit('shipping'), async (req, res, next) => {
  try {
    const summary = await syncInvoices(req.db, qboClient.api(req.db), { userId: req.user.id });
    await logAudit(req.db, req.user.id, 'QBO_SYNC', 'qbo', null, null, {
      created: summary.created, unmapped: summary.unmapped, removed: summary.removed, errors: summary.errors.length
    }, req.ip);
    res.json(summary);
  } catch (e) { handleError(e, res, next); }
});

// GET /api/qbo/items (admin) — QuickBooks products and services, for mapping.
router.get('/items', requireAdmin, async (req, res, next) => {
  try {
    const api = qboClient.api(req.db);
    const items = [];
    for (let start = 1; ; start += 1000) {
      const page = (await api.query(`SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS 1000`)).Item || [];
      items.push(...page);
      if (page.length < 1000) break;
    }
    res.json(items
      .filter(i => i.Type !== 'Category')
      .map(i => ({ id: String(i.Id), name: i.FullyQualifiedName || i.Name, type: i.Type, sku: i.Sku || null, active: i.Active !== false, unit_price: i.UnitPrice ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) { handleError(e, res, next); }
});

// Item mappings: QuickBooks product -> recipe + format + bag/box.
router.get('/item-mappings', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT m.*, r.name AS recipe_name FROM qbo_item_map m JOIN recipes r ON r.id = m.recipe_id
        ORDER BY m.qbo_item_name`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/item-mappings', requireAdmin, async (req, res, next) => {
  try {
    const d = z.object({
      qbo_item_id: z.string().min(1).max(100),
      qbo_item_name: z.string().min(1).max(255),
      recipe_id: z.string().uuid(),
      format: z.enum(['575g', '312g']),
      unit_type: z.enum(['box', 'bag'])
    }).parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO qbo_item_map (qbo_item_id, qbo_item_name, recipe_id, format, unit_type)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (qbo_item_id) DO UPDATE SET qbo_item_name = EXCLUDED.qbo_item_name, recipe_id = EXCLUDED.recipe_id,
         format = EXCLUDED.format, unit_type = EXCLUDED.unit_type, updated_at = NOW()
       RETURNING *`,
      [d.qbo_item_id, d.qbo_item_name, d.recipe_id, d.format, d.unit_type]
    );
    await logAudit(req.db, req.user.id, 'UPSERT', 'qbo_item_map', rows[0].id, null, rows[0], req.ip);
    // Lines that arrived before this mapping existed are mapped and allocated now.
    const applied = await applyMappings(req.db, req.user.id);
    res.status(201).json({ mapping: rows[0], applied });
  } catch (e) { handleError(e, res, next); }
});

router.delete('/item-mappings/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await req.db.query('DELETE FROM qbo_item_map WHERE id = $1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Mapping not found' });
    await logAudit(req.db, req.user.id, 'DELETE', 'qbo_item_map', req.params.id, rows[0], null, req.ip);
    res.json({ message: 'Mapping removed; lines already synced keep their allocation' });
  } catch (e) { next(e); }
});

// GET /api/qbo/sync-log (admin) — recent sync runs and per-invoice failures.
router.get('/sync-log', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await req.db.query('SELECT * FROM qbo_sync_log ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
