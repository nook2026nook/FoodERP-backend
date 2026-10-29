/**
 * QuickBooks Online connection: OAuth 2.0 client, encrypted token vault and
 * authorised API calls. Tokens are AES-256-GCM encrypted at rest (TOKEN_ENCRYPTION_KEY).
 *
 * Intuit rotates refresh tokens: every refresh saves the NEW access token, the NEW
 * refresh token and BOTH expiry times, under a row lock so two syncs can't race
 * and leave a stale refresh token behind (the guide's version could lock us out).
 */
const OAuthClient = require('intuit-oauth');
const config = require('../config');
const { encrypt, decrypt } = require('./crypto');
const { withTransaction } = require('../db');

const API_BASE = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com'
};
const MINOR_VERSION = 75;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function qboError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isConfigured() {
  return Boolean(config.qbo.clientId && config.qbo.clientSecret && config.qbo.redirectUri);
}

function oauthClient() {
  if (!isConfigured()) throw qboError(503, 'QuickBooks keys are not configured on the server (QBO_CLIENT_ID / QBO_CLIENT_SECRET)');
  return new OAuthClient({
    clientId: config.qbo.clientId,
    clientSecret: config.qbo.clientSecret,
    environment: config.qbo.environment === 'production' ? 'production' : 'sandbox',
    redirectUri: config.qbo.redirectUri
  });
}

function authorizeUri(state) {
  return oauthClient().authorizeUri({ scope: [OAuthClient.scopes.Accounting], state });
}

/** Save a token response (from code exchange or refresh) for a company. */
async function saveTokens(db, realmId, token) {
  const now = Date.now();
  await db.query(
    `INSERT INTO qbo_auth_tokens (realm_id, access_token_enc, refresh_token_enc, access_token_expires_at,
                                  refresh_token_expires_at, environment, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (realm_id) DO UPDATE SET
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
       environment = EXCLUDED.environment,
       updated_at = NOW()`,
    [realmId, encrypt(token.access_token), encrypt(token.refresh_token),
     new Date(now + Number(token.expires_in) * 1000),
     new Date(now + Number(token.x_refresh_token_expires_in) * 1000),
     config.qbo.environment === 'production' ? 'production' : 'sandbox']
  );
}

/** Exchange the OAuth callback URL for tokens. Returns the realm (company) id. */
async function exchangeCode(db, callbackUrl, realmIdFromQuery) {
  const client = oauthClient();
  const response = await client.createToken(callbackUrl);
  const token = response.getJson();
  const realmId = client.getToken().realmId || realmIdFromQuery;
  if (!realmId) throw qboError(400, 'QuickBooks did not return a company id');
  // One connected company at a time.
  await withTransaction(async (tx) => {
    await tx.query('DELETE FROM qbo_auth_tokens WHERE realm_id <> $1', [realmId]);
    await saveTokens(tx, realmId, token);
  });
  return realmId;
}

async function connection(db) {
  const { rows } = await db.query('SELECT * FROM qbo_auth_tokens ORDER BY updated_at DESC LIMIT 1');
  return rows[0] || null;
}

/** A valid access token, refreshing (and persisting the rotation) when close to expiry. */
async function accessToken(db) {
  const current = await connection(db);
  if (!current) throw qboError(409, 'QuickBooks is not connected');
  if (new Date(current.access_token_expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return { realmId: current.realm_id, token: decrypt(current.access_token_enc) };
  }
  return withTransaction(async (tx) => {
    const { rows } = await tx.query('SELECT * FROM qbo_auth_tokens WHERE realm_id = $1 FOR UPDATE', [current.realm_id]);
    const row = rows[0];
    // Another request may have refreshed while we waited for the lock.
    if (new Date(row.access_token_expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return { realmId: row.realm_id, token: decrypt(row.access_token_enc) };
    }
    if (new Date(row.refresh_token_expires_at).getTime() <= Date.now()) {
      throw qboError(409, 'The QuickBooks connection has expired; reconnect QuickBooks');
    }
    let refreshed;
    try {
      refreshed = (await oauthClient().refreshUsingToken(decrypt(row.refresh_token_enc))).getJson();
    } catch (e) {
      // invalid_grant: the connection was revoked (e.g. disconnected inside QuickBooks). Forget it
      // so the panel shows "not connected" and offers Connect again.
      if (/invalid_grant/i.test(`${e.error || ''} ${e.message || ''} ${JSON.stringify(e.authResponse?.json || '')}`)) {
        await tx.query('DELETE FROM qbo_auth_tokens WHERE realm_id = $1', [row.realm_id]);
      }
      throw qboError(409, 'QuickBooks refused to refresh the connection; reconnect QuickBooks');
    }
    await saveTokens(tx, row.realm_id, refreshed);
    return { realmId: row.realm_id, token: refreshed.access_token };
  });
}

/** GET a QuickBooks API path (relative to /v3/company/{realm}). */
async function apiGet(db, path, params = {}, retried = false) {
  const { realmId, token } = await accessToken(db);
  const base = API_BASE[config.qbo.environment === 'production' ? 'production' : 'sandbox'];
  const url = new URL(`${base}/v3/company/${realmId}${path}`);
  for (const [k, v] of Object.entries({ ...params, minorversion: MINOR_VERSION })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  // Access token rejected before its stated expiry: mark it expired and retry once with a refresh.
  if (res.status === 401 && !retried) {
    await db.query('UPDATE qbo_auth_tokens SET access_token_expires_at = NOW() WHERE realm_id = $1', [realmId]);
    return apiGet(db, path, params, true);
  }
  if (!res.ok) {
    const detail = body?.Fault?.Error?.[0];
    throw qboError(res.status === 401 ? 409 : 502,
      `QuickBooks API error ${res.status}: ${detail?.Message || res.statusText}${detail?.Detail ? ` (${detail.Detail})` : ''}`);
  }
  return body;
}

/** The API surface the sync uses; tests substitute a fake with the same shape. */
function api(db) {
  return {
    query: async (sql) => (await apiGet(db, '/query', { query: sql })).QueryResponse || {},
    changedInvoices: async (sinceIso) => {
      const body = await apiGet(db, '/cdc', { entities: 'Invoice', changedSince: sinceIso });
      return body?.CDCResponse?.[0]?.QueryResponse?.[0]?.Invoice || [];
    }
  };
}

async function disconnect(db) {
  const current = await connection(db);
  if (!current) return;
  try {
    await oauthClient().revoke({ refresh_token: decrypt(current.refresh_token_enc) });
  } catch {
    // Revocation is best effort; the local tokens are removed either way.
  }
  await db.query('DELETE FROM qbo_auth_tokens');
}

module.exports = { isConfigured, authorizeUri, exchangeCode, connection, api, disconnect, qboError };
