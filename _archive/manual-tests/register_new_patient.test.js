// tests/register_new_patient.test.js
// Drives the exact registration flow in ChatbotEngine.handleRegisterPatientState,
// using your real ChatbotEngine constructor (no DI), and the engine's own SessionManager.
// Usage:
//   node tests/register_new_patient.test.js "+6512345678" "Jane" "Doe" "jane@example.com" "09 04 1990"
// Env:
//   DRY_RUN=1  => mock ClinikoAPI.registerNewPatient/getPatientForms to avoid external calls

const path = require('path');

function getArgs() {
  const [, , argPhone, argFirst, argLast, argEmail, argDob] = process.argv;
  return {
    phone: argPhone || '+6511112222',
    first: argFirst || 'Test',
    last: argLast || 'User',
    email: argEmail || 'test.user@example.com',
    dob: argDob || '09 04 1990' // dd mm yyyy; engine parses to YYYY-MM-DD
  };
}

function safe(obj) { try { return JSON.stringify(obj, null, 2); } catch { return String(obj); } }

(async () => {
  const ChatbotEngine = require(path.join(__dirname, '../src/core/ChatbotEngine.js'));

  // Instantiate exactly as your code defines (engine builds its own SessionManager/ClinikoAPI/Logger)
  const engine = new ChatbotEngine();

  // Optional mock to avoid real API calls while still using your real SessionManager
  const DRY_RUN = process.env.DRY_RUN === '1';
  if (DRY_RUN) {
    const orig = engine.clinikoAPI;
    engine.clinikoAPI = {
      ...orig,
      registerNewPatient: async (patient) => {
        return { id: 123456, patient: { id: 123456, ...patient } };
      },
      getPatientForms: async ({ patient_id }) => [
        {
          id: 999,
          name: 'New Patient Intake',
          url: `https://mock.forms/p/${patient_id || 999}`,
          created_at: new Date().toISOString(),
          completed_at: null,
          archived_at: null
        }
      ]
    };
    console.log('DRY_RUN=1: Mocked ClinikoAPI.registerNewPatient/getPatientForms');
  }

  // Initialize engine (calls sessionManager.initialize())
  await engine.initialize();

  const { phone, first, last, email, dob } = getArgs();

  // Create/get a session via the engine’s sessionManager (shared store)
  let session = await engine.sessionManager.getOrCreateSession(phone);
  if (!session) {
    console.error('FAIL: could not create/get session');
    process.exit(2);
  }

  // Ensure we’re in REGISTER_PATIENT state and clear residuals
  await engine.sessionManager.updateSession(session.id, {
    conversation_state: engine.STATES.REGISTER_PATIENT,
    verified: false,
    data: null,
    email: null,
    patient_id: null
  });
  session = await engine.sessionManager.getSession(session.id);

  async function step(label, input) {
    const s = await engine.sessionManager.getSession(session.id);
    const reply = await engine.handleRegisterPatientState(s, input);
    const after = await engine.sessionManager.getSession(session.id);
    console.log(`\n[${label}] User: "${input}"`);
    console.log('[Bot]', reply);
    console.log('[State]', {
      state: after.conversation_state,
      verified: after.verified,
      email: after.email,
      patient_id: after.patient_id,
      data: after.data
    });
    return { reply, after };
  }

  // Walk through the flow exactly as the handler expects
  await step('Prompt first name', '');      // Expect "Please tell me your first name"
  await step('Provide first name', first);  // Expect prompt for last name
  await step('Provide last name', last);    // Expect prompt for email
  await step('Provide email', email);       // Expect prompt for DOB
  await step('Provide DOB', dob);           // Engine registers patient

  const finalSession = await engine.sessionManager.getSession(session.id);
  console.log('\n=== Final Session Snapshot ===');
  console.log(safe({
    conversation_state: finalSession.conversation_state,
    verified: finalSession.verified,
    email: finalSession.email,
    patient_id: finalSession.patient_id,
    data: finalSession.data
  }));

  const success =
    finalSession.verified === true &&
    !!finalSession.patient_id &&
    finalSession.conversation_state === engine.STATES.BOOK_MANAGE_OPTIONS;

  if (!success) {
    console.error('FAIL: Registration flow did not reach expected final state.');
    process.exit(1);
  }

  // Mid-flow back/menu test: new session to prove "0" goes back to INTRO
  let session2 = await engine.sessionManager.getOrCreateSession(`${phone}-backtest`);
  await engine.sessionManager.updateSession(session2.id, {
    conversation_state: engine.STATES.REGISTER_PATIENT,
    verified: false,
    data: null
  });

  async function step2(label, input) {
    const s = await engine.sessionManager.getSession(session2.id);
    const reply = await engine.handleRegisterPatientState(s, input);
    const after = await engine.sessionManager.getSession(session2.id);
    console.log(`\n[${label}] User: "${input}"`);
    console.log('[Bot]', reply);
    console.log('[State]', {
      state: after.conversation_state,
      verified: after.verified,
      data: after.data
    });
    return after;
  }

  await step2('BackTest: start prompt', '');
  await step2('BackTest: enter first name', first);
  const afterBack = await step2('BackTest: press 0', '0'); // Expect INTRO
  if (afterBack.conversation_state !== engine.STATES.INTRO) {
    console.error('FAIL: Back/menu did not return to INTRO.');
    process.exit(1);
  }

  console.log('\n✅ register_new_patient.test.js complete');
  process.exit(0);
})().catch(e => {
  console.error('❌ Test runner failed:', e?.stack || e?.message || e);
  process.exit(2);
});
