// Read-only Cliniko check: does HK have the same appointment-type name-collision
// pattern found in SG (same normalized name, different category)? Uses existing
// ClinikoAPI methods only — no new endpoints, no guessing at field shapes.
require('dotenv').config();
const RegionContext = require('../../src/core/RegionContext');
const ClinikoAPI = require('../../src/api/ClinikoAPI');
const { normalizeTypeName } = require('../../src/core/_slotHelpers.js');

function normName(s) {
  return typeof normalizeTypeName === 'function'
    ? normalizeTypeName(s)
    : String(s || '').toLowerCase().trim();
}

async function main() {
  await RegionContext.run('HK', async () => {
    const api = new ClinikoAPI();
    const groups = await api.getPractitionersByClinic();
    if (groups._partial) console.error('WARNING: partial result from getPractitionersByClinic');

    // norm_name -> Set(category)
    const nameToCategories = new Map();
    // norm_name -> Set(id) to also confirm ID-level collision (not just category)
    const nameToIds = new Map();
    let practitionerCount = 0;

    for (const clinic of groups) {
      for (const p of clinic.practitioners) {
        practitionerCount++;
        const types = await api.getAppointmentTypes({ practitioner_id: p.id });
        if (types._partial) console.error(`  WARNING: partial appt-type result for practitioner ${p.id}`);
        for (const t of types || []) {
          if (!t || !t.name) continue;
          const n = normName(t.name);
          if (!nameToCategories.has(n)) nameToCategories.set(n, new Set());
          nameToCategories.get(n).add(t.category || '(none)');
          if (!nameToIds.has(n)) nameToIds.set(n, new Set());
          nameToIds.get(n).add(String(t.id));
        }
      }
    }

    console.log(`\nChecked ${practitionerCount} practitioners across ${groups.length} clinic(s).\n`);
    console.log('=== Type names that map to MORE THAN ONE category (collision candidates) ===');
    let collisions = 0;
    for (const [n, cats] of nameToCategories.entries()) {
      if (cats.size > 1) {
        collisions++;
        console.log(`  "${n}" -> categories: ${[...cats].join(' | ')} (ids: ${[...nameToIds.get(n)].join(', ')})`);
      }
    }
    if (!collisions) console.log('  none found');
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
