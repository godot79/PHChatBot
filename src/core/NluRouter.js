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
//
// 'book_appointment' is a generic catch-all, correctly wired at the outer
// BOOK_MANAGE_OPTIONS dead-end (handleBookManageOptions, ChatbotEngine.js
// ~1456: "wants to book, hasn't said how" -> booking-method menu). It's
// unhandled at the inner BOOKING_METHOD_OPTIONS site though (user already
// said "book"), and a live check (2026-08-20) showed Haiku reaches for it
// there on type-only phrasing ("book me a massage", "new patient assessment
// please"), dead-ending those messages. 'book_by_type' covers that inner
// case instead: type named, no specific method/clinic — routes into the
// BOOK_SOONEST funnel (type -> physio -> clinic), which already resolves
// exactly this shape of request instead of forcing a method choice first.
const KNOWN_INTENTS = [
  'book_appointment',
  'book_by_type',
  'cancel_appointment',
  'reschedule_appointment',
  'book_history',
  'book_soonest',
  'book_specific_date',
  'book_specific_physio',
  'book_specific_clinic',
  // Phase 3: wired at the INTRO dead-end (handleIntroState) only, for
  // unverified users asking about fees/locations in free text instead of
  // tapping menu options 3/4.
  'view_fees',
  'view_locations',
];

// Phase 6: intents that still mean "the user is booking/adjusting a slot in
// the current flow" — used to gate mid-flow corrections. A live check
// (2026-08-21) showed genuine corrections ("actually make it Thursday")
// often classify under a generic/adjacent intent (book_appointment,
// reschedule_appointment, book_by_type) rather than the exact
// book_specific_* intent tied to the handler the user is already in — so
// gating on an exact intent match silently drops real corrections.
// Deliberately excludes cancel_appointment/book_history/book_soonest/
// view_fees/view_locations: those represent the user asking about
// something else entirely, not correcting the current selection, and a
// slot-shaped value extracted alongside one of those must not clear
// in-progress flow state.
const MIDFLOW_CORRECTION_INTENTS = [
  'book_appointment',
  'book_by_type',
  'reschedule_appointment',
  'book_specific_date',
  'book_specific_physio',
  'book_specific_clinic',
];

// Phase 5: date/physio slots let a single message pick the right existing
// funnel (BOOK_SPECIFIC_DATE / BOOK_SPECIFIC_PHYSIO) instead of always
// collapsing to book_by_type/book_appointment. Model resolves relative
// phrasing ("next Tuesday") against the "today" date given in the system
// prompt (see buildSystemPrompt below) and must return an absolute
// YYYY-MM-DD, never a relative string.
const TODAY_ISO = () => new Date().toISOString().slice(0, 10);
// Phase 6: existingSlots (when supplied via classifyIntent's sessionContext)
// tells Haiku what's already been picked in the current funnel, so it can
// tell a genuine correction ("actually make it Thursday") from an
// unrelated/ambiguous message instead of always extracting slots cold.
function buildSystemPrompt(existingSlots) {
  let prompt = `Today's date is ${TODAY_ISO()} (YYYY-MM-DD). When extracting a date slot, resolve any relative date phrasing ("next Tuesday", "tomorrow") to an absolute YYYY-MM-DD date using today's date as the reference point. Never return a relative phrase as the date value. When extracting a physio slot, return only the practitioner's name, with any honorific ("Dr", "Dr.", "Mr", "Mrs", "Ms") removed — e.g. "Dr Chan" should be extracted as "Chan", not "Dr Chan".`;
  if (existingSlots && Object.keys(existingSlots).length > 0) {
    const known = Object.entries(existingSlots).map(([k, v]) => `${k}=${v}`).join(', ');
    prompt += ` The user is already partway through booking with these selections already made: ${known}. Only extract a slot for one of these if the message clearly states a *different* value for it (a correction, e.g. "actually Thursday" or "no, Dr Chan instead") — otherwise omit that slot.`;
  }
  return prompt;
}

// Phase 2 vocabulary: appointment-type slot only, wired into two handlers so
// far — BOOK_SPECIFIC_CLINIC (book_specific_clinic: clinic already decided)
// and BOOK_SOONEST (book_by_type: type named, method/clinic not decided).
// Each slot carries its own confidence so a confident intent match doesn't
// force a low-confidence slot guess to be either silently applied or
// silently dropped — see isSlotAutofillable/isSlotSuggestable below and
// config/anthropic.js for the threshold split.
const CLASSIFY_TOOL = {
  name: 'classify_intent',
  description: 'Classify a WhatsApp user message into a known booking-bot intent, with optional extracted slots for booking intents.',
  input_schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: KNOWN_INTENTS },
      slots: {
        type: 'object',
        properties: {
          appointmentType: {
            type: 'object',
            description: 'Appointment/visit type mentioned in the message (e.g. "physio", "massage"), if any.',
            properties: {
              value: { type: 'string', description: 'The appointment type as mentioned by the user, in their own words.' },
              confidence: { type: 'number', description: 'Confidence 0-1 that this slot value is correct.' },
            },
            required: ['value', 'confidence'],
          },
          date: {
            type: 'object',
            description: 'A specific calendar date the user wants, if any, resolved to an absolute date using today\'s date from the system prompt.',
            properties: {
              value: { type: 'string', description: 'The date as an absolute YYYY-MM-DD string. Never a relative phrase.' },
              confidence: { type: 'number', description: 'Confidence 0-1 that this slot value is correct.' },
            },
            required: ['value', 'confidence'],
          },
          physio: {
            type: 'object',
            description: 'A specific practitioner/physio name mentioned in the message, if any.',
            properties: {
              value: { type: 'string', description: 'The practitioner name as mentioned by the user, in their own words.' },
              confidence: { type: 'number', description: 'Confidence 0-1 that this slot value is correct.' },
            },
            required: ['value', 'confidence'],
          },
        },
      },
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

// Slot-confidence tiers, mirroring isConfident's single-source-of-truth
// pattern so callers never compare against config.slot*Threshold directly.
function isSlotAutofillable(slot) {
  return !!slot && typeof slot.confidence === 'number'
    && typeof slot.value === 'string' && slot.value.length > 0
    && slot.confidence >= config.slotAutofillThreshold;
}

function isSlotSuggestable(slot) {
  return !!slot && typeof slot.confidence === 'number'
    && typeof slot.value === 'string' && slot.value.length > 0
    && slot.confidence >= config.slotSuggestThreshold
    && slot.confidence < config.slotAutofillThreshold;
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
      system: buildSystemPrompt(sessionContext && sessionContext.existingSlots),
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

module.exports = { classifyIntent, NO_CLASSIFICATION, KNOWN_INTENTS, MIDFLOW_CORRECTION_INTENTS, isConfident, isSlotAutofillable, isSlotSuggestable };
