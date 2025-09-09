// File: src/api/ClinikoHeaders.js

const base64 = require('base-64');
const dotenv = require('dotenv');
dotenv.config();
const RegionContext = require('../core/RegionContext');

/**
 * ClinikoHeaders
 * Why: choose API key by region from async context.
 */
class ClinikoHeaders {
  /** Resolve API key for the current region or fallback. */
  static _resolveKey() {
    const region = String(RegionContext.get() || '').toUpperCase();
    const map = {
      SG: process.env.CLINIKO_API_KEY_SG,
      HK: process.env.CLINIKO_API_KEY_HK,
      IN: process.env.CLINIKO_API_KEY_IN,
      PH: process.env.CLINIKO_API_KEY_PH,
    };
    return map[region] || process.env.CLINIKO_API_KEY;
  }

  /** Build headers for Cliniko. */
  static build() {
    const apiKey = this._resolveKey();
    if (!apiKey) throw new Error('CLINIKO_API_KEY is not set for requested region');
    const encoded = base64.encode(`${apiKey}:`);
    return {
      Authorization: `Basic ${encoded}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': `PhysioBot (${process.env.SUPPORT_EMAIL || 'support@prohealth.com.sg'})`,
    };
  }
}

module.exports = ClinikoHeaders;
