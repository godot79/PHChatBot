const express = require('express');
const router = express.Router();

const SecurityMiddleware = require('../middleware/SecurityMiddleware');
const Logger = require('../core/Logger');
const db = require('../core/DatabaseManager');

const logger = new Logger('AdminRoute');
const security = new SecurityMiddleware();

// Apply security middleware to all /admin routes
router.use(security.getAdminMiddleware());

/**
 * Admin dashboard - Console (consider renaming to "/admin/dashboard" for clarity)
 */
router.get('/console', (req, res) => {
  res.json({
    message: 'Admin Console Accessed',
    timestamp: new Date().toISOString()
  });
});

/**
 * Admin: List sessions
 */
router.get('/sessions', async (req, res) => {
  try {
    const query = `SELECT * FROM sessions ORDER BY created_at DESC LIMIT 100`;
    const sessions = await db.allAsync(query);
    res.json({ sessions });
  } catch (err) {
    logger.error('Failed to fetch sessions:', err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

/**
 * Admin: List chat history
 */
router.get('/chat-history', async (req, res) => {
  try {
    const query = `SELECT * FROM chat_history ORDER BY timestamp DESC LIMIT 100`;
    const messages = await db.allAsync(query);
    res.json({ messages });
  } catch (err) {
    logger.error('Failed to fetch chat history:', err);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

module.exports = router;
