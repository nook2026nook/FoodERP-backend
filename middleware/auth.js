const jwt = require('jsonwebtoken');
const config = require('../config');

const ROLE_DEFAULT_MENUS = {
  Administrator: config.menus,
  'Production Operator': ['dashboard', 'ingredients_hub', 'receiving', 'recipes', 'production', 'ready_to_ship', 'reports', 'wastage', 'help'],
  'Quality Assurance (QA)': ['dashboard', 'ingredients_hub', 'recipes', 'production', 'ready_to_ship', 'reports', 'wastage', 'recall', 'help'],
  'Shipping Clerk': ['dashboard', 'ready_to_ship', 'shipping', 'reports', 'recall', 'help'],
  'View-Only Guest': ['dashboard', 'ingredients_hub', 'ready_to_ship', 'reports', 'help'],
  'Custom Staff': ['dashboard', 'help'] // read-only by default (Question #5)
};

const ROLE_CAN_EDIT = {
  'ingredients_hub': ['Administrator', 'Production Operator'],
  receiving: ['Administrator', 'Production Operator'],
  recipes: ['Administrator', 'Production Operator'],
  production: ['Administrator', 'Production Operator'],
  // QA hold / release of batches (DECISIONS.md #23)
  quality: ['Administrator', 'Quality Assurance (QA)'],
  shipping: ['Administrator', 'Shipping Clerk'],
  qbo: ['Administrator'],
  users: ['Administrator']
};

function resolveUserAllowedMenus(user) {
  if (user.role === 'Administrator') return config.menus;
  if (Array.isArray(user.allowed_menus) && user.allowed_menus.length > 0) return user.allowed_menus;
  return ROLE_DEFAULT_MENUS[user.role] || ['dashboard'];
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), config.jwtSecret);
    req.user = decoded;
    // First login with a temporary password: only the password change is allowed.
    const path = `${req.baseUrl}${req.path}`;
    if (decoded.pwdReset && !['/api/auth/change-password', '/api/auth/me'].includes(path)) {
      return res.status(403).json({ error: 'Change your password to continue', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    return next();
  } catch (err) {
    // 401 for both missing and expired tokens; 403 is reserved for permissions.
    return res.status(401).json({
      error: err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token'
    });
  }
}

/** Menu access gate. Administrator bypasses. */
function requireMenuAccess(...menuIds) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'Administrator') return next();

    const granted = (req.user.allowedMenus || []).some((m) => menuIds.includes(m));
    if (!granted) {
      return res.status(403).json({ error: 'You do not have access to this module' });
    }
    return next();
  };
}

/** Read gate: user must have the menu, writes additionally need canEdit. */
function requireEdit(menuId) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const roles = ROLE_CAN_EDIT[menuId] || ['Administrator'];
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role cannot modify this module' });
    }
    return next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'Administrator') {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  return next();
}

module.exports = {
  authenticate, requireMenuAccess, requireEdit, requireAdmin,
  ROLE_DEFAULT_MENUS, ROLE_CAN_EDIT, resolveUserAllowedMenus
};
