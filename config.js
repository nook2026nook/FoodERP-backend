require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v && process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: parseInt(process.env.PORT || '5000', 10),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  vaultPasscodeInitial: process.env.VAULT_PASSCODE_INITIAL,
  vaultTokenMinutes: parseInt(process.env.VAULT_TOKEN_MINUTES || '15', 10),
  qbo: {
    clientId: process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment: process.env.QBO_ENVIRONMENT || 'sandbox',
    redirectUri: process.env.QBO_REDIRECT_URI || 'http://localhost:5000/api/qbo/callback',
    syncMode: process.env.QBO_SYNC_MODE || 'push',
    defaultBagPrice: parseFloat(process.env.QBO_DEFAULT_BAG_PRICE || '0') || null
  },
  backupRetentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10),
  menus: [
    'dashboard', 'ingredients_hub', 'receiving', 'recipes', 'production',
    'ready_to_ship', 'shipping', 'reports', 'wastage', 'recall', 'help'
  ]
};
