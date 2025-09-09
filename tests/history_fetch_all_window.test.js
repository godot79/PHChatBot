#!/usr/bin/env node
/**
 * Patient history probe across a window, ALL statuses.
 * Uses ONLY your ClinikoAPI wrapper (no direct axios).
 *
 * Run:
 *   node tests/history_fetch_all_window.test.js 1742966053526308825 60
 */

let ClinikoAPI;
try { ClinikoAPI = require('../src/api/ClinikoAPI'); } catch (_) {}
try { if (!ClinikoAPI) ClinikoAPI = require('../ClinikoAPI'); } catch (_) {}
try { if (!ClinikoAPI) ClinikoAPI = require('./ClinikoAPI'); } catch (_) {}
if (!ClinikoAPI) {
  console.error('Unable to require ClinikoAPI. Adjust path.');
  process.exit(1);
}

const cliniko = (typeof ClinikoAPI === 'function') ? new ClinikoAPI() : ClinikoAPI;

const patientId = (process.argv[2] || '').trim();
const days = Math.max(parseInt(process.argv[3] || '60', 10), 1);
if (!patientId) {
  console.error('Usage: node tests/history_fetch_all_window.test.js <PATIENT_ID> [DAYS_BACK]');
  process.exit(1);
}

const now = new Date();
const toISO = now.toISOString();
const fromISO = new Date(now.getTime() - days*24*60*60*1000).toISOString();
const fmt = (s) => new Date(s).toISOString();
const log = (...a) => console.log(new Date().toTimeString().slice(0,8), ...a);

(async () => {
  log('▶ Patient =', patientId, '| Window =', days, 'days');

  const past = await cliniko.getBookingsByPatientId(patientId, {
    when: 'past',
    fromISO,
    toISO,
    perPage: 100,
  });

  log('Count =', past.length);
  if (!past.length) {
    console.log('No appointments in window. Try increasing DAYS_BACK or check region/patient.');
    return;
  }

  const show = past.slice(0, 10);
  console.log('\n=== Latest past (up to 10) ===');
  show.forEach((a, i) => {
    const type = a.appointment_type_name || a.appointment_type?.name || 'n/a';
    const prac = a.practitioner_name || a.practitioner?.name || a.practitioner_id;
    const biz  = a.business_name || a.business?.name || a.business_id;
    console.log(`${i+1}. id=${a.id} | starts_at=${fmt(a.starts_at)} | cancelled_at=${a.cancelled_at || '—'} | type=${type} | practitioner=${prac} | business=${biz}`);
  });
})();

