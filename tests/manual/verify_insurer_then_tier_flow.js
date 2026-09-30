// Read-only live verification: confirms the corrected architecture — a
// tier-merged self-pay type joins the SAME bucket as real insured entries
// (not a separately-labeled row), so _stepTypeInsurer's existing "How is
// this covered?" question naturally offers Self-pay as one option, and
// (for aggregate flows spanning multiple physios) the physio-tier funnel
// fires AFTER coverage resolves to self-pay, only when >1 real tier ids
// remain.
require('dotenv').config();
const RegionContext = require('../../src/core/RegionContext');
const DatabaseManager = require('../../src/core/DatabaseManager');
const SessionManager = require('../../src/core/SessionManager');
const ChatbotEngine = require('../../src/core/ChatbotEngine');

async function makeEngine() {
  const db = new DatabaseManager();
  await db.initialize();
  const sm = new SessionManager(db);
  await sm.initialize();
  const engine = new ChatbotEngine();
  engine.sessionManager = sm;
  return { db, engine };
}

async function newSession(db, region, state, data) {
  const phone = `+VERIFY-${region}-${state}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const id = await db.createSession(phone, 'PATIENT-VERIFY', 60);
  await db.updateSession(id, {
    verification_status: 'verified', verified: 1, patient_id: 'PATIENT-VERIFY',
    conversation_state: state,
    data: JSON.stringify({ email: 'verify@test.com', ...data }),
    context: JSON.stringify({ region }),
  });
  return db.getSession(id);
}

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
}

function pickRow(replyStr, matcher) {
  let rows = [...replyStr.matchAll(/^(\d+)\.\s+(.+)$/gm)].map(m => ({ n: m[1], text: m[2].trim() }));
  if (!rows.length) {
    const optionsLine = replyStr.split('\n').find(l => l.includes('·'));
    if (optionsLine) rows = optionsLine.split('·').map((t, i) => ({ n: String(i + 1), text: t.trim() }));
  }
  return { rows, match: rows.find(r => matcher.test(r.text)) };
}

async function verifySinglePhysio(db, engine) {
  console.log('\n=== handleBookSpecificPhysio (Jade — single physio, no tier ambiguity) ===');
  await RegionContext.run('SG', async () => {
    const groups = await engine.clinikoAPI.getPractitionersByClinic();
    const jade = groups.flatMap(g => g.practitioners).find(p => p.first_name === 'Jade');
    let session = await newSession(db, 'SG', 'BOOK_SPECIFIC_PHYSIO', {
      selection_step: 'choose_type',
      selected_physio: jade,
      navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
    });
    let reply = String(await engine.handleBookSpecificPhysio(session, ''));
    console.log('choose_type:\n' + reply.slice(0, 300));
    let { match } = pickRow(reply, /^new patient$/i);
    check('found single unified "New Patient" row', !!match);
    if (!match) return;
    reply = String(await engine.handleBookSpecificPhysio(session, match.n));
    console.log('After picking "New Patient":\n' + reply.slice(0, 300));
    check('coverage question shown ("How is this covered?")', /how is this covered/i.test(reply), reply.slice(0, 150));
    ({ match } = pickRow(reply, /self-pay/i));
    check('found "Self-pay" coverage option', !!match, reply.slice(0, 300));
    if (!match) return;
    reply = String(await engine.handleBookSpecificPhysio(session, match.n));
    console.log('After picking Self-pay:\n' + reply.slice(0, 300));
    // Single physio → no tier ambiguity possible → straight to physio list build / slots, never the tier prompt
    check('no tier prompt (single physio, no ambiguity)', !/which physio would you like/i.test(reply), reply.slice(0, 150));
    const d = JSON.parse((await db.getSession(session.id)).data || '{}');
    // The flow already auto-advanced to SELECT_SLOT (single physio, no
    // ambiguity), which moves selected_appt_type into prev_state_data.
    const resolvedType = d.selected_appt_type || d.prev_state_data?.selected_appt_type;
    check('resolved to exactly Jade\'s own self-pay id', resolvedType && resolvedType.ids.length === 1, JSON.stringify(resolvedType));
  });
}

async function verifyAggregateFlow(db, engine) {
  console.log('\n=== handleBookSpecificClinic (aggregate — coverage THEN tier) ===');
  await RegionContext.run('SG', async () => {
    const groups = await engine.clinikoAPI.getPractitionersByClinic();
    const clinic = groups[0];
    let session = await newSession(db, 'SG', 'BOOK_SPECIFIC_CLINIC', {
      selection_step: 'choose_type',
      selected_clinic: { id: clinic.clinic_id, business_name: clinic.clinic_name },
      navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
    });
    let reply = String(await engine.handleBookSpecificClinic(session, ''));
    console.log('choose_type:\n' + reply.slice(0, 300));
    let { match } = pickRow(reply, /^new patient$/i);
    check('found single unified "New Patient" row', !!match, reply.slice(0, 300));
    if (!match) return;
    reply = String(await engine.handleBookSpecificClinic(session, match.n));
    console.log('After picking "New Patient":\n' + reply.slice(0, 300));
    check('coverage question shown', /how is this covered/i.test(reply), reply.slice(0, 150));
    ({ match } = pickRow(reply, /self-pay/i));
    check('found "Self-pay" coverage option', !!match);
    if (!match) return;
    reply = String(await engine.handleBookSpecificClinic(session, match.n));
    console.log('After picking Self-pay (expect tier prompt — multiple physios, multiple real tier ids):\n' + reply.slice(0, 300));
    check('tier-selection prompt shown after coverage resolves', /which physio would you like/i.test(reply), reply.slice(0, 150));
    if (!/which physio/i.test(reply)) return;
    ({ match } = pickRow(reply, /^physiotherapist$/i));
    check('found standard "Physiotherapist" tier option', !!match);
    if (!match) return;
    const listReply = String(await engine.handleBookSpecificClinic(session, match.n));
    const names = [...listReply.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => m[1].trim());
    console.log('Filtered physio list:', names);
    check('list narrowed to standard tier (Jade/Rushi), no senior-only names',
      names.some(n => n.includes('Jade') || n.includes('Rushi')) &&
      !names.some(n => ['Sarah', 'Jolinna', 'Bernard'].some(s => n.includes(s))),
      JSON.stringify(names));
  });
}

async function main() {
  const { db, engine } = await makeEngine();
  await verifySinglePhysio(db, engine);
  await verifyAggregateFlow(db, engine);
  console.log(failed ? '\nOVERALL: FAIL' : '\nOVERALL: PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
