const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const limits = require('../config/rateLimits');

class RateLimitMiddleware {
  constructor() {
    this.limiters = {};
    this.initializeLimiters();
  }

  initializeLimiters() {
    Object.entries(limits).forEach(([name, config]) => {
      if (!config.windowMs || !config.max) {
        console.warn(`⚠️ Incomplete config for ${name}, skipping limiter.`);
        return;
      }

      this.limiters[name] = rateLimit({
        ...config,
        handler: (req, res) => {
          res.status(429).json({ message: `Too many requests on ${name}` });
        }
      });
    });

    // Example: Add slow-down to burst limiter
    if (this.limiters.BURST_LIMIT) {
        const { windowMs, delayAfter = 5 } = limits.BURST_LIMIT;

        this.limiters.BURST_LIMIT = slowDown({
            windowMs,
            delayAfter,
            delayMs: () => 500
        });
    }

    console.info('✅ Rate limiters initialized.');
  }

  getLimiter(name) {
    const limiter = this.limiters?.[name];
    if (!limiter) {
      console.warn(`⚠️ Limiter ${name} is not initialized.`);
      return (req, res, next) => next();
    }
    console.log(`✅ Using limiter: ${name}`);
    return limiter;
  }

  getWhatsappLimiter() {
    return this.getLimiter('WHATSAPP_LIMIT');
  }

  getAdminLimiter() {
    return this.getLimiter('ADMIN_LIMIT');
  }

  getGlobalLimiter() {
    return this.getLimiter('GLOBAL_LIMIT');
  }

  getStrictLimiter() {
    return this.getLimiter('STRICT_LIMIT');
  }

  getBurstLimiter() {
    return this.getLimiter('BURST_LIMIT');
  }
}

module.exports = RateLimitMiddleware;
