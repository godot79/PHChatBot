module.exports = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-haiku-4-5',
  // Matches the 15s single-call timeout convention used for Cliniko/WhatsApp
  // API calls in src/api/SendMessage.js.
  timeoutMs: 15000,
  // Minimum confidence to act on an NLU classification instead of falling
  // through to the existing menu fallback. No real-traffic data yet to tune
  // this against, so it's env-overridable rather than hardcoded.
  intentConfidenceThreshold: process.env.NLU_CONFIDENCE_THRESHOLD !== undefined
    ? parseFloat(process.env.NLU_CONFIDENCE_THRESHOLD)
    : 0.7,
  // Phase 2 slot-confidence thresholds. No real-traffic data yet to calibrate
  // either of these — placeholders only, purely so the code runs/is testable.
  // Do not treat these defaults as tuned values; revisit against real data
  // (Phase 4 observability) before relying on them, same caveat as above.
  slotAutofillThreshold: process.env.NLU_SLOT_AUTOFILL_THRESHOLD !== undefined
    ? parseFloat(process.env.NLU_SLOT_AUTOFILL_THRESHOLD)
    : 0.85,
  slotSuggestThreshold: process.env.NLU_SLOT_SUGGEST_THRESHOLD !== undefined
    ? parseFloat(process.env.NLU_SLOT_SUGGEST_THRESHOLD)
    : 0.5,
};
