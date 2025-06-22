/**
 * Admin Management Route Handler
 * Provides administrative endpoints for monitoring and managing the chatbot
 */

const express = require('express');
const router = express.Router();
const DatabaseManager = require('../core/DatabaseManager');
const SessionManager = require('../core/SessionManager');
const ChatbotEngine = require('../core/ChatbotEngine');
const WhatsAppAPI = require('../api/WhatsAppAPI');
const ClinikoAPI = require('../api/ClinikoAPI');
const Logger = require('../core/Logger');
const { SecurityMiddleware } = require('../middleware/SecurityMiddleware');
const { ValidationMiddleware } = require('../middleware/ValidationMiddleware');

const logger = new Logger('AdminRoute');
const dbManager = new DatabaseManager();
const sessionManager = new SessionManager();
const chatbotEngine = new ChatbotEngine();
const whatsAppAPI = new WhatsAppAPI();
const clinikoAPI = new ClinikoAPI();

/**
 * Dashboard overview endpoint
 * GET /admin/dashboard
 */
router.get('/dashboard',
  SecurityMiddleware.requireAuth,
  async (req, res) => {
    try {
      const [
        totalSessions,
        activeSessions,
        totalConversations,
        totalBookings,
        systemHealth
      ] = await Promise.all([
        dbManager.getTotalSessions(),
        sessionManager.getActiveSessionsCount(),
        dbManager.getTotalConversations(),
        dbManager.getTotalBookings(),
        getSystemHealth()
      ]);

      const dashboard = {
        overview: {
          totalSessions,
          activeSessions,
          totalConversations,
          totalBookings,
          uptime: process.uptime()
        },
        systemHealth
      };

      res.json(dashboard);
    } catch (error) {
      logger.error('Dashboard data retrieval failed:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve dashboard data'
      });
    }
  }
);

/**
 * Sessions management endpoints
 */

// Get all sessions with pagination
router.get('/sessions',
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validatePagination,
  async (req, res) => {
    try {
      const { page = 1, limit = 20, status, phoneNumber } = req.query;
      
      const filters = {};
      if (status) filters.status = status;
      if (phoneNumber) filters.phoneNumber = phoneNumber;

      const sessions = await dbManager.getSessions({
        page: parseInt(page),
        limit: parseInt(limit),
        filters
      });

      res.json(sessions);
    } catch (error) {
      logger.error('Failed to retrieve sessions:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve sessions'
      });
    }
  }
);

// Get specific session details
router.get('/sessions/:sessionId',
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validateSessionId,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = await dbManager.getSessionById(sessionId);
      
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      // Get conversation history for this session
      const conversations = await dbManager.getConversationsBySession(sessionId);
      
      res.json({
        session,
        conversations
      });
    } catch (error) {
      logger.error('Failed to retrieve session details:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve session details'
      });
    }
  }
);

// Terminate a session
router.post('/sessions/:sessionId/terminate',
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validateSessionId,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { reason } = req.body;

      await sessionManager.terminateSession(sessionId, reason);
      
      logger.info('Session terminated by admin', { sessionId, reason });
      
      res.json({
        success: true,
        message: 'Session terminated successfully'
      });
    } catch (error) {
      logger.error('Failed to terminate session:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to terminate session'
      });
    }
  }
);

/**
 * Conversation management endpoints
 */

// Get conversations with search and filters
router.get('/conversations',
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validatePagination,
  async (req, res) => {
    try {
      const { page = 1, limit = 50, phoneNumber, dateFrom, dateTo, messageType } = req.query;
      
      const filters = {};
      if (phoneNumber) filters.phoneNumber = phoneNumber;
      if (dateFrom) filters.dateFrom = dateFrom;
      if (dateTo) filters.dateTo = dateTo;
      if (messageType) filters.messageType = messageType;

      const conversations = await dbManager.getConversations({
        page: parseInt(page),
        limit: parseInt(limit),
        filters
      });

      res.json(conversations);
    } catch (error) {
      logger.error('Failed to retrieve conversations:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve conversations'
      });
    }
  }
);

// Get conversation analytics
router.get('/conversations/analytics',
  SecurityMiddleware.requireAuth,
  async (req, res) => {
    try {
      const { period = '7days' } = req.query;
      
      const analytics = await dbManager.getConversationAnalytics(period);
      
      res.json(analytics);
    } catch (error) {
      logger.error('Failed to retrieve conversation analytics:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve conversation analytics'
      });
    }
  }
);

/**
 * User/Patient management endpoints
 */

// Get verified users list
router.get('/users',
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validatePagination,
  async (req, res) => {
    try {
      const { page = 1, limit = 20, verified, phoneNumber } = req.query;
      
      const filters = {};
      if (verified !== undefined) filters.verified = verified === 'true';
      if (phoneNumber) filters.phoneNumber = phoneNumber;

      const users = await dbManager.getUsers({
        page: parseInt(page),
        limit: parseInt(limit),
        filters
      });

      res.json(users);
    } catch (error) {
      logger.error('Failed to retrieve users:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve users'
      });
    }
  }
);

