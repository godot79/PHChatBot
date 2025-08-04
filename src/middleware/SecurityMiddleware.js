/**
 * SecurityMiddleware.js
 * Comprehensive security layer for WhatsApp Healthcare Chatbot
 * Handles authentication, webhook verification, input sanitization, and security headers
 */

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const helmet = require('helmet');
const xss = require('xss');
const validator = require('validator');
const  Logger = require('./Logger');

class SecurityMiddleware {
    constructor(config = {}) {
        this.logger = new Logger('SecurityMiddleware');
        this.config = {
            webhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET,
            apiKey: process.env.ADMIN_API_KEY || process.env.CLINIKO_API_KEY,
            encryptionKey: process.env.ENCRYPTION_KEY,
            jwtSecret: process.env.JWT_SECRET,
            maxRequestSize: config.maxRequestSize || '10mb',
            rateLimitWindow: config.rateLimitWindow || 15 * 60 * 1000, // 15 minutes
            rateLimitMax: config.rateLimitMax || 100,
            slowDownThreshold: config.slowDownThreshold || 5,
            trustedProxies: config.trustedProxies || ['127.0.0.1', '::1'],
            ...config
        };

        // Initialize security components
        this.initializeRateLimiting();
        this.initializeSlowDown();
        this.initializeHelmet();
    }

    /**
     * Initialize rate limiting middleware
     */
    initializeRateLimiting() {
        // General API rate limiting
        this.rateLimiter = rateLimit({
            windowMs: this.config.rateLimitWindow,
            max: this.config.rateLimitMax,
            message: {
                error: 'Too many requests',
                code: 'RATE_LIMIT_EXCEEDED',
                retryAfter: Math.ceil(this.config.rateLimitWindow / 1000)
            },
            standardHeaders: true,
            legacyHeaders: false,
            handler: (req, res) => {
                this.logger.warn('Rate limit exceeded', {
                    ip: req.ip,
                    userAgent: req.get('User-Agent'),
                    path: req.path
                });
                res.status(429).json({
                    error: 'Too many requests',
                    code: 'RATE_LIMIT_EXCEEDED'
                });
            }
        });

        // Strict rate limiting for webhook endpoints
        this.webhookRateLimiter = rateLimit({
            windowMs: 60 * 1000, // 1 minute
            max: 50, // More generous for webhook callbacks
            message: {
                error: 'Webhook rate limit exceeded',
                code: 'WEBHOOK_RATE_LIMIT'
            }
        });

        // Admin endpoint rate limiting (more restrictive)
        this.adminRateLimiter = rateLimit({
            windowMs: this.config.rateLimitWindow,
            max: 20, // Very restrictive for admin
            message: {
                error: 'Admin rate limit exceeded',
                code: 'ADMIN_RATE_LIMIT'
            }
        });
    }

    /**
     * Initialize request slow down middleware
     */
    initializeSlowDown() {
        this.slowDown = slowDown({
            windowMs: this.config.rateLimitWindow,
            delayAfter: this.config.slowDownThreshold,
            // delayMs: 500, // Start with 500ms delay
            delayMs: () => 500,
            maxDelayMs: 5000, // Cap at 5 seconds
            skipSuccessfulRequests: true
        });
    }

    /**
     * Initialize Helmet security headers
     */
    initializeHelmet() {
        this.helmet = helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", "data:", "https:"],
                    connectSrc: ["'self'", "https://graph.facebook.com"],
                    fontSrc: ["'self'"],
                    objectSrc: ["'none'"],
                    mediaSrc: ["'none'"],
                    frameSrc: ["'none'"]
                }
            },
            crossOriginEmbedderPolicy: false,
            hsts: {
                maxAge: 31536000,
                includeSubDomains: true,
                preload: true
            }
        });
    }

    /**
     * Verify WhatsApp webhook signature
     */
