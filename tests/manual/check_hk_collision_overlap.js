// Read-only Cliniko check: for each HK clinic, does the "New Patient"/"Follow Up
// Appointment" name collision actually mix practitioners across DIFFERENT
// categories at the SAME clinic (the mechanism that would make choose_physio's
// merged-id filter visibly wrong)? Uses existing ClinikoAPI methods only.
require('dotenv').config();
const RegionContext = require('../../src/core/RegionContext');
const ClinikoAPI = require('../../src/api/ClinikoAPI');
const { normalizeTypeName } = require('../../src/core/_slotHelpers.js');

function normName(s) {
  return typeof normalizeTypeName === 'function'
    ? normalizeTypeName(s)
    : String(s || '').toLowerCase().trim();
}

const COLLIDING_NAMES = new Set(['new patient', 'follow up appointment']);

async function main() {
  await RegionContext.run('HK', async () => {
    const api = new ClinikoAPI();
    const groups = await api.getPractitionersByClinic();
    if (groups._partial) console.error('WARNING: partial result from getPractitionersByClinic');

    for (const clinic of groups) {
      console.log(`\n=== Clinic: ${clinic.clinic_name} ===`);
      // norm_name -> category -> [practitioner names]
      const map = new Map();
      for (const p of clinic.practitioners) {
        const types = await api.getAppointmentTypes({ practitioner_id: p.id });
        if (types._partial) console.error(`  WARNING: partial for ${p.first_name} ${p.last_name}`);
        for (const t of types || []) {
          if (!t || !t.name) continue;
          const n = normName(t.name);
          if (!COLLIDING_NAMES.has(n)) continue;
          const cat = t.category || '(none)';
          if (!map.has(n)) map.set(n, new Map());
          const catMap = map.get(n);
          if (!catMap.has(cat)) catMap.set(cat, new Set());
          catMap.get(cat).add(`${p.first_name} ${p.last_name}`);
        }
      }
      for (const [n, catMap] of map.entries()) {
        if (catMap.size <= 1) continue; // no cross-category collision at this clinic for this name
        console.log(`  "${n}" spans ${catMap.size} categories AT THIS CLINIC:`);
        for (const [cat, names] of catMap.entries()) {
          console.log(`    ${cat}: ${[...names].join(', ')}`);
        }
      }
      if ([...map.values()].every(catMap => catMap.size <= 1)) {
        console.log('  No cross-category collision at this clinic for New Patient/Follow Up Appointment.');
      }
    }
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
