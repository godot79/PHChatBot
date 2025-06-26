const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

/**
 * WhatsApp Business API Integration
 * Handles: Messages, Media, Templates, Buttons, Lists, Contacts
 */
class WhatsAppAPI {
  constructor() {
    this.baseURL = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}`;
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    this.webhookVerifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    
    // Request configuration
    this.axiosConfig = {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    };
    
    // Message templates cache
    this.templates = new Map();
    this.templateCache = {
      lastUpdated: null,
      templates: []
    };
  }

  /**
   * Send a simple text message
   */
  async sendTextMessage(to, text, options = {}) {
    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: {
          preview_url: options.preview_url || false,
          body: text
        }
      };

      if (options.context && options.context.message_id) {
        payload.context = {
          message_id: options.context.message_id
        };
      }

      const response = await axios.post(`${this.baseURL}/messages`, payload, this.axiosConfig);
      
      console.log(`[WHATSAPP] Text message sent to ${to}:`, text.substring(0, 100));
      return {
        success: true,
        messageId: response.data.messages[0].id,
        status: response.data.messages[0].message_status
      };
      
    } catch (error) {
      console.error('[WHATSAPP] Send text message error:', error.response?.data || error.message);
      throw new Error(`Failed to send text message: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Send interactive button message
   */
  async sendButtonMessage(to, text, buttons, options = {}) {
    try {
      // Validate buttons
      if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > 3) {
        throw new Error('Buttons must be an array with 1-3 items');
      }

      const formattedButtons = buttons.map((button, index) => ({
        type: "reply",
        reply: {
          id: button.id || `btn_${index}`,
          title: button.title.substring(0, 20) // Max 20 chars
        }
      }));

      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: text
          },
          action: {
            buttons: formattedButtons
          }
        }
      };

      if (options.header) {
        payload.interactive.header = {
          type: "text",
          text: options.header
        };
      }

      if (options.footer) {
        payload.interactive.footer = {
          text: options.footer
        };
      }

      const response = await axios.post(`${this.baseURL}/messages`, payload, this.axiosConfig);
      
      console.log(`[WHATSAPP] Button message sent to ${to}:`, buttons.map(b => b.title).join(', '));
      return {
        success: true,
        messageId: response.data.messages[0].id,
        status: response.data.messages[0].message_status
      };
      
    } catch (error) {
      console.error('[WHATSAPP] Send button message error:', error.response?.data || error.message);
      throw new Error(`Failed to send button message: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Send interactive list message
   */
  async sendListMessage(to, text, buttonText, sections, options = {}) {
    try {
      // Validate sections
      if (!Array.isArray(sections) || sections.length === 0 || sections.length > 10) {
        throw new Error('Sections must be an array with 1-10 items');
      }

      const formattedSections = sections.map(section => ({
        title: section.title,
        rows: section.rows.map(row => ({
          id: row.id,
          title: row.title.substring(0, 24), // Max 24 chars
          description: row.description ? row.description.substring(0, 72) : undefined // Max 72 chars
        }))
      }));

      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "interactive",
        interactive: {
          type: "list",
          body: {
            text: text
          },
          action: {
            button: buttonText.substring(0, 20), // Max 20 chars
            sections: formattedSections
          }
        }
      };

      if (options.header) {
        payload.interactive.header = {
          type: "text",
          text: options.header
        };
      }

      if (options.footer) {
        payload.interactive.footer = {
          text: options.footer
        };
      }

      const response = await axios.post(`${this.baseURL}/messages`, payload, this.axiosConfig);
      
      console.log(`[WHATSAPP] List message sent to ${to}:`, sections.length + ' sections');
      return {
        success: true,
        messageId: response.data.messages[0].id,
        status: response.data.messages[0].message_status
      };
      
    } catch (error) {
      console.error('[WHATSAPP] Send list message error:', error.response?.data || error.message);
      throw new Error(`Failed to send list message: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Send template message
   */
  async sendTemplateMessage(to, templateName, languageCode = 'en_US', parameters = []) {
    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "template",
        template: {
          name: templateName,
          language: {
            code: languageCode
          }
        }
      };

      // Add parameters if provided
      if (parameters.length > 0) {
        payload.template.components = [{
          type: "body",
          parameters: parameters.map(param => ({
            type: "text",
            text: param
          }))
        }];
      }

      const response = await axios.post(`${this.baseURL}/messages`, payload, this.axiosConfig);
      
      console.log(`[WHATSAPP] Template message sent to ${to}:`, templateName);
      return {
        success: true,
        messageId: response.data.messages[0].id,
        status: response.data.messages[0].message_status
      };
      
    } catch (error) {
      console.error('[WHATSAPP] Send template message error:', error.response?.data || error.message);
      throw new Error(`Failed to send template message: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Send media message (image, document, audio, video)
   */
  async sendMediaMessage(to, mediaType, mediaUrl, options = {}) {
    try {
      const validTypes = ['image', 'document', 'audio', 'video'];
      if (!validTypes.includes(mediaType)) {
        throw new Error(`Invalid media type. Must be one of: ${validTypes.join(', ')}`);
      }

      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: mediaType,
        [mediaType]: {
          link: mediaUrl
        }
      };

      // Add caption for image/video
      if ((mediaType === 'image' || mediaType === 'video') && options.caption) {
        payload[mediaType].caption = options.caption;
      }

      // Add filename for document
      if (mediaType === 'document' && options.filename) {
        payload[mediaType].filename = options.filename;
      }

      const response = await axios.post(`${this.baseURL}/messages`, payload, this.axiosConfig);
      
      console.log(`[WHATSAPP] ${mediaType} message sent to ${to}:`, mediaUrl);
      return {
        success: true,
        messageId: response.data.messages[0].id,
        status: response.data.messages[0].message_status
      };
      
    } catch (error) {
      console.error(`[WHATSAPP] Send ${mediaType} message error:`, error.response?.data || error.message);
      throw new Error(`Failed to send ${mediaType} message: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Send location message
   */
  async sendLocationMessage(to, latitude, longitude, name = '', address = '') {
    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "location",
        location: {
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          name: name,
          address: address
        }
      };

      const response = await axios.post(`${this.baseURL}/messages`, payload, this.axiosConfig);
      
      console.log(`[WHATSAPP] Location message sent to ${to}:`, `${latitude}, ${longitude}`);
      return {
        success: true,
        messageId: response.data.messages[0].id,
        status: response.data.messages[0].message_status
      };
      
    } catch (error) {
      console.error('[WHATSAPP] Send location message error:', error.response?.data || error.message);
      throw new Error(`Failed to send location message: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Send contact message
   */
  async sendContactMessage(to, contacts) {
    try {
      if (!Array.isArray(contacts)) {
        contacts = [contacts];
      }

      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "contacts",
        contacts: contacts.map(contact => ({
          name: {
            formatted_name: contact.name,
            first_name: contact.firstName || contact.name
          },
          phones: contact.phones ? contact.phones.map(phone => ({
            phone: phone.number,
            type: phone.type || 'WORK'
          })) : [],
          emails: contact.emails ? contact.emails.map(email => ({
            email: email.address,
            type: email.type || 'WORK'
          })) : []
        }))
      };

      const response = await axios.post(`${this.baseURL}/messages`, payload, this.axiosConfig);
      
      console.log(`[WHATSAPP] Contact message sent to ${to}:`, contacts.length + ' contacts');
      return {
        success: true,
        messageId: response.data.messages[0].id,
        status: response.data.messages[0].message_status
      };
      
    } catch (error) {
      console.error('[WHATSAPP] Send contact message error:', error.response?.data || error.message);
      throw new Error(`Failed to send contact message: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId) {
    try {
      const payload = {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId
      };

      await axios.post(`${this.baseURL}/messages`, payload, this.axiosConfig);
      console.log(`[WHATSAPP] Message marked as read:`, messageId);
      return { success: true };
      
    } catch (error) {
      console.error('[WHATSAPP] Mark as read error:', error.response?.data || error.message);
      throw new Error(`Failed to mark message as read: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Get media URL from media ID
   */
  async getMediaUrl(mediaId) {
    try {
      const response = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      return {
        success: true,
        url: response.data.url,
        mimeType: response.data.mime_type,
        sha256: response.data.sha256,
        fileSize: response.data.file_size
      };
      
    } catch (error) {
      console.error('[WHATSAPP] Get media URL error:', error.response?.data || error.message);
      throw new Error(`Failed to get media URL: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Download media file
   */
  async downloadMedia(mediaUrl, filepath) {
    try {
      const response = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(filepath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log(`[WHATSAPP] Media downloaded:`, filepath);
          resolve({ success: true, filepath });
        });
        writer.on('error', reject);
      });
      
    } catch (error) {
      console.error('[WHATSAPP] Download media error:', error.response?.data || error.message);
      throw new Error(`Failed to download media: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Get available message templates
   */
  async getMessageTemplates(limit = 100) {
    try {
      // Check cache first (refresh every 24 hours)
      const now = Date.now();
      if (this.templateCache.lastUpdated && (now - this.templateCache.lastUpdated) < 24 * 60 * 60 * 1000) {
        return { success: true, templates: this.templateCache.templates };
      }

      const response = await axios.get(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        params: {
          limit: limit,
          fields: 'name,status,category,language,components'
        }
      });

      // Update cache
      this.templateCache.templates = response.data.data;
      this.templateCache.lastUpdated = now;

      console.log(`[WHATSAPP] Retrieved ${response.data.data.length} message templates`);
      return {
        success: true,
        templates: response.data.data
      };
      
    } catch (error) {
      console.error('[WHATSAPP] Get templates error:', error.response?.data || error.message);
      throw new Error(`Failed to get message templates: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
      .update(payload)
      .digest('hex');

    return signature === `sha256=${expectedSignature}`;
  }

  /**
   * Process incoming webhook
   */
  async processWebhook(body) {
    try {
      const entry = body.entry?.[0];
      if (!entry) return null;

      const changes = entry.changes?.[0];
      if (!changes) return null;

      const value = changes.value;
      const field = changes.field;

      if (field !== 'messages') return null;

      // Process messages
      if (value.messages) {
        for (const message of value.messages) {
          await this.processIncomingMessage(message, value);
        }
      }

      // Process message status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await this.processMessageStatus(status);
        }
      }

      return { success: true, processed: true };
      
    } catch (error) {
      console.error('[WHATSAPP] Process webhook error:', error);
      throw error;
    }
  }

  /**
   * Process individual incoming message
   */
  async processIncomingMessage(message, metadata) {
    const messageData = {
      id: message.id,
      from: message.from,
      timestamp: parseInt(message.timestamp) * 1000, // Convert to JS timestamp
      type: message.type,
      context: message.context || null
    };

    // Extract message content based on type
    switch (message.type) {
      case 'text':
        messageData.text = message.text.body;
        break;
        
      case 'image':
      case 'document':
      case 'audio':
      case 'video':
        messageData.media = {
          id: message[message.type].id,
          mimeType: message[message.type].mime_type,
          sha256: message[message.type].sha256,
          caption: message[message.type].caption || null
        };
        if (message.type === 'document') {
          messageData.media.filename = message[message.type].filename;
        }
        break;
        
      case 'location':
        messageData.location = {
          latitude: message.location.latitude,
          longitude: message.location.longitude,
          name: message.location.name || null,
          address: message.location.address || null
        };
        break;
        
      case 'contacts':
        messageData.contacts = message.contacts;
        break;
        
      case 'interactive':
        if (message.interactive.type === 'button_reply') {
          messageData.buttonReply = {
            id: message.interactive.button_reply.id,
            title: message.interactive.button_reply.title
          };
        } else if (message.interactive.type === 'list_reply') {
          messageData.listReply = {
            id: message.interactive.list_reply.id,
            title: message.interactive.list_reply.title,
            description: message.interactive.list_reply.description || null
          };
        }
        break;
    }

    console.log(`[WHATSAPP] Received ${message.type} message from ${message.from}`);
    return messageData;
  }

  /**
   * Process message status updates
   */
  async processMessageStatus(status) {
    console.log(`[WHATSAPP] Message ${status.id} status: ${status.status}`);
    
    // You can emit events or update database here
    return {
      messageId: status.id,
      status: status.status,
      timestamp: parseInt(status.timestamp) * 1000,
      recipientId: status.recipient_id
    };
  }

  /**
   * Get business profile
   */
  async getBusinessProfile() {
    try {
      const response = await axios.get(`${this.baseURL}`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        params: {
          fields: 'id,name,category,description,email,websites,profile_picture_url'
        }
      });

      return {
        success: true,
        profile: response.data
      };
      
    } catch (error) {
      console.error('[WHATSAPP] Get business profile error:', error.response?.data || error.message);
      throw new Error(`Failed to get business profile: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Health check - verify API connectivity
   */
  async healthCheck() {
    try {
      await this.getBusinessProfile();
      return { success: true, status: 'healthy' };
    } catch (error) {
      return { success: false, status: 'unhealthy', error: error.message };
    }
  }
}

module.exports = WhatsAppAPI;
