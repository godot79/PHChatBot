// src/api/SendMessage.js

const axios = require("axios");
const ClinikoHeaders = require("./ClinikoHeaders.js");
const BulkContext = require("../core/BulkContext.js");

// Shared concurrency cap for requests made inside BulkContext.run()/bulkAll()
// (fan-outs like BOOK_SOONEST's ~30-40 practitioner sweep). Firing all of
// them at once regularly overwhelmed Cliniko's gateway and cascaded into mass
// 15s timeouts (confirmed live 2026-07-21). Regular single calls never touch
// this queue — only bulk-flagged callers do, so one heavy fan-out can't slow
// down an unrelated single-call request from a different user/flow.
const BULK_CONCURRENCY_LIMIT = 15;
let _activeBulk = 0;
const _bulkQueue = [];

function _acquireBulkSlot() {
  if (_activeBulk < BULK_CONCURRENCY_LIMIT) {
    _activeBulk++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _bulkQueue.push(resolve));
}

function _releaseBulkSlot() {
  const next = _bulkQueue.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else _activeBulk--;
}

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
    const bulk = BulkContext.isBulk();
    if (bulk) await _acquireBulkSlot();
    try {
      console.log('PATCHing to Cliniko:', `${this.baseURL}${this.endpoint}`);
      console.log('With payload:', JSON.stringify(data));
      const response = await axios.patch(`${this.baseURL}${this.endpoint}`, data, {
        headers: ClinikoHeaders.build(),
        timeout: 15000,
      });
      return response.data;
    } catch (error) {
      const status = error.response?.status || 500;
      const message = error.response?.data || error.message;
      console.error(`[SendMessage] PATCH ${this.endpoint} failed:`, message);
      throw { status, error: message };
    } finally {
      if (bulk) _releaseBulkSlot();
    }
  }

  /**
   * Perform a GET request to the Cliniko API.
   * @returns {Promise<Object>} Response data.
   */
  async get() {
    const bulk = BulkContext.isBulk();
    if (bulk) await _acquireBulkSlot();
    try {
      console.info(`Sending GET ${this.baseURL}${this.endpoint} with params: `, this.params);
      const response = await axios.get(`${this.baseURL}${this.endpoint}`, {
        headers: ClinikoHeaders.build(),
        params: this.params,
        timeout: 15000,
      });
      return response.data;
    } catch (error) {
      const status = error.response?.status || 500;
      const message = error.response?.data || error.message;
      console.error(`[SendMessage] GET ${this.endpoint} failed:`, message);
      throw { status, error: message };
    } finally {
      if (bulk) _releaseBulkSlot();
    }
  }

  /**
   * Perform a POST request to the Cliniko API.
   * @param {Object} data - Payload to send to the API.
   * @returns {Promise<Object>} Response data.
   */
  async post(data = {}) {
    const bulk = BulkContext.isBulk();
    if (bulk) await _acquireBulkSlot();
    try {
      console.log('POSTing to Cliniko:', `${this.baseURL}${this.endpoint}`);
      console.log('With payload:', JSON.stringify(data));
      const response = await axios.post(`${this.baseURL}${this.endpoint}`, data, {
        headers: ClinikoHeaders.build(),
        timeout: 15000,
      });
      return response.data;
    } catch (error) {
      const status = error.response?.status || 500;
      const message = error.response?.data || error.message;
      console.error(`[SendMessage] POST ${this.endpoint} failed:`, message);
      throw { status, error: message };
    } finally {
      if (bulk) _releaseBulkSlot();
    }
  }
}

module.exports = SendMessage;
// Exposed for tests only — a plain number, unaffected by jest.mock()
// automocking (which only replaces function properties).
module.exports.BULK_CONCURRENCY_LIMIT = BULK_CONCURRENCY_LIMIT;
