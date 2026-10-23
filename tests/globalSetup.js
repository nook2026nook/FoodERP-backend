const { Client } = require('pg');
const { testDatabaseUrl } = require('./testDb');

// Create the test database if needed and bring it to the latest schema.
module.exports = async () => {
  const url = new URL(testDatabaseUrl());
  const dbName = decodeURIComponent(url.pathname.slice(1));

  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rows.length) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  await client.end();

  // Point the migration runner at the test database, then restore the env so
  // setupEnv.js derives the same test URL in every test process.
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url.toString();
  try {
    const runMigrations = require('../scripts/migrate');
    await runMigrations();
  } finally {
    process.env.DATABASE_URL = original;
  }
};
