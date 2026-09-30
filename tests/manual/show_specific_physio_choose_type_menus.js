// Read-only live walkthrough: shows the real choose_type menu rendered by
// handleBookSpecificPhysio for several real SG physios, so the actual
// appointment-type list a patient would see can be visually checked after
// the tier-merge naming fix (feature/sg-physio-tier-funnel).
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

async function showMenuForPhysio(db, engine, physio) {
  console.log(`\n=== choose_type for ${physio.first_name} ${physio.last_name} (id=${physio.id}) ===`);
  const session = await newSession(db, 'SG', 'BOOK_SPECIFIC_PHYSIO', {
    selection_step: 'choose_type',
    selected_physio: physio,
    navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
  });
  const reply = await engine.handleBookSpecificPhysio(session, '');
  console.log(String(reply));
  const d = JSON.parse((await db.getSession(session.id)).data || '{}');
  console.log('\nStored appointment_type_list:');
  console.log(JSON.stringify((d.appointment_type_list || []).map(t => ({ name: t.name, ids: t.ids })), null, 2));
}

async function main() {
  const { db, engine } = await makeEngine();
  await RegionContext.run('SG', async () => {
    const groups = await engine.clinikoAPI.getPractitionersByClinic();
    const allPrac = groups.flatMap(g => g.practitioners);
    const byName = (first) => allPrac.find(p => p.first_name.startsWith(first));

    // Jade: standard-tier physio, also does Sports Massage.
    await showMenuForPhysio(db, engine, byName('Jade'));
    // Chris: senior-tier physio, also does Sports Massage.
    await showMenuForPhysio(db, engine, byName('Chris'));
    // Sarah: senior-tier only (no Sports Massage).
    await showMenuForPhysio(db, engine, byName('Sarah'));
    // Teck: senior-tier physio, also does Paediatrics.
    await showMenuForPhysio(db, engine, byName('Teck'));
  });
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
