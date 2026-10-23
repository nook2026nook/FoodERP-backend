const { Pool, types } = require('pg');

// Keep DATE columns as 'YYYY-MM-DD' strings; parsing them into JS Dates shifts
// them by the server's time zone when serialised to JSON.
types.setTypeParser(1082, (value) => value);
const config = require('./config');
const logger = require('./logger');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.isProd ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.PGPOOL_MAX || '10', 10),
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => logger.error({ err }, 'Unexpected postgres pool error'));

// Express middleware: attach a pooled client as req.db
function attachDb(req, res, next) {
  req.db = pool;
  next();
}

/** Run fn inside a transaction, committing on success and rolling back on error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, attachDb, withTransaction };
