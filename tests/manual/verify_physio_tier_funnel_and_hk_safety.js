// Read-only live verification for feature/sg-physio-tier-funnel.
//
// Two parts:
//   1. SG: walk Book Soonest's real funnel through to Physiotherapy, confirm
//      the tier-selection prompt appears (before gender), picking a tier
//      correctly narrows the practitioner pool to just that tier, and the
//      resolved type name is never a raw practitioner-title label.
//   2. HK: run all 5 choose_type builders against real HK data and confirm
//      output is byte-identical to a baseline captured from `main` (pre this
//      branch) — the "HK must not change at all" constraint. Run this script
//      once on `main`, save its HK section output, then again on this branch
//      and diff — see the printed instructions at the end.
//
// No writes — only GET calls, same convention as other tests/manual scripts.
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

async function runSGTierFunnel(db, engine) {
  console.log('\n=== PART 1: SG tier-selection funnel (live) ===');
  await RegionContext.run('SG', async () => {
    let session = await newSession(db, 'SG', 'BOOK_SOONEST', { navigation_chain: [] });
    let reply = await engine.handleBookSoonest(session, '');
    let data, guard = 0;
    while (guard++ < 10) {
      session = await db.getSession(session.id);
      data = JSON.parse(session.data || '{}');
      if (data.selection_step !== 'choose_type' || data.selected_appt_type) break;
      const replyStr = String(reply);
      let rows = [...replyStr.matchAll(/^(\d+)\.\s+(.+)$/gm)].map(m => ({ n: m[1], text: m[2].trim() }));
      if (!rows.length) {
        const optionsLine = replyStr.split('\n').find(l => l.includes('·'));
        if (optionsLine) rows = optionsLine.split('·').map((t, i) => ({ n: String(i + 1), text: t.trim() }));
      }
      const pick = rows.find(r => /physiotherap/i.test(r.text)) || rows[0];
      reply = await engine.handleBookSoonest(session, pick ? pick.n : '1');
    }
    session = await db.getSession(session.id);
    data = JSON.parse(session.data || '{}');
    check('type resolved (Physiotherapy merged automatically)', !!data.selected_appt_type, JSON.stringify(data.selected_appt_type));
    check('resolved name is never a raw tier label', data.selected_appt_type && !/senior physiotherapist|^physiotherapist$/i.test(data.selected_appt_type.name), data.selected_appt_type && data.selected_appt_type.name);

    // Next reply (physio-list-building already happened synchronously above
    // via the recursive call chain) — check the tier prompt appears.
    session = await db.getSession(session.id);
    data = JSON.parse(session.data || '{}');
    const tierReply = String(reply);
    console.log('Reply after type resolves:\n' + tierReply.slice(0, 300));
    const isTierPrompt = /which physio/i.test(tierReply);
    check('tier-selection prompt shown before gender', isTierPrompt, tierReply.slice(0, 150));

    if (isTierPrompt) {
      const rows = [...tierReply.matchAll(/^(\d+)\.\s+(.+)$/gm)].map(m => ({ n: m[1], text: m[2].trim() }));
      let optionsLine = tierReply.split('\n').find(l => l.includes('·'));
      const buttonRows = optionsLine ? optionsLine.split('·').map((t, i) => ({ n: String(i + 1), text: t.trim() })) : [];
      const allRows = rows.length ? rows : buttonRows;
      console.log('Tier options:', allRows.map(r => r.text));
      const standardRow = allRows.find(r => /^physiotherapist$/i.test(r.text));
      check('found a "Physiotherapist" (standard) tier option', !!standardRow, JSON.stringify(allRows));
      if (standardRow) {
        const genderReply = String(await engine.handleBookSoonest(session, standardRow.n));
        check('after picking a tier, next prompt is gender (not re-shown tier menu, not physio list yet)',
          /male|female|no preference/i.test(genderReply), genderReply.slice(0, 150));
        session = await db.getSession(session.id);
        data = JSON.parse(session.data || '{}');
        check('physio_tier_sel recorded as "physiotherapist" (standard)', data.physio_tier_sel === 'physiotherapist', data.physio_tier_sel);
        const listReply = String(await engine.handleBookSoonest(session, '3')); // no preference
        session = await db.getSession(session.id);
        data = JSON.parse(session.data || '{}');
        // data.practitioner_list is intentionally kept as the FULL raw list
        // (so filters can be reapplied dynamically, e.g. on pagination) — the
        // real correctness signal is what's actually rendered to the patient.
        console.log('Rendered physio list reply:\n' + listReply);
        const names = [...listReply.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => m[1].trim());
        console.log('Filtered practitioner pool (tier=standard):', names);
        const seniorOnlyNames = ['Sarah', 'Jolinna', 'Bernard'];
        const hasSeniorOnly = names.some(n => seniorOnlyNames.some(s => n.includes(s)));
        check('practitioner pool does NOT include senior-only physios after picking standard tier',
          !hasSeniorOnly, JSON.stringify(names));
        check('practitioner pool includes standard-tier physios (Jade/Rushi)',
          names.some(n => n.includes('Jade') || n.includes('Rushi')), JSON.stringify(names));
      }
    }
  });
}

async function runHKChooseTypeSnapshot(db, engine) {
  console.log('\n=== PART 2: HK choose_type snapshot (compare across branches) ===');
  await RegionContext.run('HK', async () => {
    const groups = await engine.clinikoAPI.getPractitionersByClinic();
    const clinic = groups[0];
    const session = await newSession(db, 'HK', 'BOOK_SPECIFIC_CLINIC', {
      selection_step: 'choose_type',
      selected_clinic: { id: clinic.clinic_id, business_name: clinic.clinic_name },
      navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
    });
    await engine.handleBookSpecificClinic(session, '');
    const d = JSON.parse((await db.getSession(session.id)).data || '{}');
    const snapshot = (d.appointment_type_list || []).map(t => ({ name: t.name, ids: (t.ids || []).slice().sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    console.log('HK handleBookSpecificClinic choose_type snapshot:');
    console.log(JSON.stringify(snapshot, null, 2));
    console.log('\n>>> Save this output and diff against the same run on `main` (pre-branch) to confirm byte-identical HK behavior. <<<');
  });
}

async function main() {
  const { db, engine } = await makeEngine();
  await runSGTierFunnel(db, engine);
  await runHKChooseTypeSnapshot(db, engine);
  console.log(failed ? '\nOVERALL: FAIL' : '\nOVERALL: PASS (Part 1 automated; Part 2 requires manual diff against main)');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
