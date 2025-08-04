const express = require('express');
const router = express.Router();

const ChatbotEngine = require('../core/ChatbotEngine.js');
const WhatsAppAPI = require('../api/WhatsAppAPI.js');
const Logger = require('../core/Logger.js');
const SecurityMiddleware = require('../middleware/SecurityMiddleware.js');
const ValidationMiddleware = require('../middleware/ValidationMiddleware.js');
const RateLimitMiddleware = require('../middleware/RateLimitMiddleware.js');

const securityMiddleware = new SecurityMiddleware();
const validationMiddleware = new ValidationMiddleware();
const rateLimiter = new RateLimitMiddleware();

const logger = new Logger('WebhookRoute');
const chatbotEngine = new ChatbotEngine();
const whatsAppAPI = new WhatsAppAPI();

/**
 * WhatsApp Webhook Verification (GET)
 */
router.get('/webhook', (req, res) => {
  try {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      logger.info('✅ Webhook verified');
      return res.status(200).send(challenge);
    }
    logger.warn('❌ Webhook verification failed');
    res.sendStatus(403);
  } catch (err) {
    logger.error('Webhook GET error:', err);
    res.sendStatus(500);
  }
});

/**
 * WhatsApp Webhook Handler (POST)
 */
router.post(
  '/webhook',
  rateLimiter.getWhatsappLimiter(),
  securityMiddleware.verifyWebhookSignature.bind(securityMiddleware),
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      try {
        req.body = JSON.parse(req.body.toString('utf8'));
      } catch (err) {
        return res.status(400).json({ error: 'Invalid JSON body after raw parse' });
      }
    }
    next();
  },
  validationMiddleware.validateWebhookPayload.bind(validationMiddleware),
  async (req, res) => {
    res.sendStatus(200); // acknowledge quickly

    try {
      const { object, entry } = req.body;
      if (object !== 'whatsapp_business_account') return;
      for (const ent of entry) {
        for (const change of ent.changes) {
          if (change.field === 'messages') {
            await handleIncomingMessage(change.value);
          } else if (change.field === 'message_status') {
            await handleStatusUpdate(change.value);
          }
        }
      }
    } catch (err) {
      logger.error('Webhook POST handler error:', err);
    }
  }
);

/**
 * Process WhatsApp Message
 */
async function handleIncomingMessage(data) {
  const { messages = [], contacts = [] } = data;
  if (!messages.length) return;

  logger.info('📩 Incoming WhatsApp message payload', data);

  for (const message of messages) {
    const phone = message.from;
    const type = message.type;
    let content = '';

    if (type === 'text') {
      content = message.text?.body;
    } else if (type === 'button') {
      content = message.button?.text || message.button?.payload;
    } else if (type === 'interactive') {
      content = message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id;
    }
    if (!content) {
      logger.warn(`Unsupported message type: ${type}`);
      continue;
    }

    logger.info(`📩 [${phone}] ${type} - ${content}`);
    const reply = await chatbotEngine.handleMessage(content, phone);
    const result = await whatsAppAPI.sendTextMessage(phone, reply);
    logger.info(`📤 Simulated reply sent to ${phone}`, result);
  }
}

/**
 * Process Status Updates
 */
async function handleStatusUpdate(data) {
  const { statuses = [] } = data;
  for (const status of statuses) {
    logger.debug('Message Status:', {
      id: status.id,
      status: status.status,
      timestamp: status.timestamp
    });
    await chatbotEngine.updateMessageStatus?.(status.id, status.status);
  }
}

/**
 * Send Test Message (POST)
 */
router.post('/test-message', async (req, res) => {
  const { phoneNumber, message } = req.body;
  if (!phoneNumber || !message) {
    return res.status(400).json({ success: false, error: 'Missing phoneNumber or message' });
  }
  try {
    logger.info('📥 /test-message received:', { phoneNumber, message });
    const reply = await chatbotEngine.handleMessage(message, phoneNumber);
    const result = await whatsAppAPI.sendTextMessage(phoneNumber, reply);
    logger.info(`📤 Simulated reply sent to ${phoneNumber}`, result);
    res.json({ success: true, result: reply });
  } catch (err) {
    logger.error('❌ Failed in test-message route:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Webhook Stats (GET)
 */
router.get('/webhook/stats', async (req, res) => {
  try {
    const stats = await chatbotEngine.getWebhookStats?.();
    res.json({ success: true, stats });
  } catch (err) {
    logger.error('Failed to get webhook stats:', err);
    res.status(500).json({ success: false });
  }
});

/**
 * Temporary mock fees endpoint for load relief
 */
router.get('/fees', (req, res) => {
  res.json({
    "Prohealth Physiofocus Pte Ltd": [
      { service: "Initial Consultation", amount: 180 },
      { service: "Follow-up Consultation", amount: 150 }
    ],
    "Prohealth In Touch Physiotherapy": [
      { service: "Initial Consultation", amount: 190 },
      { service: "Follow-up Consultation", amount: 160 }
    ],
    "UWC East": [
      { service: "Student Physiotherapy", amount: 140 },
      { service: "Staff Physiotherapy", amount: 160 }
    ],
    "UWC Dover": [
      { service: "Student Physiotherapy", amount: 140 },
      { service: "Staff Physiotherapy", amount: 160 }
    ]
  });
});

module.exports = router;
