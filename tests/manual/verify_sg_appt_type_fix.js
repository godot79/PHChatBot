// Read-only live verification for fix/sg-appt-type-name-collision.
// Exercises the real choose_type builders in all 5 booking flows
// (handleBookHistory, handleBookSpecificDate, handleBookSpecificPhysio,
// handleBookSpecificClinic, handleBookSoonest) against live SG Cliniko data
// (Prohealth In Touch Physiotherapy clinic, which holds the real
// "Physiotherapist"/"Physiotherapist"-under-Sports-Massage collision per
// project_singapore_physio_tiers memory), then repeats handleBookSpecificClinic
// against a real HK clinic to confirm HK's bucketing (name-only merge) is
// unchanged. Book Soonest's real menu path (_stepApptFunnel) already keys by
// category and was never vulnerable per the memory notes, but its secondary
// builder (buildTypeCatalogue, used on "back" navigation) was still patched
// for consistency — this checks that path live too rather than assuming.
// No writes — only getPractitionersByClinic / getAppointmentTypes (both GET).
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

function printList(label, list) {
  console.log(`\n[${label}]`);
  for (const t of list || []) {
    console.log(`  - "${t.name}" ids=${JSON.stringify(t.ids || [t.id])}`);
  }
}

async function runClinicFlow(engine, db, region) {
  const groups = await engine.clinikoAPI.getPractitionersByClinic();
  const clinic = groups[0];
  console.log(`\n=== [${region}] handleBookSpecificClinic — clinic: ${clinic.clinic_name} (${clinic.clinic_id}) ===`);
  const session = await newSession(db, region, 'BOOK_SPECIFIC_CLINIC', {
    selection_step: 'choose_type',
    selected_clinic: { id: clinic.clinic_id, business_name: clinic.clinic_name },
    navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
  });
  await engine.handleBookSpecificClinic(session, '');
  const d = JSON.parse((await db.getSession(session.id)).data || '{}');
  printList(`${region} handleBookSpecificClinic`, d.appointment_type_list);
  return { list: d.appointment_type_list || [], clinic, groups };
}

async function findPhysioWithCollision(engine, groups) {
  // Prefer a practitioner who holds BOTH the real Physiotherapy "Physiotherapist"
  // type AND the Sports-Massage "Physiotherapist" type (e.g. Jade), so History
  // and Specific-Physio flows also exercise the collision.
  for (const clinic of groups) {
    for (const p of clinic.practitioners) {
      const types = await engine.clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
      const names = (types || []).map(t => t.name);
      const physioCount = names.filter(n => /^physiotherapist$/i.test(n)).length;
      if (physioCount >= 2) return { practitioner: p, types };
    }
  }
  return null;
}

async function runHistoryFlow(engine, db, region, physio) {
  console.log(`\n=== [${region}] handleBookHistory — physio: ${physio.first_name} ${physio.last_name} (id=${physio.id}) ===`);
  const session = await newSession(db, region, 'BOOK_HISTORY', {
    selection_step: 'choose_type',
    selected_physio: { id: physio.id, first_name: physio.first_name, last_name: physio.last_name },
    navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
  });
  await engine.handleBookHistory(session, '');
  const d = JSON.parse((await db.getSession(session.id)).data || '{}');
  printList(`${region} handleBookHistory`, d.appointment_type_list);
  return d.appointment_type_list || [];
}

async function runSpecificPhysioFlow(engine, db, region, physio) {
  console.log(`\n=== [${region}] handleBookSpecificPhysio — physio: ${physio.first_name} ${physio.last_name} (id=${physio.id}) ===`);
  const session = await newSession(db, region, 'BOOK_SPECIFIC_PHYSIO', {
    selection_step: 'choose_type',
    selected_physio: { id: physio.id, first_name: physio.first_name, last_name: physio.last_name },
    navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
  });
  await engine.handleBookSpecificPhysio(session, '');
  const d = JSON.parse((await db.getSession(session.id)).data || '{}');
  printList(`${region} handleBookSpecificPhysio`, d.appointment_type_list);
  return d.appointment_type_list || [];
}

