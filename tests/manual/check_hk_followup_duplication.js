// Read-only Cliniko check: for the two near-duplicate self-pay "Follow-Up Appointment"
// / "Follow-Up Appointment-Physiotherapy" types reported by the user as a confusing
// duplicate menu entry (both bucket to service=Physiotherapy, duration=40, both have
// null-insurer/self-pay ids per today's staging logs), find out per-practitioner:
// does any practitioner hold ONLY the "-Physiotherapy" variant (which would be lost
// if the two were merged), or does every holder of one also hold the other?
require('dotenv').config();
const RegionContext = require('../../src/core/RegionContext');
const ClinikoAPI = require('../../src/api/ClinikoAPI');
const { normalizeTypeName } = require('../../src/core/_slotHelpers.js');

function normName(s) {
  return typeof normalizeTypeName === 'function'
    ? normalizeTypeName(s)
    : String(s || '').toLowerCase().trim();
}

const BARE = 'follow up appointment';
const SUFFIXED = 'follow up appointment physiotherapy';

async function main() {
  await RegionContext.run('HK', async () => {
    const api = new ClinikoAPI();
    const groups = await api.getPractitionersByClinic();
    if (groups._partial) console.error('WARNING: partial result from getPractitionersByClinic');

    const bareHolders = new Map(); // name -> { ids:Set, insurer:Set }
    const suffixedHolders = new Map();

    for (const clinic of groups) {
      for (const p of clinic.practitioners) {
        const types = await api.getAppointmentTypes({ practitioner_id: p.id });
        if (types._partial) console.error(`  WARNING: partial for ${p.first_name} ${p.last_name}`);
        const pname = `${p.first_name} ${p.last_name} (${clinic.clinic_name})`;
        for (const t of types || []) {
          if (!t || !t.name) continue;
          const n = normName(t.name);
          if (n === BARE) {
            if (!bareHolders.has(pname)) bareHolders.set(pname, new Set());
            bareHolders.get(pname).add(`${t.id}:${t.category || '(none)'}:${t.duration_in_minutes}min`);
          } else if (n === SUFFIXED) {
            if (!suffixedHolders.has(pname)) suffixedHolders.set(pname, new Set());
            suffixedHolders.get(pname).add(`${t.id}:${t.category || '(none)'}:${t.duration_in_minutes}min`);
          }
        }
      }
    }

    console.log('\n=== Practitioners holding "Follow-Up Appointment" (bare) ===');
    for (const [name, ids] of bareHolders.entries()) console.log(`  ${name}: ${[...ids].join(', ')}`);

    console.log('\n=== Practitioners holding "Follow-Up Appointment-Physiotherapy" (suffixed) ===');
    for (const [name, ids] of suffixedHolders.entries()) console.log(`  ${name}: ${[...ids].join(', ')}`);

    const bareOnly = [...bareHolders.keys()].filter((n) => !suffixedHolders.has(n));
    const suffixedOnly = [...suffixedHolders.keys()].filter((n) => !bareHolders.has(n));
    const both = [...bareHolders.keys()].filter((n) => suffixedHolders.has(n));

    console.log('\n=== Summary ===');
    console.log(`Holds ONLY "Follow-Up Appointment" (bare): ${bareOnly.length ? bareOnly.join(', ') : '(none)'}`);
    console.log(`Holds ONLY "Follow-Up Appointment-Physiotherapy" (suffixed): ${suffixedOnly.length ? suffixedOnly.join(', ') : '(none)'}`);
    console.log(`Holds BOTH: ${both.length ? both.join(', ') : '(none)'}`);
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