// Manually verify a user
router.post('/users/:phoneNumber/verify',
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validatePhoneNumber,
  async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const { clinikoPatientId, reason } = req.body;

      await sessionManager.verifyUser(phoneNumber, clinikoPatientId, 'admin_verified');
      
      logger.info('User manually verified by admin', { phoneNumber, clinikoPatientId, reason });
      
      res.json({
        success: true,
        message: 'User verified successfully'
      });
    } catch (error) {
      logger.error('Failed to verify user:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to verify user'
      });
    }
  }
);

/**
 * System management endpoints
 */

// Send broadcast message
router.post('/broadcast',
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validateBroadcast,
  async (req, res) => {
    try {
      const { message, targetType, phoneNumbers } = req.body;
      
      let recipients = [];
      
      if (targetType === 'all_verified') {
        recipients = await dbManager.getAllVerifiedUsers();
      } else if (targetType === 'specific' && phoneNumbers) {
        recipients = phoneNumbers.map(phone => ({ phoneNumber: phone }));
      }

      const results = [];
      for (const recipient of recipients) {
        try {
          const result = await whatsAppAPI.sendMessage(recipient.phoneNumber, message);
          results.push({
            phoneNumber: recipient.phoneNumber,
            success: true,
            messageId: result.messageId
          });
        } catch (error) {
          results.push({
            phoneNumber: recipient.phoneNumber,
            success: false,
            error: error.message
          });
        }
      }

      logger.info('Broadcast message sent', { 
        totalRecipients: recipients.length,
        successful: results.filter(r => r.success).length
      });

      res.json({
        success: true,
        results,
        summary: {
          total: recipients.length,
          successful: results.filter(r => r.success).length,
          failed: results.filter(r => !r.success).length
        }
      });
    } catch (error) {
      logger.error('Broadcast failed:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send broadcast message'
      });
    }
  }
);

// System configuration
router.get('/config',
  SecurityMiddleware.requireAuth,
  async (req, res) => {
    try {
      const config = {
        whatsapp: {
          businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ? '[CONFIGURED]' : '[NOT CONFIGURED]',
          phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ? '[CONFIGURED]' : '[NOT CONFIGURED]'
        },
        cliniko: {
          apiKey: process.env.CLINIKO_API_KEY ? '[CONFIGURED]' : '[NOT CONFIGURED]',
          baseUrl: process.env.CLINIKO_BASE_URL || '[NOT SET]'
        },
        database: {
          type: 'SQLite',
          path: process.env.DATABASE_PATH || './data/chatbot.db'
        },
        environment: process.env.NODE_ENV || 'development'
      };

      res.json(config);
    } catch (error) {
      logger.error('Failed to retrieve config:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve configuration'
      });
    }
  }
);

// Clear old data
router.post('/maintenance/cleanup',
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validateCleanup,
  async (req, res) => {
    try {
      const { days = 30, type = 'all' } = req.body;
      
      const cleanup = await dbManager.cleanupOldData(days, type);
      
      logger.info('Data cleanup completed', cleanup);
      
      res.json({
        success: true,
        cleanup
      });
    } catch (error) {
      logger.error('Data cleanup failed:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to cleanup old data'
      });
    }
  }
);

/**
 * Export data endpoints
 */

// Export conversations
router.get('/export/conversations',
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validateExport,
  async (req, res) => {
    try {
      const { format = 'json', dateFrom, dateTo } = req.query;
      
      const data = await dbManager.exportConversations({ dateFrom, dateTo });
      
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=conversations.csv');
        res.send(convertToCSV(data));
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=conversations.json');
        res.json(data);
      }
    } catch (error) {
      logger.error('Export failed:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to export data'
      });
    }
  }
);

/**
 * Helper function to get system health
 */
async function getSystemHealth() {
  const health = {
    database: false,
    whatsapp: false,
    cliniko: false,
    memory: process.memoryUsage(),
    uptime: process.uptime()
  };

  try {
    await dbManager.healthCheck();
    health.database = true;
  } catch (error) {
    logger.error('Database health check failed:', error);
  }

  try {
    await whatsAppAPI.healthCheck();
    health.whatsapp = true;
  } catch (error) {
    logger.error('WhatsApp health check failed:', error);
  }

  try {
    await clinikoAPI.healthCheck();
    health.cliniko = true;
  } catch (error) {
    logger.error('Cliniko health check failed:', error);
  }

  return health;
}

/**
 * Helper function to convert JSON to CSV
 */
function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  
  const headers = Object.keys(data[0]).join(',');
  const rows = data.map(row => 
    Object.values(row).map(value => 
      typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value
    ).join(',')
  );
  
  return [headers, ...rows].join('\n');
}

module.exports = router;
