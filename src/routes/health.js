const express = require('express');
const router = express.Router();

const Logger = require('../core/Logger');
const DatabaseManager = require('../core/DatabaseManager');
const WhatsAppAPI = require('../api/WhatsAppAPI');
const ClinikoAPI = require('../api/ClinikoAPI');
const SecurityMiddleware = require('../middleware/SecurityMiddleware');

const logger = new Logger('HealthCheck');
const dbManager = new DatabaseManager();
const whatsAppAPI = new WhatsAppAPI();
const clinikoAPI = new ClinikoAPI();
const security = new SecurityMiddleware();

// Auth middleware for protected health endpoints
function requireAuth(req, res, next) {
  try {
    return security.verifyApiKey.bind(security)(req, res, next);
  } catch (err) {
    logger.error('SecurityMiddleware requireAuth failure:', err);
    res.status(500).json({ error: 'Authentication failure' });
  }
}

// --- Basic heartbeat
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// --- Detailed health status (protected)
router.get('/detailed', requireAuth, async (req, res) => {
  const result = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    checks: {}
  };

  // DB
  try {
    await dbManager.testConnection?.();
    result.checks.database = { status: 'ok' };
  } catch (err) {
    result.status = 'degraded';
    result.checks.database = { status: 'fail', error: err.message || 'DB check failed' };
    logger.error('❌ DB check failed:', err);
  }

  // WhatsApp
  try {
    await whatsAppAPI.getBusinessProfile?.();
    result.checks.whatsapp = { status: 'ok' };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    result.status = 'degraded';
    result.checks.whatsapp = { status: 'fail', error: msg };
    logger.error('❌ WhatsApp check failed:', msg);
  }

  // Cliniko
  try {
    await clinikoAPI.healthCheck?.();
    result.checks.cliniko = { status: 'ok' };
  } catch (err) {
    result.status = 'degraded';
    result.checks.cliniko = { status: 'fail', error: err.message };
    logger.error('❌ Cliniko check failed:', err);
  }

  res.status(200).json(result);
});

module.exports = router;
