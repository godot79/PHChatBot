/**
 * File: test/verify-appointment-type-category.via-your-api.test.js
 *
 * Purpose:
 * - Verify AppointmentType.category is retrievable via YOUR ClinikoAPI wrapper
 *   and can be printed as "Name (Category)" when present.
 *
 * Usage:
 *   node test/verify-appointment-type-category.via-your-api.test.js <id1> [id2 ...]
 *
 * Notes:
 * - This test ONLY uses your exported API: ClinikoAPI.getAppointmentTypeById.
 * - No direct HTTP calls, no extra endpoints, no dummy resource IDs.
 */

const path = require('path');
const ClinikoAPI = require(path.join(__dirname, '..', 'src', 'api', 'ClinikoAPI.js'));

// Same display rule we’ll apply in production: Name (Category) if category exists
function formatAppointmentTypeDisplay(apptType) {
  if (!apptType) return 'Appointment';
  const name = apptType.name || 'Appointment';
  const cat = apptType.category ? String(apptType.category).trim() : '';
  return (cat && cat.toLowerCase() !== String(name).toLowerCase())
    ? `${name} (${cat})`
    : name;
}

async function main() {
  const ids = process.argv.slice(2).filter(Boolean);
  if (ids.length === 0) {
    console.error('Usage: node test/verify-appointment-type-category.via-your-api.test.js <id1> [id2 ...]');
    process.exit(1);
  }

  const api = new ClinikoAPI();

  for (const id of ids) {
    try {
      // Solely via your wrapper
      const apptType = await api.getAppointmentTypeById(String(id));
      if (!apptType) {
        console.error(`#${id}: Not found (via ClinikoAPI)`);
        continue;
      }

      // Show what we’ll print in-app
      const display = formatAppointmentTypeDisplay(apptType);

      // Output proves category came from the wrapped API call
      console.log(`#${id} -> ${display}`);
      console.log(`   raw.name     = ${apptType.name || ''}`);
      console.log(`   raw.category = ${apptType.category || ''}`);
      console.log(`   raw.duration = ${apptType.duration_in_minutes ?? ''}`);
      console.log(`   raw.color    = ${apptType.color || ''}`);
    } catch (e) {
      const msg = e?.response?.status || e?.message || String(e);
      console.error(`#${id}: ERROR`, msg);
    }
  }

  console.log('Done.');
}

main();
