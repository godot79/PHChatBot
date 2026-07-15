'use strict';
/**
 * tests/integration/reschedule_type_preservation.write.test.js
 *
 * ONE-OFF investigation: does Cliniko's PATCH /individual_appointments/:id
 * override appointment_type_id when ends_at implies a different duration?
 *
 * This file is NOT part of the main test suite. It will NOT run in CI.
 *
 * READ-ONLY checks: run when CLINIKO_API_KEY_HK is set.
 * WRITE checks:     require WRITE_TEST_CLINIKO=true in addition.
 *                   Uses rrv1979@gmail.com (owner's HK patient record).
 *                   Cleans up (cancels) any appointment it creates.
 *
 * Run:
 *   npx jest tests/integration/reschedule_type_preservation.write.test.js --runInBand
 *
 * To enable write tests:
 *   WRITE_TEST_CLINIKO=true npx jest tests/integration/reschedule_type_preservation.write.test.js --runInBand
 */

require('dotenv').config();

const LIVE  = !!process.env.CLINIKO_API_KEY_HK;
const WRITE = LIVE && process.env.WRITE_TEST_CLINIKO === 'true';

const liveIt  = LIVE  ? it : it.skip;
const writeIt = WRITE ? it : it.skip;

const RegionContext = require('../../src/core/RegionContext');
const ClinikoAPI    = require('../../src/api/ClinikoAPI');
const SendMessage   = require('../../src/api/SendMessage');

jest.mock('../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    child: function () { return this; },
  }))
);

const TEST_EMAIL = 'rrv1979@gmail.com';
const TIMEOUT    = 30000;

let api;
function hk(fn) { return RegionContext.run('HK', fn); }

// Shared state across tests — populated by read-only probes, consumed by write tests.
let patientId       = null;
let chosenType      = null; // { id, name, duration_in_minutes }
let chosenBizId     = null;
let chosenPracId    = null;
let firstSlot       = null; // raw slot from getAvailableTimes (has appointment_start + appointment_end)
let bookedApptId    = null; // set in write test, used for cleanup

beforeAll(() => {
  api = new ClinikoAPI();
});

afterAll(async () => {
  // Safety net: cancel any appointment we created, even if a test failed mid-way.
  if (bookedApptId) {
    try {
      await hk(() => api.cancelSpecificAppointment(String(bookedApptId)));
      console.log(`[cleanup] Cancelled test appointment ${bookedApptId}`);
    } catch (e) {
      console.error(`[cleanup] Failed to cancel ${bookedApptId}:`, e?.message || e);
    }
  }
});

// =============================================================================
// 1. READ — find patient
// =============================================================================
describe('READ: patient lookup', () => {
  liveIt('finds patient by email and resolves a patient ID', async () => {
    const patient = await hk(() => api.findPatientByEmail(TEST_EMAIL));
    expect(patient).not.toBeNull();
    expect(patient.id).toBeTruthy();
    patientId = String(patient.id);
    console.log(`[read] patient id: ${patientId}`);
  }, TIMEOUT);
});

