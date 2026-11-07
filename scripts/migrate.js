const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

/**
 * Apply every pending SQL migration in filename order. Throws on failure.
 * Used by `npm run migrate` and by server.js on every boot, so a deploy can
 * never run new code against an old schema.
 */
async function runMigrations({ log = console.log } = {}) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });

  try {
    log('🔄 Running database migrations...\n');

    const migrationCandidates = [
      path.join(__dirname, '../db/migrations'),
      path.join(__dirname, '../../db/migrations')
    ];
    let migrationsDir;
    for (const candidate of migrationCandidates) {
      try {
        await fs.access(candidate);
        migrationsDir = candidate;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!migrationsDir) {
      throw new Error(`Migration directory not found. Checked: ${migrationCandidates.join(', ')}`);
    }
    const files = await fs.readdir(migrationsDir);
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

    // Each file runs once; later files may change objects earlier files create.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename VARCHAR(255) PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    const { rows } = await pool.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map(r => r.filename));

    for (const file of sqlFiles) {
      if (applied.has(file)) continue;
      log(`   Executing: ${file}`);
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${err.message}`);
      } finally {
        client.release();
      }
      log(`   ✓ ${file} completed`);
    }

    console.log('\n✅ All migrations completed successfully\n');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations().catch((error) => {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  });
}

module.exports = runMigrations;
