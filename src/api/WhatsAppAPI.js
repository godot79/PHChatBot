const axios = require('axios');

/**
 * Wrapper for sending messages using the WhatsApp Cloud API.
 */
class WhatsAppAPI {
  constructor() {
    this.baseURL = 'https://graph.facebook.com/v19.0';
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  /**
   * Send a text message to a WhatsApp user.
   * @param {string} phone - Recipient's phone number (in international format).
   * @param {string} text - Message body.
   * @returns {Promise<Object>} API response data.
   */
  async sendTextMessage(phone, text) {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: text }
      };

      const url = `${this.baseURL}/${this.phoneNumberId}/messages`;
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`
        }
      });

      console.info(`[WHATSAPP] Text message sent to ${phone}: ${text}`);
      return response.data;
    } catch (error) {
      console.error('[WHATSAPP] Send text message error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Retrieve the WhatsApp business profile.
   * @returns {Promise<Object>} Business profile data.
   */
  async getBusinessProfile() {
    try {
      const url = `${this.baseURL}/${this.phoneNumberId}/whatsapp_business_profile`;
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`
        }
      });
      return response.data;
    } catch (error) {
      console.error('[WHATSAPP] Get business profile error:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = WhatsAppAPI;
