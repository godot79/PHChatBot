const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');

/**
 * Advanced Rate Limiting Middleware for WhatsApp Healthcare Chatbot
 * Features: Multi-tier limits, intelligent user detection, burst protection
 */
class RateLimitMiddleware {
  constructor() {
    // Memory store for rate limiting (production should use Redis)
    this.store = new Map();
    this.stats = {
      totalRequests: 0,
      blockedRequests: 0,
      violations: [],
      startTime: Date.now()
    };
    
    // Whitelist for trusted phone numbers (format: +1234567890)
    this.whitelist = new Set([
      // Add trusted numbers here
      // '+1234567890',
    ]);
    
    // Initialize rate limiters
    this.initializeLimiters();
    
    // Cleanup old entries every 10 minutes
    setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  /**
   * Initialize all rate limiters with different configurations
   */
  initializeLimiters() {
    // 1. Global rate limiter - applies to all requests
    this.globalLimiter = rateLimit({
      windowMs: 1 * 60 * 1000, // 1 minute
      max: 200, // 200 requests per minute per IP
      message: {
        error: 'Too many requests from this IP',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: 60
      },
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => this.shouldSkipRateLimit(req),
      onLimitReached: (req) => this.logViolation(req, 'GLOBAL_LIMIT')
    });

    // 2. WhatsApp webhook rate limiter - intelligent per-phone-number limiting
    this.webhookLimiter = rateLimit({
      windowMs: 1 * 60 * 1000, // 1 minute
      max: (req) => this.getWhatsAppLimit(req), // Dynamic based on user status
      keyGenerator: (req) => this.getPhoneNumber(req) || req.ip,
      message: {
        error: 'Message rate limit exceeded',
        code: 'WHATSAPP_RATE_LIMIT',
        retryAfter: 60
      },
      skip: (req) => {
        // Skip GET requests (webhook verification)
        if (req.method === 'GET') return true;
        return this.shouldSkipRateLimit(req);
      },
      onLimitReached: (req) => this.logViolation(req, 'WHATSAPP_LIMIT')
    });

    // 3. Admin API rate limiter
    this.adminLimiter = rateLimit({
      windowMs: 1 * 60 * 1000, // 1 minute
      max: 100, // 100 requests per minute for admin
      keyGenerator: (req) => req.user?.id || req.ip,
      message: {
        error: 'Admin API rate limit exceeded',
        code: 'ADMIN_RATE_LIMIT',
        retryAfter: 60
      },
      onLimitReached: (req) => this.logViolation(req, 'ADMIN_LIMIT')
    });

    // 4. Strict limiter for sensitive operations (login, verification)
    this.strictLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // Only 5 attempts per IP per 15 minutes
      message: {
        error: 'Too many attempts. Please try again later.',
        code: 'STRICT_RATE_LIMIT',
        retryAfter: 900
      },
      onLimitReached: (req) => this.logViolation(req, 'STRICT_LIMIT')
    });

    // 5. Burst protection - prevents rapid-fire requests
    this.burstProtection = rateLimit({
      windowMs: 10 * 1000, // 10 seconds
      max: 5, // Max 5 requests per 10 seconds
      keyGenerator: (req) => this.getPhoneNumber(req) || req.ip,
      message: {
        error: 'Sending messages too quickly. Please slow down.',
        code: 'BURST_PROTECTION',
        retryAfter: 10
      },
      skip: (req) => {
        if (req.method === 'GET') return true;
        return this.shouldSkipRateLimit(req);
      },
      onLimitReached: (req) => this.logViolation(req, 'BURST_LIMIT')
    });