/*
    verifyWebhookSignature(req, res, next) {
console.log('✅ ENTERED verifyWebhookSignature');
        try {
            //const signature = req.get('X-Hub-Signature-256');
            const signatureHeader = req.get('X-Hub-Signature-256');
            //const signature = signatureHeader?.replace(/^sha256=/, '');
if (!signatureHeader?.startsWith('sha256=')) {
  this.logger.warn('Missing or malformed webhook signature header', { ip: req.ip, header: signatureHeader });
  return res.status(401).json({
    error: 'Malformed signature',
    code: 'MALFORMED_SIGNATURE_HEADER'
  });
}
const signature = signatureHeader.replace(/^sha256=/, '');
            
            if (!signature) {
                this.logger.warn('Missing webhook signature', { ip: req.ip });
                return res.status(401).json({
                    error: 'Missing signature',
                    code: 'MISSING_SIGNATURE'
                });
            }

            if (!this.config.webhookSecret) {
                this.logger.error('Webhook secret not configured');
                return res.status(500).json({
                    error: 'Server configuration error',
                    code: 'CONFIG_ERROR'
                });
            }

            // Calculate expected signature
            const expectedSignature = crypto
                .createHmac('sha256', this.config.webhookSecret)
                .update(req.body)
                .digest('hex');

this.logger.info("🔍 Signature header raw:", signatureHeader);
this.logger.info("🔍 Signature stripped:", signature);

        try{
            const sigBuf = Buffer.from(signature, 'hex');
            const expectedBuf = Buffer.from(expectedSignature, 'hex');
        } catch (err) {
            this.logger.error("💥 Invalid hex format for signature", err);
            return res.status(400).json({
            error: 'Invalid signature format',
            code: 'INVALID_SIGNATURE_FORMAT'
        });
        }
            // Use timing-safe comparison
            if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {

                this.logger.warn('Invalid webhook signature', {
                    ip: req.ip,
                    received: signature,
                    expected: expectedSignature
                });
                return res.status(401).json({
                    error: 'Invalid signature',
                    code: 'INVALID_SIGNATURE'
                });
            }

            this.logger.debug('Webhook signature verified successfully');
            next();

        } catch (error) {
            this.logger.error('Webhook signature verification failed', error);
            res.status(500).json({
                error: 'Signature verification failed',
                code: 'VERIFICATION_ERROR'
            });
        }
    }
*/

