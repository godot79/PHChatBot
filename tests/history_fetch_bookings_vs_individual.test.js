#!/usr/bin/env node
/**
 * Probe past appointments using BOTH endpoints:
 *  - /individual_appointments with q[]=patient_id and q[]=cancelled_at:?
 *  - /bookings with q[]=patient_ids:~ and q[]=cancelled_at:?
 * Also verifies q[] passed in URL vs axios params.
 *
 * Usage:
 *   node tests/history_fetch_bookings_vs_individual.test.js <PATIENT_ID> [DAYS_BACK]
 *
 * Env:
 *   CLINIKO_API_KEY must be set. Base URL is taken from your SendMessage helper.
 */

const util = require('util');

// --- Load your app HTTP helper (keeps headers consistent) ---
let SendMessage;
try { SendMessage = require('../src/api/SendMessage'); } catch (_) {}
try { if (!SendMessage) SendMessage = require('../SendMessage'); } catch (_) {}
try { if (!SendMessage) SendMessage = require('./SendMessage'); } catch (_) {}
if (!SendMessage) {
  console.error('Unable to require SendMessage. Adjust the require path to your project.');
  process.exit(1);
}

const args = process.argv.slice(2);
const patientId = (args[0] || '').trim();
const daysBack = Math.max(parseInt(args[1] || '30', 10), 1);

if (!patientId) {
  console.error('Usage: node tests/history_fetch_bookings_vs_individual.test.js <PATIENT_ID> [DAYS_BACK]');
  process.exit(1);
}

const now = new Date();
const toISO = now.toISOString();
const from = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
const fromISO = from.toISOString();

const log = (...a) => console.log(new Date().toTimeString().slice(0,8), ...a);

function sampleRows(rows, n = 3) {
  return (rows || []).slice(0, n).map(r => ({
    id: r.id,
    starts_at: r.starts_at || r.appointment_start,
    cancelled_at: r.cancelled_at || null,
    patient_name: r.patient_name || undefined,
    practitioner: r.practitioner?.links?.self || undefined,
    appointment_type: r.appointment_type?.links?.self || undefined,
  }));
}

(async () => {
  log(`▶ Patient = ${patientId} | Window = ${daysBack} days (from ${fromISO} to < ${toISO})`);

  // ---------- Variant A: individual_appointments (URL q[]) ----------
  const urlA = `/individual_appointments?q[]=${encodeURIComponent(`patient_id:=${patientId}`)}&q[]=${encodeURIComponent(`starts_at:>=${fromISO}`)}&q[]=${encodeURIComponent(`starts_at:<${toISO}`)}&q[]=${encodeURIComponent('cancelled_at:?')}&sort=starts_at:desc&per_page=100`;
  const resA = await new SendMessage(urlA, {}).get();
  const A = resA.individual_appointments || [];
  log(`A) individual_appointments (URL q[]) => ${A.length}`);
  if (A.length) console.log(util.inspect(sampleRows(A), { depth: 4, colors: true }));

  // ---------- Variant B: individual_appointments (params q[]) ----------
  const paramsB = { 'q[]': [
    `patient_id:=${patientId}`,
    `starts_at:>=${fromISO}`,
    `starts_at:<${toISO}`,
    'cancelled_at:?'
  ], sort: 'starts_at:desc', per_page: 100 };
  const resB = await new SendMessage('/individual_appointments', paramsB).get();
  const B = resB.individual_appointments || [];
  log(`B) individual_appointments (params q[]) => ${B.length}`);
  if (B.length) console.log(util.inspect(sampleRows(B), { depth: 4, colors: true }));

  // ---------- Variant C: bookings (URL q[]) using patient_ids:~ (array contains) ----------
  const urlC = `/bookings?q[]=${encodeURIComponent(`patient_ids:~${patientId}`)}&q[]=${encodeURIComponent(`starts_at:>=${fromISO}`)}&q[]=${encodeURIComponent(`starts_at:<${toISO}`)}&q[]=${encodeURIComponent('cancelled_at:?')}&sort=starts_at:desc&per_page=100`;
  const resC = await new SendMessage(urlC, {}).get();
  const C = resC.bookings || [];
  log(`C) bookings (URL q[]) => ${C.length}`);
  if (C.length) console.log(util.inspect(sampleRows(C), { depth: 4, colors: true }));

  // ---------- Variant D: bookings (params q[]) ----------
  const paramsD = { 'q[]': [
    `patient_ids:~${patientId}`,
    `starts_at:>=${fromISO}`,
    `starts_at:<${toISO}`,
    'cancelled_at:?'
  ], sort: 'starts_at:desc', per_page: 100 };
  const resD = await new SendMessage('/bookings', paramsD).get();
  const D = resD.bookings || [];
  log(`D) bookings (params q[]) => ${D.length}`);
  if (D.length) console.log(util.inspect(sampleRows(D), { depth: 4, colors: true }));

  // Summary
  console.log('\n=== Summary ===');
  console.log('A individual_appointments URL   :', A.length);
  console.log('B individual_appointments params:', B.length);
  console.log('C bookings URL                  :', C.length);
  console.log('D bookings params               :', D.length);

  if (!A.length && !B.length && !C.length && !D.length) {
    console.log('\nNo appointments returned by Cliniko.');
    console.log('• Verify CLINIKO_API_KEY and shard.');
    console.log('• Confirm patient_id is valid for this account.');
    console.log('• Increase DAYS_BACK.');
  }
})().catch(err => {
  console.error('Probe failed:', err?.error || err?.response?.data || err?.message || err);
  process.exit(1);
});

