// Read-only Cliniko check across all 4 regions: does the "<name>-<own
// service>" duplicate-type pattern (found live in HK, 2026-10-15 — e.g.
// "Follow-Up Appointment-Physiotherapy" alongside a bare "Follow-Up
// Appointment") exist anywhere else? Uses the actual fix's own detection
// method (_serviceSuffixDuplicateBaseNames) against each region's real,
// clinic-wide raw type list, so this exercises the real logic, not a
// re-implementation of it.
require('dotenv').config();
const RegionContext = require('../../src/core/RegionContext');
const ClinikoAPI = require('../../src/api/ClinikoAPI');
const ChatbotEngine = require('../../src/core/ChatbotEngine');
const { getAllAppointmentTypesForAllPractitioners } = require('../../src/core/_appointmentTypeHelpers.js');

const engine = Object.create(ChatbotEngine.prototype);

async function checkRegion(region) {
  console.log(`\n=== Region: ${region} ===`);
  await RegionContext.run(region, async () => {
    const api = new ClinikoAPI();
    const groups = await api.getPractitionersByClinic();
    if (groups._partial) console.error('  WARNING: partial result from getPractitionersByClinic');
    const allTypes = await getAllAppointmentTypesForAllPractitioners(api, groups);
    console.log(`  ${allTypes.length} raw type-records fetched across all practitioners/clinics.`);
    const dupes = engine._serviceSuffixDuplicateBaseNames(allTypes);
    if (dupes.size === 0) {
      console.log('  No "<name>-<own service>" duplicate pattern found.');
      return;
    }
    console.log(`  Found ${dupes.size} distinct suffixed name(s) that will now merge into a sibling bucket:`);
    for (const [suffixedNorm, baseName] of dupes.entries()) {
      console.log(`    "${suffixedNorm}" -> merges into "${baseName}"`);
    }
  });
}

async function main() {
  for (const region of ['HK', 'SG', 'PH', 'IN']) {
    try {
      await checkRegion(region);
    } catch (e) {
      console.error(`  ERROR checking ${region}:`, e.message);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