    // 6. Slow down middleware - gradual delay instead of blocking
    this.slowDown = slowDown({
      windowMs: 1 * 60 * 1000, // 1 minute
      delayAfter: 10, // Allow 10 requests per minute at full speed
      delayMs: 500, // Add 500ms delay per request after delayAfter
      maxDelayMs: 5000, // Maximum delay of 5 seconds
      keyGenerator: (req) => this.getPhoneNumber(req) || req.ip,
      skip: (req) => {
        if (req.method === 'GET') return true;
        return this.shouldSkipRateLimit(req);
      }
    });
  }

  /**
   * Extract phone number from various request sources
   */
  getPhoneNumber(req) {
    // Try different sources for phone number
    const sources = [
      req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from, // WhatsApp webhook
      req.body?.from, // Direct API call
      req.query?.phone, // Query parameter
      req.params?.phone, // URL parameter
      req.headers['x-phone-number'] // Custom header
    ];

    for (const source of sources) {
      if (source && typeof source === 'string' && source.match(/^\+?\d{10,15}$/)) {
        return source.startsWith('+') ? source : `+${source}`;
      }
    }
    
    return null;
  }

  /**
   * Get WhatsApp rate limit based on user verification status
   */
  getWhatsAppLimit(req) {
    const phoneNumber = this.getPhoneNumber(req);
    
    if (!phoneNumber) return 15; // Default for unknown users
    
    // Check if user is verified (you'll need to implement this check)
    const isVerified = this.isUserVerified(phoneNumber);
    
    return isVerified ? 30 : 15; // Verified users get higher limits
  }

  /**
   * Check if user is verified (integrate with your user system)
   */
  isUserVerified(phoneNumber) {
    // TODO: Implement verification check with your database
    // This is a placeholder - replace with actual verification logic
    return false;
  }

  /**
   * Check if request should skip rate limiting
   */
  shouldSkipRateLimit(req) {
    const phoneNumber = this.getPhoneNumber(req);
    
    // Skip for whitelisted phone numbers
    if (phoneNumber && this.whitelist.has(phoneNumber)) {
      return true;
    }
    
    // Skip for health check endpoints
    if (req.path === '/health' || req.path === '/status') {
      return true;
    }
    
    return false;
  }

  /**
   * Log rate limit violations for monitoring
   */
  logViolation(req, type) {
    const violation = {
      timestamp: new Date().toISOString(),
      type,
      ip: req.ip,
      phoneNumber: this.getPhoneNumber(req),
      userAgent: req.get('User-Agent'),
      path: req.path,
      method: req.method
    };
    
    this.stats.violations.push(violation);
    this.stats.blockedRequests++;
    
    // Keep only last 1000 violations
    if (this.stats.violations.length > 1000) {
      this.stats.violations = this.stats.violations.slice(-1000);
    }
    
    console.warn(`[RATE_LIMIT_VIOLATION] ${type}:`, violation);
    
    // TODO: Send to monitoring system or database
  }

  /**
   * Cleanup old entries from memory store
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, value] of this.store.entries()) {
      if (now - value.timestamp > 24 * 60 * 60 * 1000) { // 24 hours old
        this.store.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[RATE_LIMIT_CLEANUP] Cleaned ${cleaned} old entries`);
    }
  }

  /**
   * Create custom rate limiter with specific configuration
   */
  createCustomLimiter(options) {
    return rateLimit({
      windowMs: options.windowMs || 60 * 1000,
      max: options.max || 60,
      keyGenerator: options.keyGenerator || ((req) => req.ip),
      message: options.message || { error: 'Rate limit exceeded' },
      skip: options.skip || (() => false),
      onLimitReached: (req) => this.logViolation(req, options.name || 'CUSTOM_LIMIT'),
      ...options
    });
  }

  /**
   * Middleware factory for different use cases
   */
  get webhook() {
    return [this.burstProtection, this.slowDown, this.webhookLimiter];
  }

  get admin() {
    return [this.globalLimiter, this.adminLimiter];
  }

  get strict() {
    return [this.strictLimiter];
  }

  get global() {
    return [this.globalLimiter];
  }

  get burst() {
    return [this.burstProtection];
  }

  /**
   * Add phone number to whitelist
   */
  addToWhitelist(phoneNumber) {
    const formatted = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    this.whitelist.add(formatted);
    console.log(`[RATE_LIMIT] Added ${formatted} to whitelist`);
  }

  /**
   * Remove phone number from whitelist
   */
  removeFromWhitelist(phoneNumber) {
    const formatted = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    this.whitelist.delete(formatted);
    console.log(`[RATE_LIMIT] Removed ${formatted} from whitelist`);
  }

  /**
   * Get current statistics
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime,
      whitelistSize: this.whitelist.size,
      recentViolations: this.stats.violations.slice(-10)
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      blockedRequests: 0,
      violations: [],
      startTime: Date.now()
    };
  }
}

// Create and export singleton instance
const rateLimitMiddleware = new RateLimitMiddleware();

module.exports = {
  RateLimitMiddleware: rateLimitMiddleware,
  
  // Export individual middleware for direct use
  webhook: rateLimitMiddleware.webhook,
  admin: rateLimitMiddleware.admin,
  strict: rateLimitMiddleware.strict,
  global: rateLimitMiddleware.global,
  burst: rateLimitMiddleware.burst,
  
  // Export utility functions
  addToWhitelist: (phone) => rateLimitMiddleware.addToWhitelist(phone),
  removeFromWhitelist: (phone) => rateLimitMiddleware.removeFromWhitelist(phone),
  getStats: () => rateLimitMiddleware.getStats(),
  resetStats: () => rateLimitMiddleware.resetStats(),
  createCustomLimiter: (options) => rateLimitMiddleware.createCustomLimiter(options)
};