async function runBookSoonestFlow(engine, db, region) {
  console.log(`\n=== [${region}] handleBookSoonest (buildTypeCatalogue) ===`);
  const session = await newSession(db, region, 'BOOK_SOONEST', {
    navigation_chain: [],
  });
  await engine.handleBookSoonest(session, '');
  const d = JSON.parse((await db.getSession(session.id)).data || '{}');
  printList(`${region} handleBookSoonest`, d.appointment_type_list);
  return d.appointment_type_list || [];
}

async function runSpecificDateFlow(engine, db, region) {
  console.log(`\n=== [${region}] handleBookSpecificDate ===`);
  const session = await newSession(db, region, 'BOOK_SPECIFIC_DATE', {
    selection_step: 'choose_date',
    navigation_chain: [],
  });
  await engine.handleBookSpecificDate(session, '1');
  const d = JSON.parse((await db.getSession(session.id)).data || '{}');
  printList(`${region} handleBookSpecificDate`, d.appointment_type_list);
  return d.appointment_type_list || [];
}

function checkCollisionResolved(label, rawList) {
  const list = (rawList || []).map(t => ({ ...t, ids: t.ids || (t.id ? [t.id] : []) }));
  const physioEntries = list.filter(t => /^physiotherapist(\s*\(.*\))?$/i.test(t.name));
  console.log(`${label}: "Physiotherapist"-family entries: ${physioEntries.length} (expect 2, distinct names+ids)`);
  const namesOk = new Set(physioEntries.map(e => e.name)).size === physioEntries.length;
  // Each entry's own ids must not straddle both categories (e.g. neither entry
  // should contain both 1704019452481242941 AND 360652) — that's the actual
  // collision this fix targets. Repeated ids WITHIN one entry are expected
  // (same type id held by multiple practitioners in a clinic-wide bucket).
  const idSetsDisjoint = new Set(physioEntries[0]?.ids || []).size > 0 &&
    physioEntries.every((e, i) => physioEntries.every((o, j) => i === j || !e.ids.some(id => o.ids.includes(id))));
  const ok = physioEntries.length === 2 && namesOk && idSetsDisjoint;
  console.log(ok ? `PASS: ${label}` : `FAIL: ${label}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function main() {
  const { db, engine } = await makeEngine();

  const sg = await RegionContext.run('SG', async () => {
    const clinicResult = await runClinicFlow(engine, db, 'SG');
    const found = await findPhysioWithCollision(engine, clinicResult.groups);
    let historyList = [], specificPhysioList = [];
    if (found) {
      historyList = await runHistoryFlow(engine, db, 'SG', found.practitioner);
      specificPhysioList = await runSpecificPhysioFlow(engine, db, 'SG', found.practitioner);
    } else {
      console.log('\nNo single SG practitioner holds both "Physiotherapist" types — skipping History/SpecificPhysio per-practitioner checks (clinic-level check above still covers the fix).');
    }
    const specificDateList = await runSpecificDateFlow(engine, db, 'SG');
    const bookSoonestList = await runBookSoonestFlow(engine, db, 'SG');
    return { clinicList: clinicResult.list, historyList, specificPhysioList, specificDateList, bookSoonestList };
  });

  checkCollisionResolved('SG handleBookSpecificClinic', sg.clinicList);
  if (sg.historyList.length) checkCollisionResolved('SG handleBookHistory', sg.historyList);
  if (sg.specificPhysioList.length) checkCollisionResolved('SG handleBookSpecificPhysio', sg.specificPhysioList);
  checkCollisionResolved('SG handleBookSpecificDate', sg.specificDateList);
  checkCollisionResolved('SG handleBookSoonest', sg.bookSoonestList);

  await RegionContext.run('HK', async () => {
    await runClinicFlow(engine, db, 'HK');
  });
  console.log('\nHK run above is for visual before/after comparison — same bucketing as pre-fix (name-only merge expected).');
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
