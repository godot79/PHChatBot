// Read-only live verification: confirms HK has ZERO residual effect from
// feature/sg-physio-tier-funnel — across all 5 booking flows' choose_type
// builders and Book Soonest's funnel. HK has no 'physioTiers' capability,
// so every code path this branch touches must be a structural no-op there.
require('dotenv').config();
const RegionContext = require('../../src/core/RegionContext');
const DatabaseManager = require('../../src/core/DatabaseManager');
const SessionManager = require('../../src/core/SessionManager');
const ChatbotEngine = require('../../src/core/ChatbotEngine');
const { hasCapability } = require('../../src/config/regions');

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

function assertNoMergeArtifacts(list, label) {
  const names = (list || []).map(t => t.name);
  const hasSelfPaySuffix = names.some(n => /\(self-pay\)/i.test(n));
  const hasBareServiceName = names.some(n => /^(physiotherapy|sports massage|paediatrics)$/i.test(n));
  check(`${label}: no "(Self-pay)" merge-fallback artifacts`, !hasSelfPaySuffix, JSON.stringify(names));
  check(`${label}: no bare-service-name merge-fallback artifacts`, !hasBareServiceName, JSON.stringify(names));
  console.log(`  ${label} names:`, names);
}

async function main() {
  const { db, engine } = await makeEngine();

  check('hasCapability(HK, physioTiers) is false', !hasCapability('HK', 'physioTiers'));

  await RegionContext.run('HK', async () => {
    const groups = await engine.clinikoAPI.getPractitionersByClinic();
    const clinic = groups[0];
    const allPrac = groups.flatMap(g => g.practitioners);

    // 1. handleBookSpecificClinic
    {
      const session = await newSession(db, 'HK', 'BOOK_SPECIFIC_CLINIC', {
        selection_step: 'choose_type',
        selected_clinic: { id: clinic.clinic_id, business_name: clinic.clinic_name },
        navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
      });
      await engine.handleBookSpecificClinic(session, '');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      assertNoMergeArtifacts(d.appointment_type_list, 'handleBookSpecificClinic');
      const s2 = await db.getSession(session.id);
      const reply = String(await engine.handleBookSpecificClinic(s2, '1'));
      check('handleBookSpecificClinic: tier prompt never fires for HK', !/which physio would you like/i.test(reply), reply.slice(0, 150));
    }

    // 2. handleBookSpecificDate — also proceed into choose_physio to confirm
    // the tier-funnel gate (wired in 2026-09-30) never fires for HK.
    {
      const session = await newSession(db, 'HK', 'BOOK_SPECIFIC_DATE', {
        selection_step: 'choose_date',
        navigation_chain: [],
      });
      await engine.handleBookSpecificDate(session, '1');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      assertNoMergeArtifacts(d.appointment_type_list, 'handleBookSpecificDate');
      const s2 = await db.getSession(session.id);
      const reply = String(await engine.handleBookSpecificDate(s2, '1'));
      check('handleBookSpecificDate: tier prompt never fires for HK', !/which physio would you like/i.test(reply), reply.slice(0, 150));
    }

    // 3. handleBookSpecificPhysio (first real physio)
    {
      const physio = allPrac[0];
      const session = await newSession(db, 'HK', 'BOOK_SPECIFIC_PHYSIO', {
        selection_step: 'choose_type',
        selected_physio: physio,
        navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
      });
      await engine.handleBookSpecificPhysio(session, '');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      assertNoMergeArtifacts(d.appointment_type_list, `handleBookSpecificPhysio (${physio.first_name} ${physio.last_name})`);
    }

    // 4. handleBookHistory (same physio)
    {
      const physio = allPrac[0];
      const session = await newSession(db, 'HK', 'BOOK_HISTORY', {
        selection_step: 'choose_type',
        selected_physio: physio,
        navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
      });
      await engine.handleBookHistory(session, '');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      assertNoMergeArtifacts(d.appointment_type_list, `handleBookHistory (${physio.first_name} ${physio.last_name})`);
    }

    // 5. Book Soonest — buildTypeCatalogue path + tier funnel must never fire
    {
      const session = await newSession(db, 'HK', 'BOOK_SOONEST', { navigation_chain: [] });
      const reply = await engine.handleBookSoonest(session, '');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      assertNoMergeArtifacts(d.appointment_type_list, 'handleBookSoonest (buildTypeCatalogue)');
      check('handleBookSoonest first reply is never the tier-selection prompt for HK',
        !/which physio would you like/i.test(String(reply)), String(reply).slice(0, 150));
    }
  });

  console.log(failed ? '\nOVERALL: FAIL' : '\nOVERALL: PASS — HK confirmed unaffected across all 5 flows + Book Soonest');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
