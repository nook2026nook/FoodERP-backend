const express = require('express');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { issueVaultToken } = require('../middleware/vault');
const { verifyPassword, hashPassword } = require('../utils/password');
const { logAudit } = require('../utils/audit');
const config = require('../config');

const router = express.Router();

const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.VAULT_RATE_LIMIT || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' }
});

async function getVaultHash(db) {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'vault_passcode_hash'");
  return rows[0]?.value || null;
}

// POST /api/vault/unlock  { passcode }
router.post('/unlock', authenticate, unlockLimiter, async (req, res, next) => {
  try {
    const { passcode } = z.object({ passcode: z.string().min(1) }).parse(req.body);
    const hash = await getVaultHash(req.db);
    if (!hash) return res.status(409).json({ error: 'Vault has not been configured. Ask an administrator.' });

    // No admin backdoor here by design (v45 removed 'admin123').
    if (!(await verifyPassword(hash, passcode))) {
      await logAudit(req.db, req.user.id, 'VAULT_UNLOCK_FAILED', 'vault', null, null, null, req.ip);
      return res.status(401).json({ error: 'Incorrect passcode' });
    }

    await logAudit(req.db, req.user.id, 'VAULT_UNLOCK', 'vault', null, null, null, req.ip);
    res.json({ vaultToken: issueVaultToken(req.user), expiresInMinutes: config.vaultTokenMinutes });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: err.errors });
    next(err);
  }
});

// POST /api/vault/change-passcode  (admin only)
router.post('/change-passcode', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { currentPasscode, newPasscode } = z.object({
      // Not needed the first time, before any passcode exists.
      currentPasscode: z.string().optional().default(''),
      newPasscode: z.string().min(8, 'Use at least 8 characters')
    }).parse(req.body);

    const hash = await getVaultHash(req.db);
    if (hash && !(await verifyPassword(hash, currentPasscode))) {
      return res.status(401).json({ error: 'Current passcode is incorrect' });
    }

    const newHash = await hashPassword(newPasscode);
    await req.db.query(
      `INSERT INTO app_settings (key, value) VALUES ('vault_passcode_hash', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [newHash]
    );
    await logAudit(req.db, req.user.id, 'VAULT_PASSCODE_CHANGED', 'vault', null, null, null, req.ip);
    res.json({ message: 'Formulation vault passcode updated' });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: err.errors });
    next(err);
  }
});

// GET /api/vault/status
router.get('/status', authenticate, async (req, res, next) => {
  try {
    const hash = await getVaultHash(req.db);
    res.json({ configured: Boolean(hash), tokenMinutes: config.vaultTokenMinutes });
  } catch (err) { next(err); }
});

module.exports = router;
