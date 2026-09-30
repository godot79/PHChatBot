// Read-only live verification: physio-tier funnel wired into
// handleBookSpecificDate and handleBookSpecificClinic (Book Soonest was
// already verified separately). Confirms the tier prompt appears, and
// picking a tier correctly narrows the rendered practitioner list.
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

async function verifySpecificDate(db, engine) {
  console.log('\n=== handleBookSpecificDate: tier funnel ===');
  await RegionContext.run('SG', async () => {
    let session = await newSession(db, 'SG', 'BOOK_SPECIFIC_DATE', {
      selection_step: 'choose_date',
      navigation_chain: [],
    });
    let reply = String(await engine.handleBookSpecificDate(session, '1')); // pick a date
    session = await db.getSession(session.id);
    let data = JSON.parse(session.data || '{}');
    console.log('choose_type reply:\n' + reply.slice(0, 400));
    let { rows, match } = pickRow(reply, /^new patient$/i);
    check('found the unified "New Patient" type row (joins the insured bucket)', !!match, JSON.stringify(rows));
    if (!match) return;
    reply = String(await engine.handleBookSpecificDate(session, match.n));
    console.log('After picking "New Patient" (expect coverage question):\n' + reply.slice(0, 300));
    check('coverage question shown ("How is this covered?")', /how is this covered/i.test(reply), reply.slice(0, 150));
    if (!/how is this covered/i.test(reply)) return;
    ({ rows, match } = pickRow(reply, /self-pay/i));
    check('found "Self-pay" coverage option', !!match, JSON.stringify(rows));
    if (!match) return;
    reply = String(await engine.handleBookSpecificDate(session, match.n));
    session = await db.getSession(session.id);
    data = JSON.parse(session.data || '{}');
    console.log('After picking Self-pay:\n' + reply.slice(0, 300));
    check('tier-selection prompt shown', /which physio/i.test(reply), reply.slice(0, 150));
    if (!/which physio/i.test(reply)) return;
    ({ rows, match } = pickRow(reply, /^physiotherapist$/i));
    check('found standard "Physiotherapist" tier option', !!match, JSON.stringify(rows));
    if (!match) return;
    const genderReply = String(await engine.handleBookSpecificDate(session, match.n));
    console.log('After picking tier (expect gender prompt — this flow has one, unlike Specific Clinic):\n' + genderReply.slice(0, 200));
    check('gender prompt shown after tier (correct ordering: tier before gender)', /male|female|no preference/i.test(genderReply));
    session = await db.getSession(session.id);
    const listReply = String(await engine.handleBookSpecificDate(session, '3')); // no gender preference
    console.log('Rendered physio list after tier + gender pick:\n' + listReply);
    const names = [...listReply.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => m[1].trim());
    check('list excludes senior-only physios (Sarah/Jolinna/Bernard)',
      !names.some(n => ['Sarah', 'Jolinna', 'Bernard'].some(s => n.includes(s))), JSON.stringify(names));
    check('list includes standard-tier physios (Jade/Rushi)',
      names.some(n => n.includes('Jade') || n.includes('Rushi')), JSON.stringify(names));
  });
}

async function verifySpecificClinic(db, engine) {
  console.log('\n=== handleBookSpecificClinic: tier funnel ===');
  await RegionContext.run('SG', async () => {
    const groups = await engine.clinikoAPI.getPractitionersByClinic();
    const clinic = groups[0];
    let session = await newSession(db, 'SG', 'BOOK_SPECIFIC_CLINIC', {
      selection_step: 'choose_type',
      selected_clinic: { id: clinic.clinic_id, business_name: clinic.clinic_name },
      navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
    });
    let reply = String(await engine.handleBookSpecificClinic(session, ''));
    console.log('choose_type reply:\n' + reply.slice(0, 400));
    let { rows, match } = pickRow(reply, /^new patient$/i);
    check('found the unified "New Patient" type row (joins the insured bucket)', !!match, JSON.stringify(rows));
    if (!match) return;
    reply = String(await engine.handleBookSpecificClinic(session, match.n));
    console.log('After picking "New Patient" (expect coverage question):\n' + reply.slice(0, 300));
    check('coverage question shown ("How is this covered?")', /how is this covered/i.test(reply), reply.slice(0, 150));
    if (!/how is this covered/i.test(reply)) return;
    ({ rows, match } = pickRow(reply, /self-pay/i));
    check('found "Self-pay" coverage option', !!match, JSON.stringify(rows));
    if (!match) return;
    reply = String(await engine.handleBookSpecificClinic(session, match.n));
    console.log('After picking Self-pay:\n' + reply.slice(0, 300));
    check('tier-selection prompt shown', /which physio/i.test(reply), reply.slice(0, 150));
    if (!/which physio/i.test(reply)) return;
    ({ rows, match } = pickRow(reply, /^physiotherapist$/i));
    check('found standard "Physiotherapist" tier option', !!match, JSON.stringify(rows));
    if (!match) return;
    const listReply = String(await engine.handleBookSpecificClinic(session, match.n));
    console.log('Rendered physio list after tier pick:\n' + listReply);
    const names = [...listReply.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => m[1].trim());
    check('list excludes senior-only physios (Sarah/Jolinna/Bernard)',
      !names.some(n => ['Sarah', 'Jolinna', 'Bernard'].some(s => n.includes(s))), JSON.stringify(names));
    check('list includes standard-tier physios (Jade/Rushi)',
      names.some(n => n.includes('Jade') || n.includes('Rushi')), JSON.stringify(names));
  });
}

async function main() {
  const { db, engine } = await makeEngine();
  await verifySpecificDate(db, engine);
  await verifySpecificClinic(db, engine);
  console.log(failed ? '\nOVERALL: FAIL' : '\nOVERALL: PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
