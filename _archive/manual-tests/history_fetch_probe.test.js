#!/usr/bin/env node
/**
 * Probe: what appointments does ClinikoAPI.getBookingsByPatientId() return?
 *
 * Usage:
 *   node tests/history_fetch_probe.test.js [patientId]
 *
 * Notes:
 * - Uses ONLY your existing ClinikoAPI wrapper.
 * - Prints how many returned items are in the past vs future, and previews a few.
 * - Use this to confirm current behaviour before changing the API method to support past appointments.
 */

// Try to load ClinikoAPI from common project layouts
let ClinikoAPI;
try { ClinikoAPI = require('../src/api/ClinikoAPI'); } catch (_) {}
try { if (!ClinikoAPI) ClinikoAPI = require('../ClinikoAPI'); } catch (_) {}
try { if (!ClinikoAPI) ClinikoAPI = require('./ClinikoAPI'); } catch (_) {}
if (!ClinikoAPI) {
  console.error('Unable to require ClinikoAPI. Adjust the require path to your project.');
  process.exit(1);
}

// If module exports a class, instantiate; if it exports an instance, use it as-is
const cliniko = (typeof ClinikoAPI === 'function') ? new ClinikoAPI() : ClinikoAPI;

const PATIENT_ID = (process.argv[2] || '1742966053526308825').trim();

const nowISO = new Date().toISOString();
const now = new Date(nowISO);
const fmt = (s) => new Date(s).toISOString();
const log = (...a) => console.log(new Date().toTimeString().slice(0,8), ...a);

(async () => {
  log('▶ History fetch probe for patient:', PATIENT_ID);
  const items = await cliniko.getBookingsByPatientId(PATIENT_ID);

  if (!Array.isArray(items)) {
    console.error('getBookingsByPatientId did not return an array. Got:', typeof items);
    process.exit(1);
  }

  log('Total returned:', items.length);
  if (items.length === 0) {
    console.log('No appointments returned. Check credentials/region or patient id.');
    process.exit(0);
  }

  // Partition into past vs future by starts_at
  const past = [];
  const future = [];
  for (const a of items) {
    const t = new Date(a.starts_at);
    if (isNaN(+t)) continue;
    (t < now ? past : future).push(a);
  }

  const asc = [...items].sort((a,b) => new Date(a.starts_at) - new Date(b.starts_at));
  const desc = [...items].sort((a,b) => new Date(b.starts_at) - new Date(a.starts_at));

  log('Past count:', past.length, '| Future count:', future.length, '| Now:', nowISO);
  log('Earliest starts_at:', fmt(asc[0].starts_at));
  log('Latest   starts_at:', fmt(desc[0].starts_at));

  const preview = (arr, label) => {
    console.log(`\n=== ${label} (up to 5) ===`);
    arr.slice(0,5).forEach((a, i) => {
      console.log(`${i+1}. id=${a.id} | starts_at=${fmt(a.starts_at)} | type=${a.appointment_type_name || a.appointment_type?.name || 'n/a'} | practitioner=${a.practitioner_name || a.practitioner?.name || a.practitioner_id}`);
    });
  };

  preview(past.sort((a,b)=>new Date(b.starts_at)-new Date(a.starts_at)), 'Past');
  preview(future.sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at)), 'Future');

  console.log('\nRecommendation: to fetch past appointments only, pass a starts_at upper bound');
  console.log('e.g. q[] = `starts_at:<', nowISO, '` along with q[]=patient_id:=', PATIENT_ID, ' and sort=starts_at:desc');
  console.log('See the modified function canvas for a drop-in update.');
})();

