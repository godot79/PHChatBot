// File: tests/manual/run_nlu_live_e2e.js
// Purpose: Live, read-only end-to-end check of the NLU intent-classification layer
// (feature/nlu-intent-layer-phase7) against the REAL Anthropic API and REAL Cliniko
// HK data. Never confirms/writes a booking — every prompt set here stops at list/slot
// rendering, well before the CONFIRM_BOOKING write step.
//
// Requires (never printed/logged): CLINIKO_API_KEY_HK, ANTHROPIC_API_KEY in .env.
// Run: node tests/manual/run_nlu_live_e2e.js [path/to/prompts.json]
//
// Reuses the same live-account pacing discipline as tests/integration/cliniko.live.test.js
// (see waitForClinikoRecovery) — small delay between cases to avoid self-inflicted 429s.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ChatbotEngine = require('../../src/core/ChatbotEngine.js');

const PROMPTS_PATH = process.argv[2] || path.join(__dirname, 'nlu_live_e2e_prompts.json');
const OUT_PATH = path.join(__dirname, `nlu_live_e2e_results_${Date.now()}.log`);
const INTER_CASE_DELAY_MS = 4000;

if (!process.env.CLINIKO_API_KEY_HK) {
  console.error('CLINIKO_API_KEY_HK not set — refusing to run live E2E check.');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set — refusing to run live E2E check.');
  process.exit(1);
}

const cases = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));

// Capture ANALYTICS_EVENT lines (logger.analyticsEvent -> console.log(JSON.stringify({marker:'ANALYTICS_EVENT', ...}))).
// Every other console.log passes through untouched.
let capturedEvents = [];
const realConsoleLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('"marker":"ANALYTICS_EVENT"')) {
    try { capturedEvents.push(JSON.parse(args[0])); } catch { /* ignore parse failures */ }
    return; // keep stdout focused on this script's own report
  }
  // Swallow the engine's own verbose console.log lines (🤖 HANDLE_MSG / 🗺️ STATE_CHECK etc.)
  // — this script writes its own summary below instead.
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let nextPhoneSeq = 1;
function nextPhone() {
  return `+85299${String(900000 + nextPhoneSeq++).padStart(6, '0')}`;
}

async function seedSession(engine, phone, seed) {
  let session = await engine.sessionManager.getOrCreateSession(phone);
  // context.language must be pre-set for INTRO — otherwise handleIntroState detours into
  // the language-picker prompt before ever reaching its NLU dead-end.
  await engine.sessionManager.updateSession(session.id, {
    conversation_state: seed.state,
    verification_status: 'verified',
    verified: 1,
    patient_id: 'LIVE-E2E-TEST-PATIENT',
    context: { region: seed.region || 'HK', language: 'en' },
    data: JSON.stringify({ email: 'live-e2e-test@example.invalid', patient_name: 'Live E2E Test', ...(seed.data || {}) }),
  });
  // A real chat-history row so handleMessageEnvelope's first-contact detection (which only
  // affects prefix copy, not routing) doesn't fire for these already-mid-conversation seeds.
  await engine.sessionManager.db.addChatHistory(session.id, '(seeded)', '(seeded)');
  return await engine.sessionManager.getSession(session.id);
}

async function runCase(engine, testCase, outStream) {
  const phone = nextPhone();
  capturedEvents = [];
  await seedSession(engine, phone, testCase.seed);

  outStream.write(`\n${'='.repeat(80)}\n`);
  outStream.write(`CASE: ${testCase.id}\n`);
  outStream.write(`NOTE: ${testCase.note || ''}\n`);
  outStream.write(`SEED STATE: ${testCase.seed.state}\n`);

  for (let i = 0; i < testCase.turns.length; i++) {
    const text = testCase.turns[i];
    outStream.write(`\n--- turn ${i + 1} ---\n`);
    outStream.write(`USER: ${text}\n`);
    let reply;
    try {
      reply = await engine.handleMessage(text, phone);
    } catch (err) {
      outStream.write(`ERROR: ${err.stack || err.message}\n`);
      continue;
    }
    outStream.write(`BOT: ${String(reply).slice(0, 700)}${String(reply).length > 700 ? '...[truncated]' : ''}\n`);
  }

  if (capturedEvents.length) {
    outStream.write(`\nNLU EVENTS:\n`);
    for (const ev of capturedEvents) {
      outStream.write(`  ${JSON.stringify({ event: ev.event, state: ev.state, intent: ev.intent, confidence: ev.confidence, matched: ev.matched })}\n`);
    }
  } else {
    outStream.write(`\nNLU EVENTS: (none captured — keyword shortcut short-circuited before the NLU call, or state has no NLU wiring)\n`);
  }
}

(async () => {
  const outStream = fs.createWriteStream(OUT_PATH, { flags: 'a' });
  realConsoleLog(`Live NLU E2E check — ${cases.length} cases, real Anthropic + real Cliniko HK (read-only).`);
  realConsoleLog(`Results: ${OUT_PATH}`);

  const engine = new ChatbotEngine();
  await engine.initialize();

  let ran = 0;
  for (const testCase of cases) {
    try {
      await runCase(engine, testCase, outStream);
      ran++;
    } catch (err) {
      outStream.write(`\nCASE ${testCase.id} CRASHED: ${err.stack || err.message}\n`);
    }
    await sleep(INTER_CASE_DELAY_MS);
  }

  outStream.end();
  realConsoleLog(`Done. ${ran}/${cases.length} cases ran. See ${OUT_PATH}`);
  process.exit(0);
})();
