const { hashPassword } = require('../utils/password');
const { Pool } = require('pg');
require('dotenv').config();

async function seedDatabase() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('🌱 Seeding database...\n');

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@naturesmix.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeThisPassword123!';

    // Hash password with argon2id (same as backend login)
    const passwordHash = await hashPassword(adminPassword);

    // Insert admin user once; never overwrite a password the admin has since changed.
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, force_password_reset, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, role`,
      [adminEmail, passwordHash, 'System Administrator', 'Administrator', true, true]
    );

    if (result.rows.length === 0) {
      console.log(`   - Admin user ${adminEmail} already exists; left unchanged`);
    } else {
      console.log('   ✓ Admin user created:');
      console.log(`     Email: ${result.rows[0].email}`);
      console.log(`     Role: ${result.rows[0].role}`);
      console.log(`     Force Password Reset: Yes`);
      console.log(`\n   ⚠️  IMPORTANT: Change the admin password on first login!\n`);
    }

    console.log('✅ Database seeded successfully\n');
  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  seedDatabase();
}

module.exports = seedDatabase;
