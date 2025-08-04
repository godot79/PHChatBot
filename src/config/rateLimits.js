module.exports = {
  WHATSAPP_LIMIT: {
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
  },
  ADMIN_LIMIT: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100
  },
  GLOBAL_LIMIT: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500
  },
  STRICT_LIMIT: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 1000
  },
  BURST_LIMIT: {
    windowMs: 10 * 1000, // 10 seconds
    max: 10
  }
};
