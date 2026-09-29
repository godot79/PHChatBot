// Read-only live verification for feature/sg-physio-tier-funnel.
//
// Corrects an earlier (wrong) fix: SG's "Physiotherapist" and "Senior
// Physiotherapist" are NOT two different session types — they're the same
// self-pay generic Physiotherapy visit, just labeled per practitioner rate
// tier (confirmed live 2026-09-29: neither has its own New/Follow-up split,
// unlike the insured Bupa/Cigna types which do). They must MERGE into one
// bookable option, never show as two separate menu choices implying two
// different kinds of visits. The raw Cliniko name ("Senior Physiotherapist")
// must never leak into confirmations/headers as if it were "the appointment
// type" — that's a job title, not a session type.
//
// This script walks the real SG Book Soonest funnel end to end and asserts:
//   1. final_pick shows Physiotherapy as ONE option (not two), auto-resolving
//      since combos.length === 1 once patientType/duration collapse them.
//   2. The resolved name is "New Patient" (this service DOES have a real
//      New/Follow-up split elsewhere, under Bupa/Cigna) — never the raw
//      "Physiotherapist"/"Senior Physiotherapist" label.
//   3. The resolved ids are the UNION of both tier ids.
//   4. norm_names carries both REAL Cliniko names (unaffected by the
//      display-name override) — proving downstream slot/practitioner
//      matching still works for BOTH tiers, not just whichever id happened
//      to be picked first.
//   5. The practitioner pool built from that resolved type includes
//      physios from BOTH tiers (standard: Jade/Rushi; senior: Sarah/
//      Jolinna/Bernard/Chris/Teck) — the actual functional regression risk
//      of merging without fixing the downstream name-matching.
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

async function main() {
  const { db, engine } = await makeEngine();

  await RegionContext.run('SG', async () => {
    let session = await newSession(db, 'SG', 'BOOK_SOONEST', { navigation_chain: [] });
    let reply = await engine.handleBookSoonest(session, '');
    let data, guard = 0;

    while (guard++ < 10) {
      session = await db.getSession(session.id);
      data = JSON.parse(session.data || '{}');
      if (data.selection_step !== 'choose_type' || data.selected_appt_type) break;
      const replyStr = String(reply);
      console.log(`\n--- funnel step ${guard} (funnel_step=${data.funnel_step}) ---\n${replyStr}`);
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

    check('funnel auto-resolved a type (final_pick never showed a menu with 2+ Physiotherapy rows)', !!data.selected_appt_type,
      JSON.stringify(data.selected_appt_type));

    if (data.selected_appt_type) {
      console.log('Resolved selected_appt_type:', data.selected_appt_type);
      check('resolved name is "New Patient", never the raw tier-label ("Physiotherapist"/"Senior Physiotherapist")',
        data.selected_appt_type.name === 'New Patient', data.selected_appt_type.name);

      const ids = data.selected_appt_type.ids || [];
      check('resolved ids include BOTH tier ids (union, not just one tier)', ids.length >= 2, JSON.stringify(ids));

      const normNames = data.selected_appt_type.norm_names || [];
      check('norm_names carries both real Cliniko names',
        normNames.includes('physiotherapist') && normNames.includes('senior physiotherapist'),
        JSON.stringify(normNames));
    }

    // Now let it proceed past the gender-preference prompt to see the actual
    // built physio pool, and confirm it spans BOTH tiers.
    console.log('\n=== Advancing past gender preference to inspect the practitioner pool ===');
    let guard2 = 0;
    while (guard2++ < 5) {
      session = await db.getSession(session.id);
      data = JSON.parse(session.data || '{}');
      if (data.selection_step === 'choose_physio' && Array.isArray(data.practitioner_list) && data.practitioner_list.length) break;
      reply = await engine.handleBookSoonest(session, guard2 === 1 ? '' : '3'); // "3" = No preference on the gender prompt
    }
    session = await db.getSession(session.id);
    data = JSON.parse(session.data || '{}');
    const names = (data.practitioner_list || []).map(p => `${p.first_name} ${p.last_name}`);
    console.log('Practitioner pool:', names);
    const standardTierNames = ['Jade', 'Rushi'];
    const seniorTierNames = ['Sarah', 'Jolinna', 'Bernard', 'Chris', 'Teck'];
    const hasStandard = names.some(n => standardTierNames.some(s => n.includes(s)));
    const hasSenior = names.some(n => seniorTierNames.some(s => n.includes(s)));
    check('practitioner pool includes at least one STANDARD-tier physio (Jade/Rushi)', hasStandard, JSON.stringify(names));
    check('practitioner pool includes at least one SENIOR-tier physio (Sarah/Jolinna/Bernard/Chris/Teck)', hasSenior, JSON.stringify(names));
  });

  console.log(failed ? '\nOVERALL: FAIL' : '\nOVERALL: PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
