#!/usr/bin/env node
/**
 * Compare FUTURE vs PAST appointment fetches for a patient using your ClinikoAPI.
 * Uses ONLY your API wrapper and RegionContext.
 *
 * Run:
 *   node tests/history_fetch_compare.test.js 1742966053526308825 SG
 */

let ClinikoAPI;
try { ClinikoAPI = require('../src/api/ClinikoAPI'); } catch (_) {}
try { if (!ClinikoAPI) ClinikoAPI = require('../ClinikoAPI'); } catch (_) {}
try { if (!ClinikoAPI) ClinikoAPI = require('./ClinikoAPI'); } catch (_) {}
if (!ClinikoAPI) {
  console.error('Unable to require ClinikoAPI. Adjust path.');
  process.exit(1);
}

let RegionContext;
try { RegionContext = require('../src/core/RegionContext'); } catch (_) {}
try { if (!RegionContext) RegionContext = require('../core/RegionContext'); } catch (_) {}
try { if (!RegionContext) RegionContext = require('./RegionContext'); } catch (_) {}
if (!RegionContext) {
  console.error('Unable to require RegionContext. Adjust path.');
  process.exit(1);
}

const cliniko = (typeof ClinikoAPI === 'function') ? new ClinikoAPI() : ClinikoAPI;

const PATIENT_ID = (process.argv[2] || '1742966053526308825').trim();
const REGION = String(process.argv[3] || 'SG').toUpperCase();

const nowISO = new Date().toISOString();
const fmt = (s) => new Date(s).toISOString();
const log = (...a) => console.log(new Date().toTimeString().slice(0,8), ...a);

(async () => {
  await RegionContext.run(REGION, async () => {
    log('▶ Region =', REGION, '| Patient =', PATIENT_ID);

    const future = await cliniko.getBookingsByPatientId(PATIENT_ID, { when: 'future' });
    const past   = await cliniko.getBookingsByPatientId(PATIENT_ID, { when: 'past'   });

    log('Now =', nowISO);
    log('FUTURE count =', future.length);
    if (future[0]) {
      const first = [...future].sort((a,b)=> new Date(a.starts_at) - new Date(b.starts_at))[0];
      log('  earliest future starts_at =', fmt(first.starts_at));
    }

    log('PAST   count =', past.length);
    if (past[0]) {
      const latestPast = [...past].sort((a,b)=> new Date(b.starts_at) - new Date(a.starts_at))[0];
      log('  latest past starts_at     =', fmt(latestPast.starts_at));
    }

    // Preview a few from each set
    const preview = (arr, label, take, sortFn) => {
      console.log(`\n=== ${label} (up to ${take}) ===`);
      arr.sort(sortFn).slice(0, take).forEach((a, i) => {
        console.log(`${i+1}. id=${a.id} | starts_at=${fmt(a.starts_at)} | type=${a.appointment_type_name || a.appointment_type?.name || 'n/a'} | practitioner=${a.practitioner_name || a.practitioner?.name || a.practitioner_id}`);
      });
    };

    preview(future, 'Future', 5, (a,b)=> new Date(a.starts_at) - new Date(b.starts_at));
    preview(past,   'Past',   5, (a,b)=> new Date(b.starts_at) - new Date(a.starts_at));

    if (!future.length && !past.length) {
      console.log('\nNo appointments returned by Cliniko for this patient/region.');
      console.log('Confirm patient_id is valid for region and API key.');
    }
  });
})().catch(e => {
  console.error('Test failed:', e?.response?.data || e?.message || e);
  process.exit(1);
});

