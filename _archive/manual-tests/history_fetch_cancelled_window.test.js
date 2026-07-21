#!/usr/bin/env node
/**
 * Compare cancelled past appointments over a configurable window.
 * Uses ONLY your ClinikoAPI and RegionContext.
 *
 * Run:
 *   node tests/history_fetch_cancelled_window.test.js 1742966053526308825 SG 30
 *     ^patient_id                                   ^region ^days_back
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
const DAYS = Math.max(1, parseInt(process.argv[4] || '30', 10));

const now = new Date();
const beforeISO = now.toISOString();
const afterISO  = new Date(now.getTime() - DAYS*24*60*60*1000).toISOString();

const fmt = (s) => new Date(s).toISOString();
const log = (...a) => console.log(new Date().toTimeString().slice(0,8), ...a);

(async () => {
  await RegionContext.run(REGION, async () => {
    log('▶ Region =', REGION, '| Patient =', PATIENT_ID, '| Window days =', DAYS);

    const cancelled = await cliniko.getBookingsByPatientId(PATIENT_ID, {
      when: 'past',
      beforeISO,
      afterISO,
      status: 'cancelled',
      perPage: 50,
    });

    log('Cancelled count =', cancelled.length);

    if (!cancelled.length) {
      console.log('No cancelled appointments in window. Try larger day window or check region/patient.');
      return;
    }

    const sorted = cancelled.sort((a,b) => new Date(b.starts_at) - new Date(a.starts_at));

    console.log('\n=== Cancelled (latest first, up to 10) ===');
    sorted.slice(0,10).forEach((a, i) => {
      const type = a.appointment_type_name || a.appointment_type?.name || 'n/a';
      const prac = a.practitioner_name || a.practitioner?.name || a.practitioner_id;
      const biz  = a.business_name || a.business?.name || a.business_id;
      console.log(`${i+1}. id=${a.id} | starts_at=${fmt(a.starts_at)} | status=${a.status || 'n/a'} | type=${type} | practitioner=${prac} | business=${biz}`);
    });
  });
})().catch(e => {
  console.error('Test failed:', e?.response?.data || e?.message || e);
  process.exit(1);
});

