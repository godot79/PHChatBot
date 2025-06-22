/**
 * WhatsApp Webhook Route Handler
 * Handles incoming WhatsApp messages and webhook verification
 */

const express = require('express');
const router = express.Router();
const ChatbotEngine = require('../core/ChatbotEngine');
const WhatsAppAPI = require('../api/WhatsAppAPI');
const Logger = require('../core/Logger');
const { SecurityMiddleware } = require('../middleware/SecurityMiddleware');
const { ValidationMiddleware } = require('../middleware/ValidationMiddleware');

const logger = new Logger('WebhookRoute');
const chatbotEngine = new ChatbotEngine();
const whatsAppAPI = new WhatsAppAPI();

/**
 * Webhook verification endpoint (GET)
 * WhatsApp uses this to verify webhook URL during setup
 */
router.get('/webhook', SecurityMiddleware.verifyWebhookToken, (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Verify the mode and token
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      logger.info('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      logger.warn('Webhook verification failed', { mode, token: token ? '[REDACTED]' : 'missing' });
      res.status(403).send('Forbidden');
    }
  } catch (error) {
    logger.error('Webhook verification error:', error);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * Webhook message handler (POST)
 * Processes incoming WhatsApp messages
 */
router.post('/webhook', 
  SecurityMiddleware.verifyWebhookSignature,
  ValidationMiddleware.validateWebhookPayload,
  async (req, res) => {
    try {
      const { body } = req;
      
      // Quick response to WhatsApp to avoid timeout
      res.status(200).send('OK');

      // Process webhook data
      if (body.object === 'whatsapp_business_account') {
        await processWebhookEntry(body);
      } else {
        logger.warn('Unknown webhook object type:', body.object);
      }

    } catch (error) {
      logger.error('Webhook processing error:', error);
      // Still send 200 to avoid WhatsApp retries for processing errors
      res.status(200).send('OK');
    }
  }
);

/**
 * Process webhook entry data
 * @param {Object} webhookData - Webhook payload from WhatsApp
 */
async function processWebhookEntry(webhookData) {
  try {
    for (const entry of webhookData.entry) {
      for (const change of entry.changes) {
        if (change.field === 'messages') {
          await processMessagesChange(change.value);
        } else if (change.field === 'message_status') {
          await processMessageStatus(change.value);
        }
      }
    }
  } catch (error) {
    logger.error('Error processing webhook entry:', error);
  }
}

/**
 * Process incoming messages
 * @param {Object} messageData - Message data from webhook
 */
async function processMessagesChange(messageData) {
  try {
    const { messages, contacts, metadata } = messageData;

    if (!messages || messages.length === 0) {
      return;
    }

    for (const message of messages) {
      const contact = contacts?.find(c => c.wa_id === message.from);
      
      const messageContext = {
        messageId: message.id,
        from: message.from,
        timestamp: message.timestamp,
        type: message.type,
        contact: contact,
        businessPhoneNumberId: metadata?.phone_number_id
      };

      // Extract message content based on type
      let messageContent = null;
      switch (message.type) {
        case 'text':
          messageContent = message.text?.body;
          break;
        case 'button':
          messageContent = message.button?.payload || message.button?.text;
          break;
        case 'interactive':
          messageContent = message.interactive?.button_reply?.id || 
                          message.interactive?.list_reply?.id ||
                          message.interactive?.button_reply?.title ||
                          message.interactive?.list_reply?.title;
          break;
        case 'location':
          messageContent = {
            latitude: message.location?.latitude,
            longitude: message.location?.longitude,
            name: message.location?.name,
            address: message.location?.address
          };
          break;
        default:
          logger.warn(`Unsupported message type: ${message.type}`);
          continue;
      }

      if (messageContent) {
        logger.info('Processing message', {
          from: message.from,
          type: message.type,
          messageId: message.id
        });

        // Process message through chatbot engine
        await chatbotEngine.processMessage(messageContext, messageContent);
      }
    }
  } catch (error) {
    logger.error('Error processing messages:', error);
  }
}

/**
 * Process message status updates (delivered, read, etc.)
 * @param {Object} statusData - Status data from webhook
 */
async function processMessageStatus(statusData) {
  try {
    const { statuses } = statusData;

    if (!statuses || statuses.length === 0) {
      return;
    }

    for (const status of statuses) {
      logger.debug('Message status update', {
        messageId: status.id,
        status: status.status,
        timestamp: status.timestamp,
        recipientId: status.recipient_id
      });

      // Update message status in database
      await chatbotEngine.updateMessageStatus(status.id, status.status, status.timestamp);
    }
  } catch (error) {
    logger.error('Error processing message status:', error);
  }
}

/**
 * Admin endpoint to send test message
 * POST /webhook/test-message
 */
router.post('/test-message', 
  SecurityMiddleware.requireAuth,
  ValidationMiddleware.validateTestMessage,
  async (req, res) => {
    try {
      const { phoneNumber, message } = req.body;

      const result = await whatsAppAPI.sendMessage(phoneNumber, message);
      
      logger.info('Test message sent', { phoneNumber, messageId: result.messageId });
      
      res.json({
        success: true,
        messageId: result.messageId,
        status: 'sent'
      });
    } catch (error) {
      logger.error('Failed to send test message:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send test message'
      });
    }
  }
);

/**
 * Admin endpoint to get webhook statistics
 * GET /webhook/stats
 */
router.get('/stats',
  SecurityMiddleware.requireAuth,
  async (req, res) => {
    try {
      const stats = await chatbotEngine.getWebhookStats();
      res.json(stats);
    } catch (error) {
      logger.error('Failed to get webhook stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve webhook statistics'
      });
    }
  }
);

/**
 * Error handler middleware
 */
router.use((error, req, res, next) => {
  logger.error('Webhook route error:', error);
  
  // Don't expose internal errors to WhatsApp
  if (req.path === '/webhook' && req.method === 'POST') {
    return res.status(200).send('OK');
  }
  
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

module.exports = router;
