const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/anthropic.js');

// Sentinel returned on any failure (timeout, API error, malformed/low-confidence
// output). Callers must treat this identically to "no classification" and fall
// through to the existing menu fallback — this router never throws.
const NO_CLASSIFICATION = { intent: null, slots: {}, confidence: 0 };

// Phase 1 vocabulary: scoped exactly to the states already reachable by
// keyword at the two dead-end fallback sites this phase wires in
// (handleBookManageOptions, handleBookingMethodOptions in ChatbotEngine.js).
// Extend only alongside a phase that actually wires the new intent somewhere.
const KNOWN_INTENTS = [
  'book_appointment',
  'cancel_appointment',
  'reschedule_appointment',
  'book_history',
  'book_soonest',
  'book_specific_date',
  'book_specific_physio',
  'book_specific_clinic',
];

const CLASSIFY_TOOL = {
  name: 'classify_intent',
  description: 'Classify a WhatsApp user message into a known booking-bot intent with extracted slots.',
  input_schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: KNOWN_INTENTS },
      slots: { type: 'object' },
      confidence: { type: 'number' },
    },
    required: ['intent', 'confidence'],
  },
};

// Callers use this instead of comparing against config.intentConfidenceThreshold
// directly, so the threshold stays a single source of truth while it's still
// being tuned (see config/anthropic.js).
function isConfident(result) {
  return !!result && typeof result.confidence === 'number'
    && result.confidence >= config.intentConfidenceThreshold
    && KNOWN_INTENTS.includes(result.intent);
}

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs });
  }
  return _client;
}

// currentState/sessionContext are accepted for future phases (e.g. narrowing
// the intent set by state, slot pre-fill context); not yet used in the call itself.
async function classifyIntent(text, currentState, sessionContext) {
  try {
    const client = getClient();
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 256,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'classify_intent' },
      messages: [{ role: 'user', content: text }],
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse) return NO_CLASSIFICATION;

    const { intent, slots, confidence } = toolUse.input || {};
    if (typeof intent !== 'string' || typeof confidence !== 'number') {
      return NO_CLASSIFICATION;
    }

    return { intent, slots: slots || {}, confidence };
  } catch (err) {
    return NO_CLASSIFICATION;
  }
}

module.exports = { classifyIntent, NO_CLASSIFICATION, KNOWN_INTENTS, isConfident };
