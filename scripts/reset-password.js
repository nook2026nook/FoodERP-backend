/**
 * Set a user's password from the command line (when nobody knows it).
 *   node scripts/reset-password.js admin@naturesmix.com [--temporary]
 * Asks for the new password without echoing it. --temporary makes the user
 * choose their own password at next login. Uses DATABASE_URL from .env.
 */
require('dotenv').config();
const readline = require('readline');
const { pool } = require('../db');
const { hashPassword } = require('../utils/password');
const { logAudit } = require('../utils/audit');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const email = (process.argv[2] || '').trim().toLowerCase();
  const temporary = process.argv.includes('--temporary');
  if (!email) throw new Error('Usage: node scripts/reset-password.js <email> [--temporary]');

  const { rows: [user] } = await pool.query('SELECT id, email FROM users WHERE lower(email) = $1', [email]);
  if (!user) throw new Error(`No user ${email}`);

  const password = await askHidden('New password: ');
  if (password.length < 10) throw new Error('Use at least 10 characters');
  if (password !== await askHidden('Repeat it: ')) throw new Error('Passwords do not match');

  await pool.query(
    'UPDATE users SET password_hash = $1, force_password_reset = $2, active = true, updated_at = NOW() WHERE id = $3',
    [await hashPassword(password), temporary, user.id]
  );
  await logAudit(pool, null, 'RESET_PASSWORD_CLI', 'user', user.id, null, { email: user.email, temporary }, null);
  console.log(`Password changed for ${user.email}${temporary ? ' (must choose a new one at next login)' : ''}.`);
})()
  .catch((e) => { console.error('Not changed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
