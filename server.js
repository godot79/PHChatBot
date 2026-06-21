require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

// Core setup
const Logger = require('./src/core/Logger');
const DatabaseManager = require('./src/core/DatabaseManager');

const logger = new Logger('Server');
const dbManager = new DatabaseManager();

const app = express();
const PORT = process.env.PORT || 3000;

// --- Security & Parsing Middleware ---
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://your-production-domain.com']
    : [`http://localhost:${PORT}`, 'http://127.0.0.1:3000']
}));
app.set('trust proxy', 1);

// --- WhatsApp Webhook RAW Body Parsing ---
// Must come before any body parsing middleware!
app.use('/webhook', express.raw({ type: 'application/json' }));

// --- Webhook Route (must come before JSON parsing) ---
app.use('/webhook', require('./src/routes/webhook'));

// --- JSON Body Parser for all other routes ---
app.use(express.json());

// --- Static Assets ---
app.use(express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));

// --- Request Logging ---
app.use((req, res, next) => {
  logger.info(`🧭 Incoming request: ${req.method} ${req.path}`);
  next();
});

// --- Database Initialization, then Routing & Error Handling ---
(async () => {
  try {
    logger.info('🔌 Initializing database...');
    await dbManager.initialize();
    logger.info('✅ Database initialized.');

    // --- Main Routes ---
    app.use('/health', require('./src/routes/health'));
    app.use('/admin', require('./src/routes/admin')); // <--- /admin mapped correctly here
    app.use('/', require('./src/routes/index'));

    // --- Default Frontend (for browser root) ---
    app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // --- 404 Handler ---
    app.use((req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });

    // --- Global Error Handler ---
    app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    // --- Start Server ---
    app.listen(PORT,'0.0.0.0', () => {
      logger.info(`🚀 Server running at http://localhost:${PORT}`);
    });

  } catch (err) {
    logger.error('❌ Database init failed:');
    console.error(err);
    process.exit(1);
  }
})();
