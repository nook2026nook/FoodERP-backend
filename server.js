const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();
// One pool for the whole app, shared with withTransaction().
const { pool } = require('./db');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Request logging in development
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// Database connection middleware
app.use((req, res, next) => {
  req.db = pool;
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: 'Database connection failed'
    });
  }
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/vault', require('./routes/vault'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/items', require('./routes/items'));
app.use('/api/lots', require('./routes/lots'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/batches', require('./routes/batches'));
app.use('/api/shipments', require('./routes/shipments'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/recall', require('./routes/recall'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/qbo', require('./routes/qbo'));
app.use('/api/admin', require('./routes/admin'));

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  const path = require('path');
  app.use(express.static(path.join(__dirname, '../frontend/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.errors
    });
  }

  if (err.name === 'UnauthorizedError' || err.message === 'Unauthorized') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (err.code === '23505') { // Postgres unique violation
    return res.status(409).json({
      error: 'Duplicate entry',
      field: err.constraint
    });
  }

  if (err.code === '23503') { // Foreign key violation
    return res.status(400).json({
      error: 'Referenced record not found'
    });
  }

  // Don't expose internal errors in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(err.status || 500).json({ error: message });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

const PORT = process.env.PORT || 5000;

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  await pool.end();
  process.exit(0);
});

// Tests import the app without opening a port.
if (require.main === module) app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   FoodTrace ERP Backend Server Running    ║
╠═══════════════════════════════════════════╣
║  Environment: ${process.env.NODE_ENV?.padEnd(28) || 'development'.padEnd(28)}║
║  Port:        ${PORT.toString().padEnd(28)}║
║  Database:    ${pool.options.database?.padEnd(28) || 'Connected'.padEnd(28)}║
╚═══════════════════════════════════════════╝
  `);
});

module.exports = app;
