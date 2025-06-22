// src/api/WhatsAppAPI.js
const axios = require('axios');
const Logger = require('../utils/Logger');

class WhatsAppAPI {
  constructor(accessToken, phoneNumberId) {
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.baseURL = 'https://graph.facebook.com/v18.0';
    this.logger = new Logger('WhatsAppAPI');

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // Add request/response interceptors for logging
    this.client.interceptors.request.use(
      (config) => {
        this.logger.debug('WhatsApp API Request:', {
          method: config.method,
          url: config.url,
          data: config.data
        });
        return config;
      },
      (error) => {
        this.logger.error('WhatsApp API Request Error:', error);
        return Promise.reject(error);
      }
    );

    this.client.interceptors.response.use(
      (response) => {
        this.logger.debug('WhatsApp API Response:', {
          status: response.status,
          data: response.data
        });
        return response;
      },
      (error) => {
        this.logger.error('WhatsApp API Response Error:', {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
        return Promise.reject(error);
      }
    );
  }

  async sendMessage(to, text, options = {}) {
    try {
      const messageData = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: {
          body: text
        }
      };

      // Add preview URL if provided
      if (options.preview_url !== undefined) {
        messageData.text.preview_url = options.preview_url;
      }

      const response = await this.client.post(
        `/${this.phoneNumberId}/messages`,
        messageData
      );

      this.logger.info(`Message sent to ${to}: ${text.substring(0, 100)}...`);
      return response.data;

    } catch (error) {
      this.logger.error('Failed to send message:', error.response?.data || error.message);
      throw new Error('Failed to send WhatsApp message');
    }
  }

  async sendInteractiveMessage(to, message) {
    try {
      const messageData = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: message
      };

      const response = await this.client.post(
        `/${this.phoneNumberId}/messages`,
        messageData
      );

      this.logger.info(`Interactive message sent to ${to}`);
      return response.data;

    } catch (error) {
      this.logger.error('Failed to send interactive message:', error.response?.data || error.message);
      throw new Error('Failed to send WhatsApp interactive message');
    }
  }

