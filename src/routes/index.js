/**
 * Routes Index File
 * Centralizes all route registrations for the WhatsApp Chatbot
 */

const express = require('express');
const router = express.Router();
const Logger = require('../core/Logger');

// Import route handlers
const webhookRoutes = require('./webhook');
const adminRoutes = require('./admin');
const healthRoutes = require('./health');

const logger = new Logger('Routes');

// Health check routes (no authentication required)
router.use('/health', healthRoutes);

// Webhook routes (WhatsApp integration)
router.use('/', webhookRoutes);

// Admin routes (authentication required)
router.use('/admin', adminRoutes);

/**
 * API documentation endpoint
 * GET /docs
 */
router.get('/docs', (req, res) => {
  res.json({
    service: 'WhatsApp Chatbot API',
    version: '1.0.0',
    description: 'API for WhatsApp chatbot with Cliniko integration',
    endpoints: {
      health: {
        '/health': 'Basic health check',
        '/health/detailed': 'Detailed health status',
        '/health/database': 'Database health check',
        '/health/whatsapp': 'WhatsApp API health check',
        '/health/cliniko': 'Cliniko API health check',
        '/health/ready': 'Readiness check',
        '/health/live': 'Liveness check',
        '/health/metrics': 'System metrics',
        '/health/info': 'System information',
        '/health/performance': 'Performance metrics'
      },
      webhook: {
        'GET /webhook': 'WhatsApp webhook verification',
        'POST /webhook': 'WhatsApp message handler',
        'POST /webhook/test-message': 'Send test message (admin)',
        'GET /webhook/stats': 'Webhook statistics (admin)'
      },
      admin: {
        'GET /admin/dashboard': 'Admin dashboard overview',
        'GET /admin/sessions': 'List user sessions',
        'GET /admin/sessions/:id': 'Get session details',
        'POST /admin/sessions/:id/terminate': 'Terminate session',
        'GET /admin/conversations': 'List conversations',
        'GET /admin/conversations/analytics': 'Conversation analytics',
        'GET /admin/users': 'List users',
        'POST /admin/users/:phone/verify': 'Verify user manually',
        'POST /admin/broadcast': 'Send broadcast message',
        'GET /admin/config': 'System configuration',
        'POST /admin/maintenance/cleanup': 'Cleanup old data',
        'GET /admin/export/conversations': 'Export conversation data'
      }
    },
    authentication: {
      admin: 'Bearer token required for admin endpoints',
      webhook: 'WhatsApp webhook signature verification'
    }
  });
});

/**
 * Root endpoint
 * GET /
 */
router.get('/', (req, res) => {
  res.json({
    service: 'WhatsApp Chatbot API',
    status: 'running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    documentation: '/docs'
  });
});

/**
 * Catch-all route for undefined endpoints
 */
router.use('*', (req, res) => {
  logger.warn(`404 - Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: 'Route not found',
    message: `The endpoint ${req.method} ${req.originalUrl} does not exist`,
    availableRoutes: [
      'GET /',
      'GET /docs',
      'GET /health',
      'GET /webhook',
      'POST /webhook',
      'GET /admin/*'
    ]
  });
});

/**
 * Global error handler for routes
 */
router.use((error, req, res, next) => {
  logger.error('Global route error:', error);
  const isDevelopment = process.env.NODE_ENV === 'development';
  res.status(500).json({
    error: 'Internal server error',
    message: isDevelopment ? error.message : 'Something went wrong',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
