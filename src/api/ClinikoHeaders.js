// src/api/ClinikoHeaders.js

const base64 = require("base-64");
const dotenv = require("dotenv");
dotenv.config();

/**
 * Helper for building HTTP headers for Cliniko API requests.
 */
class ClinikoHeaders {
  /**
   * Build headers required for authenticating and communicating with Cliniko API.
   * @returns {Object} Headers object.
   * @throws {Error} If CLINIKO_API_KEY is not set in the environment.
   */
  static build() {
    const apiKey = process.env.CLINIKO_API_KEY;
    if (!apiKey) {
      throw new Error("CLINIKO_API_KEY is not set in .env");
    }

    const encoded = base64.encode(`${apiKey}:`);
    return {
      Authorization: `Basic ${encoded}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": `PhysioBot (${process.env.SUPPORT_EMAIL || "ramesh@prohealthasia.com"})`,
    };
  }
}

module.exports = ClinikoHeaders;
