module.exports = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-haiku-4-5',
  // Matches the 15s single-call timeout convention used for Cliniko/WhatsApp
  // API calls in src/api/SendMessage.js.
  timeoutMs: 15000,
};
