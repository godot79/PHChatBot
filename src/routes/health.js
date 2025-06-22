/**
 * System Health Monitoring Route Handler
 * Provides health check endpoints for monitoring system status
 */

const express = require('express');
const router = express.Router();
const DatabaseManager = require('../core/DatabaseManager');
const WhatsAppAPI = require('../api/WhatsAppAPI');
const ClinikoAPI = require('../api/ClinikoAPI');
const Logger = require('../core/Logger');
const { SecurityMiddleware } = require('../middleware/SecurityMiddleware');

const logger = new Logger('HealthRoute');
const dbManager = new DatabaseManager();
const whatsAppAPI = new WhatsAppAPI();
const clinikoAPI = new ClinikoAPI();

/**
 * Basic health check endpoint
 * GET /health
 * Returns 200 if the service is running
 */
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'whatsapp-chatbot'
  });
});

/**
 * Detailed health check endpoint
 * GET /health/detailed
 * Returns comprehensive health status of all system components
 */
router.get('/detailed', async (req, res) => {
  const healthCheck = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'whatsapp-chatbot',
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    components: {}
  };

  let overallHealthy = true;

  // Database health check
  try {
    const dbStart = Date.now();
    await dbManager.healthCheck();
    const dbResponseTime = Date.now() - dbStart;
    
    healthCheck.components.database = {
      status: 'healthy',
      responseTime: `${dbResponseTime}ms`,
      details: {
        type: 'SQLite',
        path: process.env.DATABASE_PATH || './data/chatbot.db'
      }
    };
  } catch (error) {
    overallHealthy = false;
    healthCheck.components.database = {
      status: 'unhealthy',
      error: error.message,
      details: {
        type: 'SQLite',
        path: process.env.DATABASE_PATH || './data/chatbot.db'
      }
    };
  }

  // WhatsApp API health check
  try {
    const whatsappStart = Date.now();
    await whatsAppAPI.healthCheck();
    const whatsappResponseTime = Date.now() - whatsappStart;
    
    healthCheck.components.whatsapp = {
      status: 'healthy',
      responseTime: `${whatsappResponseTime}ms`,
      details: {
        businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ? '[CONFIGURED]' : '[NOT CONFIGURED]',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ? '[CONFIGURED]' : '[NOT CONFIGURED]'
      }
    };
  } catch (error) {
    overallHealthy = false;
    healthCheck.components.whatsapp = {
      status: 'unhealthy',
      error: error.message,
      details: {
        businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ? '[CONFIGURED]' : '[NOT CONFIGURED]',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ? '[CONFIGURED]' : '[NOT CONFIGURED]'
      }
    };
  }

  // Cliniko API health check
  try {
    const clinikoStart = Date.now();
    await clinikoAPI.healthCheck();
    const clinikoResponseTime = Date.now() - clinikoStart;
    
    healthCheck.components.cliniko = {
      status: 'healthy',
      responseTime: `${clinikoResponseTime}ms`,
      details: {
        baseUrl: process.env.CLINIKO_BASE_URL || '[NOT SET]',
        apiKey: process.env.CLINIKO_API_KEY ? '[CONFIGURED]' : '[NOT CONFIGURED]'
      }
    };
  } catch (error) {
    overallHealthy = false;
    healthCheck.components.cliniko = {
      status: 'unhealthy',
      error: error.message,
      details: {
        baseUrl: process.env.CLINIKO_BASE_URL || '[NOT SET]',
        apiKey: process.env.CLINIKO_API_KEY ? '[CONFIGURED]' : '[NOT CONFIGURED]'
      }
    };
  }

  // System resources check
  const memoryUsage = process.memoryUsage();
  const memoryUsageMB = {
    rss: Math.round(memoryUsage.rss / 1024 / 1024),
    heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
    external: Math.round(memoryUsage.external / 1024 / 1024)
  };

  const heapUsedPercentage = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
  const systemResourcesHealthy = heapUsedPercentage < 90; // Flag if heap usage > 90%

  if (!systemResourcesHealthy) {
    overallHealthy = false;
  }

  healthCheck.components.system = {
    status: systemResourcesHealthy ? 'healthy' : 'warning',
    memory: {
      ...memoryUsageMB,
      heapUsedPercentage: Math.round(heapUsedPercentage)
    },
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch
  };

  // Set overall status
  healthCheck.status = overallHealthy ? 'healthy' : 'unhealthy';

  // Log health check results
  if (overallHealthy) {
    logger.debug('Health check completed - all systems healthy');
  } else {
    logger.warn('Health check completed - some systems unhealthy');
  }

  const statusCode = overallHealthy ? 200 : 503;
  res.status(statusCode).json(healthCheck);
});

/**
 * Database-specific health check
 * GET /health/database
 */
