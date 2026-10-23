const { testDatabaseUrl } = require('./testDb');

// Must run before the app (and its pool) is required.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
