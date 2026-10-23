// Tests run against a separate database: DATABASE_URL's database name + "_test",
// or TEST_DATABASE_URL when set. The real database is never touched.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}

module.exports = { testDatabaseUrl };