router.get('/database', async (req, res) => {
  try {
    const start = Date.now();
    const stats = await dbManager.getHealthStats();
    const responseTime = Date.now() - start;

    res.status(200).json({
      status: 'healthy',
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString(),
      configuration: {
        baseUrl: process.env.CLINIKO_BASE_URL || '[NOT SET]',
        apiKey: process.env.CLINIKO_API_KEY ? '[CONFIGURED]' : '[NOT CONFIGURED]'
      }
    });
  } catch (error) {
    logger.error('Cliniko health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Readiness check endpoint
 * GET /health/ready
 * Returns 200 only if all critical systems are operational
 */
router.get('/ready', async (req, res) => {
  try {
    // Check critical systems in parallel
    const [dbHealth, whatsappHealth, clinikoHealth] = await Promise.allSettled([
      dbManager.healthCheck(),
      whatsAppAPI.healthCheck(),
      clinikoAPI.healthCheck()
    ]);

    const allHealthy = [dbHealth, whatsappHealth, clinikoHealth]
      .every(result => result.status === 'fulfilled');

    if (allHealthy) {
      res.status(200).json({
        status: 'ready',
        timestamp: new Date().toISOString(),
        message: 'All systems operational'
      });
    } else {
      const failures = [];
      if (dbHealth.status === 'rejected') failures.push('database');
      if (whatsappHealth.status === 'rejected') failures.push('whatsapp');
      if (clinikoHealth.status === 'rejected') failures.push('cliniko');

      res.status(503).json({
        status: 'not ready',
        timestamp: new Date().toISOString(),
        failures
      });
    }
  } catch (error) {
    logger.error('Readiness check failed:', error);
    res.status(503).json({
      status: 'not ready',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Liveness check endpoint
 * GET /health/live
 * Returns 200 if the application is running (basic check)
 */
router.get('/live', (req, res) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    pid: process.pid
  });
});

/**
 * Metrics endpoint
 * GET /health/metrics
 * Returns system metrics for monitoring
 */
router.get('/metrics', 
  SecurityMiddleware.optionalAuth,
  async (req, res) => {
    try {
      const metrics = await collectMetrics();
      
      res.status(200).json({
        timestamp: new Date().toISOString(),
        metrics
      });
    } catch (error) {
      logger.error('Metrics collection failed:', error);
      res.status(500).json({
        error: 'Failed to collect metrics',
        timestamp: new Date().toISOString()
      });
    }
  }
);

/**
 * System info endpoint
 * GET /health/info
 * Returns system information
 */
router.get('/info', (req, res) => {
  const info = {
    service: 'whatsapp-chatbot',
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    startTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptime: process.uptime(),
    pid: process.pid
  };

  res.status(200).json(info);
});

/**
 * Performance endpoint
 * GET /health/performance
 * Returns performance metrics
 */
router.get('/performance', async (req, res) => {
  try {
    const start = process.hrtime.bigint();
    
    // Perform some operations to measure performance
    const [dbPerfStart, whatsappPerfStart, clinikoStart] = [
      process.hrtime.bigint(),
      process.hrtime.bigint(),
      process.hrtime.bigint()
    ];

    const [dbResult, whatsappResult, clinikoResult] = await Promise.allSettled([
      dbManager.performanceCheck(),
      whatsAppAPI.performanceCheck(),
      clinikoAPI.performanceCheck()
    ]);

    const performance = {
      timestamp: new Date().toISOString(),
      overall: {
        duration: Number(process.hrtime.bigint() - start) / 1000000, // Convert to milliseconds
      },
      components: {
        database: {
          status: dbResult.status,
          duration: dbResult.status === 'fulfilled' ? dbResult.value?.duration : null,
          error: dbResult.status === 'rejected' ? dbResult.reason?.message : null
        },
        whatsapp: {
          status: whatsappResult.status,
          duration: whatsappResult.status === 'fulfilled' ? whatsappResult.value?.duration : null,
          error: whatsappResult.status === 'rejected' ? whatsappResult.reason?.message : null
        },
        cliniko: {
          status: clinikoResult.status,
          duration: clinikoResult.status === 'fulfilled' ? clinikoResult.value?.duration : null,
          error: clinikoResult.status === 'rejected' ? clinikoResult.reason?.message : null
        }
      }
    };

    res.status(200).json(performance);
  } catch (error) {
    logger.error('Performance check failed:', error);
    res.status(500).json({
      error: 'Performance check failed',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Helper function to collect system metrics
 */
async function collectMetrics() {
  const memoryUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  
  // Get database metrics
  let dbMetrics = {};
  try {
    dbMetrics = await dbManager.getMetrics();
  } catch (error) {
    logger.error('Failed to collect database metrics:', error);
    dbMetrics = { error: 'Failed to collect database metrics' };
  }

  return {
    system: {
      memory: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system
      },
      uptime: process.uptime(),
      loadAverage: process.platform === 'linux' ? require('os').loadavg() : null
    },
    database: dbMetrics,
    application: {
      environment: process.env.NODE_ENV || 'development',
      nodeVersion: process.version,
      pid: process.pid
    }
  };
}

/**
 * Error handler for health routes
 */
router.use((error, req, res, next) => {
  logger.error('Health route error:', error);
  
  res.status(500).json({
    status: 'error',
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;: `${responseTime}ms`,
      timestamp: new Date().toISOString(),
      stats
    });
  } catch (error) {
    logger.error('Database health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * WhatsApp API health check
 * GET /health/whatsapp
 */
router.get('/whatsapp', async (req, res) => {
  try {
    const start = Date.now();
    await whatsAppAPI.healthCheck();
    const responseTime = Date.now() - start;

    res.status(200).json({
      status: 'healthy',
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString(),
      configuration: {
        businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ? '[CONFIGURED]' : '[NOT CONFIGURED]',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ? '[CONFIGURED]' : '[NOT CONFIGURED]'
      }
    });
  } catch (error) {
    logger.error('WhatsApp health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Cliniko API health check
 * GET /health/cliniko
 */
router.get('/cliniko', async (req, res) => {
  try {
    const start = Date.now();
    await clinikoAPI.healthCheck();
    const responseTime = Date.now() - start;

    res.status(200).json({
      status: 'healthy',
      responseTime