  async sendTemplateMessage(to, templateName, languageCode = 'en_US', components = []) {
    try {
      const messageData = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode
          },
          components: components
        }
      };

      const response = await this.client.post(
        `/${this.phoneNumberId}/messages`,
        messageData
      );

      this.logger.info(`Template message sent to ${to}: ${templateName}`);
      return response.data;

    } catch (error) {
      this.logger.error('Failed to send template message:', error.response?.data || error.message);
      throw new Error('Failed to send WhatsApp template message');
    }
  }

  async sendButtonMessage(to, text, buttons) {
    try {
      const interactiveMessage = {
        type: 'button',
        body: {
          text: text
        },
        action: {
          buttons: buttons.map((button, index) => ({
            type: 'reply',
            reply: {
              id: button.id || `btn_${index}`,
              title: button.title
            }
          }))
        }
      };

      return await this.sendInteractiveMessage(to, interactiveMessage);

    } catch (error) {
      this.logger.error('Failed to send button message:', error);
      throw new Error('Failed to send WhatsApp button message');
    }
  }

  async sendListMessage(to, text, buttonText, sections) {
    try {
      const interactiveMessage = {
        type: 'list',
        body: {
          text: text
        },
        action: {
          button: buttonText,
          sections: sections.map(section => ({
            title: section.title,
            rows: section.rows.map(row => ({
              id: row.id,
              title: row.title,
              description: row.description || ''
            }))
          }))
        }
      };

      return await this.sendInteractiveMessage(to, interactiveMessage);

    } catch (error) {
      this.logger.error('Failed to send list message:', error);
      throw new Error('Failed to send WhatsApp list message');
    }
  }

  async sendLocationMessage(to, latitude, longitude, name, address) {
    try {
      const messageData = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'location',
        location: {
          latitude: latitude,
          longitude: longitude,
          name: name,
          address: address
        }
      };

      const response = await this.client.post(
        `/${this.phoneNumberId}/messages`,
        messageData
      );

      this.logger.info(`Location message sent to ${to}`);
      return response.data;

    } catch (error) {
      this.logger.error('Failed to send location message:', error.response?.data || error.message);
      throw new Error('Failed to send WhatsApp location message');
    }
  }

  async sendDocumentMessage(to, documentUrl, filename, caption = '') {
    try {
      const messageData = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'document',
        document: {
          link: documentUrl,
          filename: filename,
          caption: caption
        }
      };

      const response = await this.client.post(
        `/${this.phoneNumberId}/messages`,
        messageData
      );

      this.logger.info(`Document message sent to ${to}: ${filename}`);
      return response.data;

    } catch (error) {
      this.logger.error('Failed to send document message:', error.response?.data || error.message);
      throw new Error('Failed to send WhatsApp document message');
    }
  }

  async markMessageAsRead(messageId) {
    try {
      const response = await this.client.post(
        `/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId
        }
      );

      this.logger.debug(`Message marked as read: ${messageId}`);
      return response.data;

    } catch (error) {
      this.logger.error('Failed to mark message as read:', error.response?.data || error.message);
      // Don't throw error for read receipts as it's not critical
      return null;
    }
  }

  async getBusinessProfile() {
    try {
      const response = await this.client.get(`/${this.phoneNumberId}`);
      this.logger.info('Business profile retrieved');
      return response.data;

    } catch (error) {
      this.logger.error('Failed to get business profile:', error.response?.data || error.message);
      throw new Error('Failed to get WhatsApp business profile');
    }
  }

  async updateBusinessProfile(profileData) {
    try {
      const response = await this.client.post(`/${this.phoneNumberId}`, profileData);
      this.logger.info('Business profile updated');
      return response.data;

    } catch (error) {
      this.logger.error('Failed to update business profile:', error.response?.data || error.message);
      throw new Error('Failed to update WhatsApp business profile');
    }
  }

  async getMedia(mediaId) {
    try {
      const response = await this.client.get(`/${mediaId}`);
      return response.data;

    } catch (error) {
      this.logger.error('Failed to get media:', error.response?.data || error.message);
      throw new Error('Failed to get WhatsApp media');
    }
  }

  async downloadMedia(mediaUrl) {
    try {
      const response = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        responseType: 'stream'
      });

      return response.data;

    } catch (error) {
      this.logger.error('Failed to download media:', error.response?.data || error.message);
      throw new Error('Failed to download WhatsApp media');
    }
  }

  // Utility methods for creating common message formats
  createQuickReplyButtons(options) {
    return options.map((option, index) => ({
      id: option.id || `option_${index}`,
      title: option.title.substring(0, 20) // WhatsApp button title limit
    }));
  }

  createListSections(items, title = 'Options') {
    const sections = [];
    const itemsPerSection = 10; // WhatsApp list section limit

    for (let i = 0; i < items.length; i += itemsPerSection) {
      const sectionItems = items.slice(i, i + itemsPerSection);
      sections.push({
        title: sections.length === 0 ? title : `${title} (${sections.length + 1})`,
        rows: sectionItems.map(item => ({
          id: item.id,
          title: item.title.substring(0, 24), // WhatsApp list item title limit
          description: item.description ? item.description.substring(0, 72) : '' // WhatsApp list item description limit
        }))
      });
    }

    return sections;
  }

  // Health check method
  async healthCheck() {
    try {
      await this.getBusinessProfile();
      return true;
    } catch (error) {
      this.logger.error('WhatsApp API health check failed:', error);
      return false;
    }
  }

  // Format phone number for WhatsApp
  static formatPhoneNumber(phoneNumber) {
    // Remove all non-digit characters
    const cleaned = phoneNumber.replace(/\D/g, '');
    
    // Add country code if not present (assuming US/Canada)
    if (cleaned.length === 10) {
      return `1${cleaned}`;
    }
    
    return cleaned;
  }

  // Validate WhatsApp message
  static validateMessage(message) {
    if (!message || typeof message !== 'string') {
      return { valid: false, error: 'Message must be a non-empty string' };
    }

    if (message.length > 4096) {
      return { valid: false, error: 'Message exceeds 4096 character limit' };
    }

    return { valid: true };
  }

  // Error handling wrapper
  async withErrorHandling(operation, operationName) {
    try {
      return await operation();
    } catch (error) {
      this.logger.error(`${operationName} failed:`, error);
      
      // Handle specific WhatsApp API errors
      if (error.response?.data?.error) {
        const whatsappError = error.response.data.error;
        
        switch (whatsappError.code) {
          case 131056: // Message undeliverable
            throw new Error('Message could not be delivered to this number');
          case 131051: // Unsupported message type
            throw new Error('This message type is not supported');
          case 131052: // Re-engagement message
            throw new Error('Cannot send message - user needs to message us first');
          case 100: // Invalid parameter
            throw new Error('Invalid message parameters');
          default:
            throw new Error(whatsappError.message || 'WhatsApp API error');
        }
      }
      
      throw error;
    }
  }
}

module.exports = WhatsAppAPI;
