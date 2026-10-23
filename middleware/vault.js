const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Vault token: short-lived (default 15 min) JWT issued by POST /api/vault/unlock
 * after verifying the vault passcode. Guards all recipe/cost endpoints.
 */
function requireVault(req, res, next) {
  const vaultToken = req.headers['x-vault-token'];
  if (!vaultToken) {
    return res.status(403).json({ error: 'Formulation vault is locked', code: 'VAULT_LOCKED' });
  }
  try {
    const decoded = jwt.verify(vaultToken, config.jwtSecret);
    if (decoded.scope !== 'vault' || decoded.sub !== req.user.id) {
      return res.status(403).json({ error: 'Invalid vault token', code: 'VAULT_LOCKED' });
    }
    req.vault = decoded;
    return next();
  } catch {
    return res.status(403).json({ error: 'Vault session expired', code: 'VAULT_LOCKED' });
  }
}

function issueVaultToken(user) {
  return jwt.sign({ sub: user.id, scope: 'vault' }, config.jwtSecret, {
    expiresIn: `${config.vaultTokenMinutes}m`
  });
}

module.exports = { requireVault, issueVaultToken };
