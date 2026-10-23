// Token refresh must persist the NEW access token, the NEW (rotated) refresh token
// and BOTH expiry times; the guide's version saved only part and could lock the account out.
jest.mock('intuit-oauth', () => {
  const refreshUsingToken = jest.fn(async () => ({
    getJson: () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, x_refresh_token_expires_in: 8726400 })
  }));
  function OAuthClient() { this.refreshUsingToken = refreshUsingToken; }
  OAuthClient.scopes = { Accounting: 'com.intuit.quickbooks.accounting' };
  OAuthClient.refreshUsingToken = refreshUsingToken;
  return OAuthClient;
});

process.env.QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || 'test-client';
process.env.QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || 'test-secret';

const OAuthClient = require('intuit-oauth');
const { pool } = require('./helpers');
const qboClient = require('../utils/qboClient');
const { encrypt, decrypt } = require('../utils/crypto');

beforeAll(async () => {
  await pool.query('DELETE FROM qbo_auth_tokens');
  await pool.query(
    `INSERT INTO qbo_auth_tokens (realm_id, access_token_enc, refresh_token_enc, access_token_expires_at, refresh_token_expires_at)
     VALUES ('realm-9',$1,$2,NOW() - INTERVAL '1 minute', NOW() + INTERVAL '50 days')`,
    [encrypt('old-access'), encrypt('old-refresh')]
  );
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ QueryResponse: { Invoice: [] } }) }));
});

afterAll(async () => {
  await pool.query('DELETE FROM qbo_auth_tokens');
  await pool.end();
});

test('an expired access token is refreshed and the rotation is saved in full', async () => {
  await qboClient.api(pool).query('SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 1');

  expect(OAuthClient.refreshUsingToken).toHaveBeenCalledWith('old-refresh');
  const [, init] = global.fetch.mock.calls[0];
  expect(init.headers.Authorization).toBe('Bearer new-access');

  const { rows } = await pool.query('SELECT * FROM qbo_auth_tokens');
  expect(decrypt(rows[0].access_token_enc)).toBe('new-access');
  expect(decrypt(rows[0].refresh_token_enc)).toBe('new-refresh');
  const accessMs = new Date(rows[0].access_token_expires_at) - Date.now();
  const refreshDays = (new Date(rows[0].refresh_token_expires_at) - Date.now()) / 86400000;
  expect(accessMs).toBeGreaterThan(55 * 60 * 1000);
  expect(refreshDays).toBeGreaterThan(99);
});

test('a fresh token is used without refreshing', async () => {
  OAuthClient.refreshUsingToken.mockClear();
  await qboClient.api(pool).query('SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 1');
  expect(OAuthClient.refreshUsingToken).not.toHaveBeenCalled();
});
