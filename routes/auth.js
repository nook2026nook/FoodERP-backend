const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { authenticate, resolveUserAllowedMenus } = require('../middleware/auth');
const { verifyPassword, hashPassword } = require('../utils/password');
const { logAudit } = require('../utils/audit');

const router = express.Router();

/**
 * pwdReset: the user must change their password before any other API call
 * (enforced in middleware/auth.js authenticate()).
 */
function issueToken(user, allowedMenus) {
  return jwt.sign(
    {
      id: user.id, email: user.email, name: user.full_name, role: user.role, allowedMenus,
      ...(user.force_password_reset ? { pwdReset: true } : {})
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT || '10', 10),
  skipSuccessfulRequests: true, // only failed logins count toward the limit
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const changeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'Use at least 10 characters')
});

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.full_name,
    role: row.role,
    allowedMenus: resolveUserAllowedMenus(row),
    forcePasswordReset: row.force_password_reset
  };
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const { rows } = await req.db.query(
      `SELECT id, email, password_hash, full_name, role, active, allowed_menus, force_password_reset
         FROM users WHERE lower(email) = lower($1)`,
      [email]
    );
    // Same response for unknown user and bad password.
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });
    const user = rows[0];
    if (!user.active) return res.status(403).json({ error: 'This account is disabled' });

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const allowedMenus = resolveUserAllowedMenus(user);
    const token = issueToken(user, allowedMenus);

    await req.db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    await logAudit(req.db, user.id, 'LOGIN', 'user', user.id, null, null, req.ip);

    res.json({ token, user: publicUser({ ...user, allowed_menus: allowedMenus }) });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: err.errors });
    next(err);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT id, email, full_name, role, active, allowed_menus, force_password_reset
         FROM users WHERE id = $1`, [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (!rows[0].active) return res.status(403).json({ error: 'This account is disabled' });
    res.json(publicUser(rows[0]));
  } catch (err) { next(err); }
});

router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = changeSchema.parse(req.body);
    const { rows } = await req.db.query(
      `SELECT id, email, password_hash, full_name, role, active, allowed_menus, force_password_reset
         FROM users WHERE id = $1`, [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    if (!(await verifyPassword(rows[0].password_hash, currentPassword))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'Choose a password different from the current one' });
    }
    const hash = await hashPassword(newPassword);
    await req.db.query(
      'UPDATE users SET password_hash = $1, force_password_reset = false WHERE id = $2',
      [hash, req.user.id]
    );
    await logAudit(req.db, req.user.id, 'CHANGE_PASSWORD', 'user', req.user.id, null, null, req.ip);
    // Fresh token without the pwdReset claim, so the app unlocks immediately.
    const user = { ...rows[0], force_password_reset: false };
    const allowedMenus = resolveUserAllowedMenus(user);
    res.json({
      message: 'Password changed successfully',
      token: issueToken(user, allowedMenus),
      user: publicUser({ ...user, allowed_menus: allowedMenus })
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: err.errors });
    next(err);
  }
});

module.exports = router;