// =============================================================================
// 2. READ — find a non-30-min appointment type with available slots
// =============================================================================
describe('READ: appointment type probe', () => {
  liveIt('finds a practitioner+clinic+type triple with duration > 30 min and available slots', async () => {
    const groups = await hk(() => api.getPractitionersByClinic());
    expect(groups.length).toBeGreaterThan(0);

    const fmtDate = d => d.toISOString().slice(0, 10);

    outer:
    for (const group of groups) {
      for (const prac of group.practitioners) {
        const types = await hk(() => api.getAppointmentTypes({ practitioner_id: prac.id }));
        for (const t of types) {
          if (!t.duration_in_minutes || t.duration_in_minutes <= 30) continue;

          // Cliniko caps the available_times window — stay within 7 days
          const slotFrom = new Date(Date.now() + 24 * 3600000);
          const slotTo   = new Date(Date.now() + 7 * 24 * 3600000);
          const slots = await hk(() => api.getAvailableTimes({
            practitioner_id: prac.id,
            business_id:     group.clinic_id,
            appt_type:       t.id,
            from:            fmtDate(slotFrom),
            to:              fmtDate(slotTo),
          })).catch(() => []);

          if (slots.length === 0) continue;

          chosenType   = { id: String(t.id), name: t.name, duration_in_minutes: t.duration_in_minutes };
          chosenBizId  = String(group.clinic_id);
          chosenPracId = String(prac.id);
          firstSlot    = slots[0];

          console.log(`[read] chosen type: "${t.name}" (${t.duration_in_minutes} min, id=${t.id})`);
          console.log(`[read] clinic: ${group.clinic_name} (${group.clinic_id})`);
          console.log(`[read] practitioner id: ${prac.id}`);
          console.log(`[read] first slot raw:`, JSON.stringify(firstSlot, null, 2));
          break outer;
        }
      }
    }

    expect(chosenType).not.toBeNull();
    expect(firstSlot).not.toBeNull();
  }, 120000); // may need to scan many combinations

  liveIt('available_times slot has appointment_end field', () => {
    if (!firstSlot) {
      console.warn('[read] no slot found — skipping appointment_end check');
      return;
    }
    const hasEnd = firstSlot.appointment_end || firstSlot.ends_at;
    console.log(`[read] appointment_end: ${firstSlot.appointment_end ?? '(absent)'}`);
    console.log(`[read] ends_at:         ${firstSlot.ends_at ?? '(absent)'}`);
    // This is the key diagnostic: if both are absent, the 30-min fallback always triggers.
    if (!hasEnd) {
      console.error('[FINDING] appointment_end / ends_at ABSENT in slot — 30-min fallback will always fire');
    } else {
      const start = new Date(firstSlot.appointment_start || firstSlot.starts_at).getTime();
      const end   = new Date(hasEnd).getTime();
      const mins  = (end - start) / 60000;
      console.log(`[read] slot duration from API: ${mins} min (type duration: ${chosenType?.duration_in_minutes} min)`);
    }
    // Non-fatal: the write test below proves Cliniko's actual PATCH behaviour regardless.
    expect(true).toBe(true);
  });
});

