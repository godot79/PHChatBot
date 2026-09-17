// Read-only Cliniko check: SG practitioners + their appointment types (name, price, duration).
// Uses existing ClinikoAPI methods only — no new endpoints, no guessing at field shapes.
// Scratch/manual script — not part of the Jest suite.
require('dotenv').config();
const RegionContext = require('../../src/core/RegionContext');
const ClinikoAPI = require('../../src/api/ClinikoAPI');

async function main() {
  await RegionContext.run('SG', async () => {
    const api = new ClinikoAPI();
    const groups = await api.getPractitionersByClinic();
    if (groups._partial) console.error('WARNING: partial result from getPractitionersByClinic');

    for (const clinic of groups) {
      console.log(`\n=== Clinic: ${clinic.clinic_name} (${clinic.clinic_id}) ===`);
      for (const p of clinic.practitioners) {
        console.log(`\n--- Practitioner: ${p.first_name || ''} ${p.last_name || ''} (id=${p.id}) ---`);
        const types = await api.getAppointmentTypes({ practitioner_id: p.id });
        if (types._partial) console.error('  WARNING: partial appt-type result for this practitioner');
        for (const t of types) {
          console.log(`  - id=${t.id} name="${t.name}" billable_item_code=${t.billable_item_code} category="${t.category || ''}" duration=${t.duration_in_minutes}min`);
        }
      }
    }
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