verifyWebhookSignature(req, res, next) {
  console.log('✅ ENTERED verifyWebhookSignature');
console.log('🧾 Content-Type:', req.get('Content-Type'));
console.log('📦 typeof req.body:', typeof req.body, 'Buffer?', Buffer.isBuffer(req.body));

  const signatureHeader = req.get('X-Hub-Signature-256');

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    console.error('❌ Missing or malformed signature header:', signatureHeader);
    return res.status(401).json({ error: 'Malformed signature', code: 'MALFORMED_SIGNATURE_HEADER' });
  }

  const signature = signatureHeader.replace(/^sha256=/, '');

  if (!this.config.webhookSecret) {
    console.error('❌ Webhook secret not configured');
    return res.status(500).json({ error: 'Server config error', code: 'CONFIG_ERROR' });
  }

  let expectedSignature;
  try {
    expectedSignature = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(req.body)
      .digest('hex');
  } catch (err) {
    console.error('❌ HMAC generation failed:', err);
    return res.status(500).json({ error: 'HMAC failure', code: 'HMAC_FAILURE' });
  }

  let sigBuf, expectedBuf;
  try {
    sigBuf = Buffer.from(signature, 'hex');
    expectedBuf = Buffer.from(expectedSignature, 'hex');
  } catch (err) {
    console.error('❌ Buffer conversion failed:', err);
    return res.status(400).json({ error: 'Invalid hex encoding', code: 'INVALID_SIGNATURE_ENCODING' });
  }

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    console.warn('❌ Invalid signature match');
    return res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
  }

  console.log('✅ Webhook signature verified successfully');
  next();
}
    /**
     * Verify API key for admin endpoints
     */
    verifyApiKey(req, res, next) {
        try {
            const apiKey = req.get('X-API-Key') || req.query.apiKey;

            if (!apiKey) {
                this.logger.warn('Missing API key', { 
                    ip: req.ip, 
                    path: req.path 
                });
                return res.status(401).json({
                    error: 'API key required',
                    code: 'MISSING_API_KEY'
                });
            }

            if (!this.config.apiKey) {
                this.logger.error('API key not configured');
                return res.status(500).json({
                    error: 'Server configuration error',
                    code: 'CONFIG_ERROR'
                });
            }

            // Use timing-safe comparison
            if (!crypto.timingSafeEqual(
                Buffer.from(apiKey),
                Buffer.from(this.config.apiKey)
            )) {
                this.logger.warn('Invalid API key', {
                    ip: req.ip,
                    path: req.path,
                    providedKey: apiKey.substring(0, 8) + '...'
                });
                return res.status(401).json({
                    error: 'Invalid API key',
                    code: 'INVALID_API_KEY'
                });
            }

            this.logger.debug('API key verified successfully');
            next();

        } catch (error) {
            this.logger.error('API key verification failed', error);
            res.status(500).json({
                error: 'Authentication failed',
                code: 'AUTH_ERROR'
            });
        }
    }

    /**
     * Sanitize input data to prevent XSS and injection attacks
     */
    sanitizeInput(req, res, next) {
        try {
            // Sanitize query parameters
            if (req.query) {
                for (const [key, value] of Object.entries(req.query)) {
                    if (typeof value === 'string') {
                        req.query[key] = this.sanitizeString(value);
                    }
                }
            }

            // Sanitize request body (except for webhook payloads)
            if (req.body && !req.path.includes('/webhook')) {
                req.body = this.sanitizeObject(req.body);
            }

            // Sanitize headers (specific ones that might contain user input)
            const headersToSanitize = ['user-agent', 'referer', 'origin'];
            headersToSanitize.forEach(header => {
                if (req.get(header)) {
                    req.headers[header] = this.sanitizeString(req.get(header));
                }
            });

            next();

        } catch (error) {
            this.logger.error('Input sanitization failed', error);
            res.status(400).json({
                error: 'Invalid input data',
                code: 'SANITIZATION_ERROR'
            });
        }
    }

    /**
     * Sanitize a string value
     */
    sanitizeString(value) {
        if (typeof value !== 'string') return value;
        
        // Remove XSS vectors
        let sanitized = xss(value, {
            whiteList: {}, // No HTML tags allowed
            stripIgnoreTag: true,
            stripIgnoreTagBody: ['script']
        });

        // Additional sanitization
        sanitized = sanitized
            .replace(/[<>]/g, '') // Remove any remaining brackets
            .replace(/javascript:/gi, '') // Remove javascript: protocol
            .replace(/on\w+=/gi, '') // Remove event handlers
            .trim();

        // Limit length
        if (sanitized.length > 1000) {
            sanitized = sanitized.substring(0, 1000);
        }

        return sanitized;
    }

    /**
     * Recursively sanitize an object
     */
    sanitizeObject(obj) {
        if (typeof obj !== 'object' || obj === null) return obj;
        
        if (Array.isArray(obj)) {
            return obj.map(item => this.sanitizeObject(item));
        }

        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
            const sanitizedKey = this.sanitizeString(key);
            sanitized[sanitizedKey] = typeof value === 'string' 
                ? this.sanitizeString(value)
                : this.sanitizeObject(value);
        }

        return sanitized;
    }

    /**
     * Validate request size and content type
     */
    validateRequest(req, res, next) {
        try {
            // Check content type for POST/PUT requests
            if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
                const contentType = req.get('Content-Type');
                const allowedTypes = [
                    'application/json',
                    'application/x-www-form-urlencoded',
                    'text/plain'
                ];

                if (!contentType || !allowedTypes.some(type => 
                    contentType.toLowerCase().includes(type)
                )) {
                    this.logger.warn('Invalid content type', {
                        contentType,
                        method: req.method,
                        path: req.path
                    });
                    return res.status(415).json({
                        error: 'Unsupported content type',
                        code: 'INVALID_CONTENT_TYPE'
                    });
                }
            }

            // Validate request size (handled by express.json() limits, but double-check)
            const contentLength = req.get('Content-Length');
            if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) { // 10MB
                this.logger.warn('Request too large', {
                    contentLength,
                    path: req.path
                });
                return res.status(413).json({
                    error: 'Request too large',
                    code: 'REQUEST_TOO_LARGE'
                });
            }

            next();

        } catch (error) {
            this.logger.error('Request validation failed', error);
            res.status(400).json({
                error: 'Invalid request',
                code: 'REQUEST_VALIDATION_ERROR'
            });
        }
    }

    /**
     * Security headers middleware
     */
    securityHeaders(req, res, next) {
        // Remove server identification
        res.removeHeader('X-Powered-By');
        
        // Add custom security headers
        res.set({
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        });

        next();
    }

    /**
     * Log security events
     */
    logSecurityEvent(event, details = {}) {
        this.logger.warn(`Security Event: ${event}`, {
            event,
            timestamp: new Date().toISOString(),
            ...details
        });
    }

    /**
     * Get rate limiter for specific endpoint type
     */
    getRateLimiter(type = 'default') {
        switch (type) {
            case 'webhook':
                return this.webhookRateLimiter;
            case 'admin':
                return this.adminRateLimiter;
            default:
                return this.rateLimiter;
        }
    }

    /**
     * Get all security middleware in order
     */
    getMiddleware() {
        return [
            this.helmet,
            this.securityHeaders.bind(this),
            this.validateRequest.bind(this),
            this.sanitizeInput.bind(this),
            this.slowDown
        ];
    }

    /**
     * Get webhook-specific middleware
     */
    getWebhookMiddleware() {
        return [
            this.getRateLimiter('webhook'),
            this.verifyWebhookSignature.bind(this)
        ];
    }

    /**
     * Get admin-specific middleware
     */
    getAdminMiddleware() {
        return [
            this.getRateLimiter('admin'),
            this.verifyApiKey.bind(this)
        ];
    }
    requireAuth(req, res, next) {
        if (!this.apiKey || req.headers['x-api-key'] !== this.apiKey) {
            this.logger.warn('Unauthorized access attempt.');
            return res.status(401).json({ error: 'Authentication failure' });
        }
        next();
    }
}

module.exports = SecurityMiddleware ;
