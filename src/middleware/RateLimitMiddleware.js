/**
 * Rate Limiting Middleware
 * Implements intelligent rate limiting for WhatsApp chatbot
 * Prevents spam and abuse while allowing legitimate usage
 */

const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');

const logger = new Logger('RateLimitMiddleware');
const dbManager = new DatabaseManager();

/**
 * In-memory store for rate limiting data
 * Using Map for better performance than objects
 */
class MemoryStore {
  constructor() {
    this.store = new Map();
    this.cleanup();
  }

  /**
   * Get current count for a key
   */
  get(key) {
    const data = this.store.get(key);
    if (!data) return null;
    
    if (Date.now() > data.resetTime) {
      this.store.delete(key);
      return null;
    }
    
    return data;
  }

  /**
   * Increment counter for a key
   */
  increment(key, windowMs) {
    const now = Date.now();
    const data = this.get(key);
    
    if (!data) {
      this.store.set(key, {
        count: 1,
        resetTime: now + windowMs,
        firstHit: now
      });
      return { count: 1, resetTime: now + windowMs };
    }
    
    data.count++;
    this.store.set(key, data);
    return { count: data.count, resetTime: data.resetTime };
  }

  /**
   * Reset counter for a key
   */
  reset(key) {
    this.store.delete(key);
  }

  /**
   * Clean up expired entries every 10 minutes
   */
  cleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, data] of this.store.entries()) {
        if (now > data.resetTime) {
          this.store.delete(key);
        }
      }
    }, 10 * 60 * 1000); // 10 minutes
  }

  /**
   * Get store statistics
   */
  getStats() {
    return {
      totalKeys: this.store.size,
      activeEntries: Array.from(this.store.values()).filter(
        data => Date.now() < data.resetTime
      ).length
    };
  }
}

const rateLimitStore = new MemoryStore();

/**
 * Enhanced key generator that considers phone number and endpoint
 */
function createRateLimitKey(req) {
  const phoneNumber = extractPhoneNumber(req);
  const endpoint = req.route?.path || req.path;
  const method = req.method;
  
  return `${phoneNumber}:${method}:${endpoint}`;
}

/**
 * Extract phone number from various request sources
 */
function extractPhoneNumber(req) {
  // From WhatsApp webhook payload
  if (req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from) {
    return req.body.entry[0].changes[0].value.messages[0].from;
  }
  
  // From URL parameters
  if (req.params?.phoneNumber) {
    return req.params.phoneNumber;
  }
  
  // From query parameters
  if (req.query?.phoneNumber) {
    return req.query.phoneNumber;
  }
  
  // From request body
  if (req.body?.phoneNumber) {
    return req.body.phoneNumber;
  }
  
  // Fallback to IP address
  return req.ip || req.connection.remoteAddress || 'unknown';
}

/**
 * Custom rate limit handler
 */
function rateLimitHandler(req, res) {
  const phoneNumber = extractPhoneNumber(req);
  const endpoint = req.route?.path || req.path;
  
  logger.warn('Rate limit exceeded', {
    phoneNumber,
    endpoint,
    method: req.method,
    userAgent: req.get('user-agent'),
    ip: req.ip
  });

  // Log to database for analysis
  dbManager.logRateLimitViolation(phoneNumber, endpoint, req.method)
    .catch(error => logger.error('Failed to log rate limit violation:', error));

  // Different responses based on endpoint
  if (endpoint.includes('/webhook')) {
    // For WhatsApp webhooks, return 200 to avoid retries
    return res.status(200).json({
      message: 'Please wait before sending another message'
    });
  }

  // For admin endpoints
  return res.status(429).json({
    error: 'Too many requests',
    message: 'Please wait before making another request',
    retryAfter: res.get('Retry-After')
  });
}

/**
 * WhatsApp message rate limiting
 * Prevents spam messages from users
 */
const whatsAppMessageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // 15 messages per minute per phone number
  keyGenerator: createRateLimitKey,
  store: {
    incr: (key, cb) => {
      try {
        const result = rateLimitStore.increment(key, 60 * 1000);
        cb(null, result.count, new Date(result.resetTime));
      } catch (error) {
        cb(error);
      }
    },
    decrement: (key) => {
      // Not used in our implementation
    },
    resetKey: (key) => {
      rateLimitStore.reset(key);
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: (req) => {
    // Skip rate limiting for webhook verification
    return req.method === 'GET' && req.path.includes('/webhook');
  }
});

/**
 * Admin API rate limiting
 * More permissive for authenticated admin users
 */
const adminApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute for admin endpoints
  keyGenerator: (req) => {
    // Use authenticated user ID if available, otherwise fall back to IP
    return req.user?.id || req.ip;
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

/**
 * Strict rate limiting for sensitive operations
 * Login attempts, user verification, etc.
 */
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  keyGenerator: createRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skipSuccessfulRequests: true // Don't count successful requests
});

/**
 * Progressive slowdown for repeated requests
 * Slows down requests instead of blocking them completely
 */
const progressiveSlowDown = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 5, // Start slowing down after 5 requests
  delayMs: 500, // Increase delay by 500ms for each request
  maxDelayMs: 10000, // Maximum delay of 10 seconds
  keyGenerator: createRateLimitKey,
  skip: (req) => {
    // Skip slowdown for health checks
    return req.path.includes('/health');
  }
});

/**
 * Burst protection for webhook endpoints
 * Protects against sudden bursts of messages
 */
const burstProtection = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 5, // 5 requests per 10 seconds
  keyGenerator: createRateLimitKey,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Burst protection triggered', {
      phoneNumber: extractPhoneNumber(req),
      path: req.path
    });
    
    res.status(429).json({
      error: 'Too many requests in short time',
      message: 'Please slow down your requests'
    });
  }
});

/**
 * Intelligent rate limiting based on user verification status
 */
async function intelligentRateLimit(req, res, next) {
  try {
    const phoneNumber = extractPhoneNumber(req);
    
    if (phoneNumber === 'unknown') {
      return next();
    }

    // Check if user is verified
    const isVerified = await dbManager.isUserVerified(phoneNumber);
    
    if (isVerified) {
      // Verified users get higher limits
      const verifiedLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 30, // 30 messages per minute for verified users
        keyGenerator: () => phoneNumber,
        standardHeaders: false,
        legacyHeaders: false,
        handler: rateLimitHandler
      });
      
      return verifiedLimiter(req, res, next);
    } else {
      // Unverified users get standard limits
      return whatsAppMessageLimiter(req, res, next);
    }
  } catch (error) {
    logger.error('Intelligent rate limit error:', error);
    // Fallback to standard rate limiting on error
    return whatsAppMessageLimiter(req, res, next);
  }
}

/**
 * Global rate limiting for all endpoints
 */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    logger.warn('Global rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      path: req.path
    });
    
    res.status(429).json({
      error: 'Too many requests from this IP',
      message: 'Global rate limit exceeded'
    });
  }
});

/**
 * Rate limit middleware for different endpoint types
 */
const RateLimitMiddleware = {
  // Apply to all requests
  global: globalLimiter,
  
  // WhatsApp webhook endpoints
  webhook: [burstProtection, intelligentRateLimit, progressiveSlowDown],
  
  // Admin API endpoints
  admin: adminApiLimiter,
  
  // Sensitive operations (login, verification)
  strict: strictLimiter,
  
  // Progressive slowdown only
  slowDown: progressiveSlowDown,
  
  // Burst protection only
  burst: burstProtection,
  
  /**
   * Custom rate limiter factory
   */
  custom: (options) => {
    return rateLimit({
      keyGenerator: createRateLimitKey,
      standardHeaders: true,
      legacyHeaders: false,
      handler: rateLimitHandler,
      ...options
    });
  },

  /**
   * Get rate limiting statistics
   */
  async getStats() {
    try {
      const storeStats = rateLimitStore.getStats();
      const dbStats = await dbManager.getRateLimitStats();
      
      return {
        store: storeStats,
        violations: dbStats,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to get rate limit stats:', error);
      return {
        error: 'Failed to retrieve statistics',
        timestamp: new Date().toISOString()
      };
    }
  },

  /**
   * Reset rate limits for a specific key
   */
  resetLimits(phoneNumber, endpoint) {
    const key = `${phoneNumber}:${endpoint}`;
    rateLimitStore.reset(key);
    logger.info('Rate limits reset', { phoneNumber, endpoint });
  },

  /**
   * Check if a key is currently rate limited
   */
  isRateLimited(phoneNumber, endpoint, windowMs = 60000, max = 15) {
    const key = `${phoneNumber}:${endpoint}`;
    const data = rateLimitStore.get(key);
    
    return data && data.count >= max;
  },

  /**
   * Whitelist middleware - bypasses rate limiting for whitelisted users
   */
  whitelist: (whitelistedNumbers = []) => {
    return (req, res, next) => {
      const phoneNumber = extractPhoneNumber(req);
      
      if (whitelistedNumbers.includes(phoneNumber)) {
        logger.debug('Rate limit bypassed for whitelisted number', { phoneNumber });
        return next();
      }
      
      return intelligentRateLimit(req, res, next);
    };
  }
};

module.exports = RateLimitMiddleware;
