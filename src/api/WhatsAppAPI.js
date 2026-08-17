const axios = require('axios');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrapper for sending messages using the WhatsApp Cloud API.
 */
class WhatsAppAPI {
  constructor() {
    this.baseURL = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v22.0'}`;
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    // Meta doesn't publish an exact numeric threshold for the per-recipient "pair
    // rate limit" (error 131056) — this is a conservative, unmeasured mitigation,
    // not a calibrated value. It paces consecutive sends to the SAME recipient so
    // e.g. a two-part text+interactive reply doesn't fire both legs back-to-back.
    // The retry+rollback in webhook.js remains the real safety net for whatever
    // this doesn't catch. Configurable via env since there's no documented number
    // to hard-code with confidence.
    this.minSendIntervalMs = Number(process.env.WHATSAPP_MIN_SEND_INTERVAL_MS ?? 2000);
    this._lastSendAt = new Map(); // phone -> timestamp (ms) of last send attempt
  }

  /**
   * Waits, if needed, so consecutive sends to the same recipient are spaced at
   * least minSendIntervalMs apart. No-ops when minSendIntervalMs is 0 or less.
   * @param {string} phone
   */
  async _pace(phone) {
    if (!(this.minSendIntervalMs > 0)) return;
    const now = Date.now();
    const last = this._lastSendAt.get(phone);
    if (last !== undefined) {
      const wait = this.minSendIntervalMs - (now - last);
      if (wait > 0) await sleep(wait);
    }
    this._lastSendAt.set(phone, Date.now());

    // Bound the map's size on a long-lived instance — entries older than the
    // pacing window are irrelevant for spacing purposes, so drop them once
    // the map grows large enough to be worth the sweep.
    if (this._lastSendAt.size > 2000) {
      const cutoff = Date.now() - this.minSendIntervalMs;
      for (const [p, ts] of this._lastSendAt) {
        if (ts < cutoff) this._lastSendAt.delete(p);
      }
    }
  }

  /**
   * Send a text message to a WhatsApp user.
   * @param {string} phone - Recipient's phone number (in international format).
   * @param {string} text - Message body.
   * @returns {Promise<Object>} API response data.
   */
  async sendTextMessage(phone, text) {
    try {
      await this._pace(phone);
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
   * Send an interactive message (button or list) to a WhatsApp user.
   * @param {string} phone - Recipient's phone number.
   * @param {Object} interactive - The interactive object from a MessageEnvelope.
   * @returns {Promise<Object>} API response data.
   */
  async sendInteractive(phone, interactive) {
    try {
      await this._pace(phone);
      const payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive
      };
      const url = `${this.baseURL}/${this.phoneNumberId}/messages`;
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`
        }
      });
      console.info(`[WHATSAPP] Interactive ${interactive.type} sent to ${phone}`);
      return response.data;
    } catch (error) {
      console.error('[WHATSAPP] Send interactive error:', error.response?.data || error.message);
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