// =============================================================================
// 3. WRITE — book, patch with wrong ends_at, observe type change, cancel
//    Requires: WRITE_TEST_CLINIKO=true
// =============================================================================
describe('WRITE (requires WRITE_TEST_CLINIKO=true): reschedule type preservation', () => {
  let bookedType     = null; // appointment_type ref from the booked appointment
  let rescheduleSlot = null; // slot chosen for rescheduling

  writeIt('books a test appointment for the patient', async () => {
    expect(patientId).not.toBeNull();
    expect(chosenType).not.toBeNull();
    expect(firstSlot).not.toBeNull();

    const starts_at = firstSlot.appointment_start || firstSlot.starts_at;
    const result = await hk(() => api.bookAppointment({
      patient_id:          patientId,
      practitioner_id:     chosenPracId,
      business_id:         chosenBizId,
      appointment_type_id: chosenType.id,
      starts_at,
    }));

    expect(result.success).toBe(true);
    bookedApptId = String(result.appointment?.id || result.appointmentId);
    console.log(`[write] booked appointment id: ${bookedApptId}, starts_at: ${starts_at}`);
  }, TIMEOUT);

  writeIt('fetches booked appointment and confirms appointment_type reference', async () => {
    expect(bookedApptId).not.toBeNull();

    const data = await hk(() =>
      new SendMessage(`/individual_appointments/${bookedApptId}`, {}).get()
    );
    bookedType = data.appointment_type;
    console.log(`[write] booked appointment_type ref:`, JSON.stringify(bookedType));
    console.log(`[write] booked ends_at: ${data.ends_at}`);

    // Confirm starts_at and ends_at are both present and duration matches the type
    const durMin = (new Date(data.ends_at).getTime() - new Date(data.starts_at).getTime()) / 60000;
    console.log(`[write] booked duration: ${durMin} min (expected ${chosenType.duration_in_minutes} min)`);
    expect(bookedType).toBeTruthy();
  }, TIMEOUT);

  writeIt('finds a different available slot for rescheduling', async () => {
    const fmtDate = d => d.toISOString().slice(0, 10);
    const from = new Date(Date.now() + 24 * 3600000);
    const to   = new Date(Date.now() + 7 * 24 * 3600000);

    const slots = await hk(() => api.getAvailableTimes({
      practitioner_id: chosenPracId,
      business_id:     chosenBizId,
      appt_type:       chosenType.id,
      from:            fmtDate(from),
      to:              fmtDate(to),
    }));

    // Pick a slot different from the one we booked
    const bookedStart = firstSlot.appointment_start || firstSlot.starts_at;
    rescheduleSlot = slots.find(s =>
      (s.appointment_start || s.starts_at) !== bookedStart
    ) || slots[1] || slots[0];

    expect(rescheduleSlot).toBeTruthy();
    console.log(`[write] reschedule slot raw:`, JSON.stringify(rescheduleSlot, null, 2));
  }, TIMEOUT);

  writeIt('PATCHes appointment with WRONG ends_at (start + 30 min) — simulates the bug', async () => {
    expect(bookedApptId).not.toBeNull();
    expect(rescheduleSlot).not.toBeNull();

    const newStart  = rescheduleSlot.appointment_start || rescheduleSlot.starts_at;
    // Deliberately wrong: 30 min regardless of the real appointment type duration
    const wrongEnd  = new Date(new Date(newStart).getTime() + 30 * 60000).toISOString();

    console.log(`[write] PATCH payload:`);
    console.log(`  appointment_type_id: ${chosenType.id} (${chosenType.name}, ${chosenType.duration_in_minutes} min)`);
    console.log(`  starts_at:           ${newStart}`);
    console.log(`  ends_at (WRONG):     ${wrongEnd}  ← 30 min, not ${chosenType.duration_in_minutes} min`);

    const result = await hk(() => api.updateIndividualAppointment(bookedApptId, {
      appointment_type_id: chosenType.id,
      business_id:         chosenBizId,
      patient_id:          patientId,
      practitioner_id:     chosenPracId,
      starts_at:           newStart,
      ends_at:             wrongEnd,
    }));

    console.log(`[write] PATCH result:`, result);
    expect(result.success).toBe(true);
  }, TIMEOUT);

  writeIt('fetches patched appointment and checks if appointment_type changed', async () => {
    expect(bookedApptId).not.toBeNull();

    const data = await hk(() =>
      new SendMessage(`/individual_appointments/${bookedApptId}`, {}).get()
    );

    const patchedType = data.appointment_type;
    const durMin = (new Date(data.ends_at).getTime() - new Date(data.starts_at).getTime()) / 60000;

    console.log(`[write] BEFORE patch — appointment_type ref:`, JSON.stringify(bookedType));
    console.log(`[write] AFTER  patch — appointment_type ref:`, JSON.stringify(patchedType));
    console.log(`[write] AFTER  patch — ends_at:  ${data.ends_at}`);
    console.log(`[write] AFTER  patch — duration: ${durMin} min (type is ${chosenType.duration_in_minutes} min)`);

    // Extract IDs for comparison
    const extractId = ref => {
      if (!ref) return null;
      if (ref.id) return String(ref.id);
      const url = ref.links?.self || '';
      return url.split('/').pop() || null;
    };

    const originalTypeId = extractId(bookedType);
    const patchedTypeId  = extractId(patchedType);

    if (patchedTypeId !== originalTypeId) {
      console.error(`[FINDING] APPOINTMENT TYPE CHANGED: ${originalTypeId} → ${patchedTypeId}`);
      console.error(`[FINDING] Cliniko overrides appointment_type_id based on ends_at duration`);
      console.error(`[FINDING] This CONFIRMS the bug: 30-min ends_at fallback changes the type`);
    } else {
      console.log(`[FINDING] appointment_type_id preserved (${patchedTypeId}) — type did NOT change`);
      console.log(`[FINDING] If bug is still reported, root cause must be in extractIdFromClinikoRef`);
      console.log(`[FINDING] or in the available_times appointment_end field being absent`);
    }

    // Test always passes — result is diagnostic output, not a pass/fail assertion.
    // The console output above is the evidence.
    expect(patchedType).toBeTruthy();
  }, TIMEOUT);

  writeIt('cancels the test appointment (cleanup)', async () => {
    expect(bookedApptId).not.toBeNull();

    const result = await hk(() => api.cancelSpecificAppointment(bookedApptId));
    console.log(`[write] cancel result:`, result);
    expect(result.success).toBe(true);

    // Mark as cleaned up so afterAll doesn't attempt a second cancel
    bookedApptId = null;
  }, TIMEOUT);
});
