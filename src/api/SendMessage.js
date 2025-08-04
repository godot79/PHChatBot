// src/api/SendMessage.js

const axios = require("axios");
const ClinikoHeaders = require("./ClinikoHeaders.js");

/**
 * Utility class for sending HTTP requests to the Cliniko API with appropriate headers.
 */
class SendMessage {
  /**
   * @param {string} endpoint - API endpoint (e.g. '/patients').
   * @param {Object} params - Optional query parameters.
   */
  constructor(endpoint, params = {}) {
    this.endpoint = endpoint;
    this.params = params;
    this.baseURL = process.env.CLINIKO_API_BASE || "https://api.cliniko.com/v1";
  }

  /**
   * Perform a PATCH request to the Cliniko API.
   * @param {Object} data - Payload to send to the API.
   * @returns {Promise<Object>} Response data.
   */
  async patch(data = {}) {
    try {
      console.log('PATCHing to Cliniko:', `${this.baseURL}${this.endpoint}`);
      console.log('With headers:', ClinikoHeaders.build());
      console.log('With payload:', JSON.stringify(data));
      const response = await axios.patch(`${this.baseURL}${this.endpoint}`, data, {
        headers: ClinikoHeaders.build(),
      });
      return response.data;
    } catch (error) {
      const status = error.response?.status || 500;
      const message = error.response?.data || error.message;
      console.error(`[SendMessage] PATCH ${this.endpoint} failed:`, message);
      throw { status, error: message };
    }
  }

  /**
   * Perform a GET request to the Cliniko API.
   * @returns {Promise<Object>} Response data.
   */
  async get() {
    try {
      console.info(`Sending GET ${this.baseURL}${this.endpoint} with params: `, this.params);
      const response = await axios.get(`${this.baseURL}${this.endpoint}`, {
        headers: ClinikoHeaders.build(),
        params: this.params,
      });
      return response.data;
    } catch (error) {
      const status = error.response?.status || 500;
      const message = error.response?.data || error.message;
      console.error(`[SendMessage] GET ${this.endpoint} failed:`, message);
      throw { status, error: message };
    }
  }

  /**
   * Perform a POST request to the Cliniko API.
   * @param {Object} data - Payload to send to the API.
   * @returns {Promise<Object>} Response data.
   */
  async post(data = {}) {
    try {
      console.log('POSTing to Cliniko:', `${this.baseURL}${this.endpoint}`);
      console.log('With headers:', ClinikoHeaders.build());
      console.log('With payload:', JSON.stringify(data));
      const response = await axios.post(`${this.baseURL}${this.endpoint}`, data, {
        headers: ClinikoHeaders.build(),
      });
      return response.data;
    } catch (error) {
      const status = error.response?.status || 500;
      const message = error.response?.data || error.message;
      console.error(`[SendMessage] POST ${this.endpoint} failed:`, message);
      throw { status, error: message };
    }
  }
}

module.exports = SendMessage;
