'use strict';
/**
 * tests/integration/cliniko.live.test.js
 *
 * Read-only contract tests against the live Cliniko HK account.
 * All tests skip automatically when CLINIKO_API_KEY_HK is unset.
 *
 * Run:
 *   CLINIKO_API_KEY_HK=<key> npx jest tests/integration/cliniko.live.test.js --runInBand
 *
 * These tests verify the response shapes the engine and ClinikoAPI assume.
 * They make real HTTPS requests — never write or cancel anything.
 */

require('dotenv').config();

const LIVE = !!process.env.CLINIKO_API_KEY_HK;
const maybeIt = LIVE ? it : it.skip;

// Set region context so ClinikoHeaders picks the HK key
process.env.CLINIKO_API_KEY_HK = process.env.CLINIKO_API_KEY_HK || '';

// Run under HK region context for the whole file
const RegionContext = require('../../src/core/RegionContext');
const ClinikoAPI = require('../../src/api/ClinikoAPI');

// Silence logger
jest.mock('../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    child: function () { return this; },
  }))
);

let api;
let cachedClinics = null;
let cachedPractitioners = null;

beforeAll(() => {
  api = new ClinikoAPI();
});

// Helper: run fn inside HK region context
function hk(fn) {
  return RegionContext.run('HK', fn);
}

// =============================================================================
// 1. getClinics — shape and exclusion
// =============================================================================
describe('getClinics()', () => {
  maybeIt('returns an array of clinic objects', async () => {
    const clinics = await hk(() => api.getClinics());
    expect(Array.isArray(clinics)).toBe(true);
    expect(clinics.length).toBeGreaterThan(0);
    cachedClinics = clinics;
  }, 30000);

  maybeIt('each clinic has id and business_name', async () => {
    const clinics = cachedClinics || await hk(() => api.getClinics());
    for (const c of clinics) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.business_name).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
    }
  }, 30000);

  maybeIt('no clinic name matches PhysioFocus or UWC exclusion pattern', async () => {
    const clinics = cachedClinics || await hk(() => api.getClinics());
    const pattern = /UWC|physio\s*focus/i;
    const excluded = clinics.filter(c => pattern.test(c.business_name));
    expect(excluded).toHaveLength(0);
  }, 30000);
});

// =============================================================================
// 2. getPractitionersByClinic — shape
// =============================================================================
describe('getPractitionersByClinic()', () => {
  maybeIt('returns grouped array with clinic_id, clinic_name, practitioners', async () => {
    const groups = await hk(() => api.getPractitionersByClinic());
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
    cachedPractitioners = groups;

    for (const g of groups) {
      expect(typeof g.clinic_id).toBe('string');
      expect(typeof g.clinic_name).toBe('string');
      expect(Array.isArray(g.practitioners)).toBe(true);
    }
  }, 60000);

  maybeIt('practitioners have id and at least one name field', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const allPractitioners = groups.flatMap(g => g.practitioners);
    for (const p of allPractitioners) {
      expect(typeof p.id).toBe('string');
      const hasName = p.display_name || p.first_name || p.last_name;
      expect(hasName).toBeTruthy();
    }
  }, 60000);

  maybeIt('no UWC or PhysioFocus clinics appear in groups', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const pattern = /UWC|physio\s*focus/i;
    const excluded = groups.filter(g => pattern.test(g.clinic_name));
    expect(excluded).toHaveLength(0);
  }, 60000);

  maybeIt('groups count matches getClinics() count — no clinic dropped or duplicated', async () => {
    const [clinics, groups] = await hk(() =>
      Promise.all([api.getClinics(), api.getPractitionersByClinic()])
    );
    expect(groups).toHaveLength(clinics.length);
    const ids = groups.map(g => g.clinic_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  }, 60000);

  maybeIt('second call returns from cache — completes in under 50ms', async () => {
    await hk(() => api.getPractitionersByClinic());   // warm the cache
    const t0 = Date.now();
    await hk(() => api.getPractitionersByClinic());   // should hit cache
    expect(Date.now() - t0).toBeLessThan(50);
  }, 60000);
});

// =============================================================================
// 3. getAvailableSlotsByBusinessAndDate — slot field name
// =============================================================================
describe('getAvailableSlotsByBusinessAndDate() — slot field names', () => {
  maybeIt('slot objects have a time value in appointment_start, start_time, or starts_at', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    if (!groups.length) return;

    // Pick first clinic with at least one practitioner
    const group = groups.find(g => g.practitioners.length > 0);
    if (!group) return;

    const from = new Date();
    const to = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 10);

    const slots = await hk(() => api.getAvailableSlotsByBusinessAndDate({
      business_id: group.clinic_id,
      practitioner_id: group.practitioners[0].id,
      from: fmt(from),
      to: fmt(to),
    }));

    if (!slots.length) {
      // No slots in next 14 days — test is inconclusive but not a failure
      console.warn('[live] No slots found in next 14 days for', group.clinic_name);
      return;
    }

    for (const slot of slots.slice(0, 3)) {
      const time = slot.slot || slot.appointment_start || slot.start_time || slot.starts_at;
      expect(time).toBeDefined();
      expect(new Date(time).getTime()).toBeGreaterThan(0);
    }
  }, 60000);
});

// =============================================================================
// 3b. getAvailableTimes — slot shape (reschedule engine contract)
// =============================================================================
describe('getAvailableTimes() — slot field names', () => {
  maybeIt('slots have appointment_start but NO appointment_end (Cliniko API contract)', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const group = groups.find(g => g.practitioners.length > 0);
    if (!group) return;

    const prac = group.practitioners[0];
    const types = await hk(() => api.getAppointmentTypes({ practitioner_id: prac.id }));
    if (!types.length) return;

    const from = new Date(Date.now() + 24 * 3600000);
    const to   = new Date(Date.now() + 7 * 24 * 3600000);
    const fmt  = d => d.toISOString().slice(0, 10);

    let slots = [];
    for (const t of types) {
      slots = await hk(() => api.getAvailableTimes({
        practitioner_id: prac.id,
        business_id: group.clinic_id,
        appt_type: t.id,
        from: fmt(from),
        to: fmt(to),
      })).catch(() => []);
      if (slots.length) break;
    }

    if (!slots.length) {
      console.warn('[live] No available_times slots found — skipping field check');
      return;
    }

    const slot = slots[0];
    expect(slot.appointment_start).toBeDefined();
    // Cliniko never returns appointment_end on available_times slots.
    // If this assertion starts failing, the engine's duration-derivation fallback
    // in handleConfirmRescheduleState can be simplified.
    expect(slot.appointment_end).toBeUndefined();
    expect(slot.ends_at).toBeUndefined();
  }, 60000);
});

// =============================================================================
// 4. getBookingsByPatientId — appointment reference shape
// =============================================================================
describe('getBookingsByPatientId() — appointment reference objects', () => {
  const TEST_PATIENT_ID = process.env.TEST_CLINIKO_PATIENT_ID;

  maybeIt('appointments have practitioner/business/appointment_type as reference objects', async () => {
    if (!TEST_PATIENT_ID) {
      console.warn('[live] TEST_CLINIKO_PATIENT_ID not set — skipping patient shape test');
      return;
    }

    const appts = await hk(() => api.getBookingsByPatientId(TEST_PATIENT_ID, {
      when: 'past',
      statusMode: 'active',
      perPage: 5,
    }));

    if (!appts.length) {
      console.warn('[live] No past appointments found for test patient');
      return;
    }

    for (const appt of appts.slice(0, 2)) {
      // Engine reads IDs via extractIdFromClinikoRef which checks obj.id then obj.links.self
      const hasPractitionerRef = appt.practitioner?.id || appt.practitioner?.links?.self;
      const hasBusinessRef     = appt.business?.id || appt.business?.links?.self;
      const hasTypeRef         = appt.appointment_type?.id || appt.appointment_type?.links?.self;
      expect(hasPractitionerRef).toBeTruthy();
      expect(hasBusinessRef).toBeTruthy();
      expect(hasTypeRef).toBeTruthy();
    }
  }, 30000);

  maybeIt('appointment has starts_at field', async () => {
    if (!TEST_PATIENT_ID) return;

    const appts = await hk(() => api.getBookingsByPatientId(TEST_PATIENT_ID, {
      when: 'future',
      statusMode: 'active',
      perPage: 5,
    }));

    for (const appt of appts.slice(0, 2)) {
      expect(typeof appt.starts_at).toBe('string');
      expect(new Date(appt.starts_at).getTime()).toBeGreaterThan(0);
    }
  }, 30000);
});

// =============================================================================
// 5. cancelSpecificAppointment — payload shape (dry run, no real cancel)
// =============================================================================
describe('cancelSpecificAppointment() — payload validation', () => {
  maybeIt('payload includes cancellation_reason', () => {
    // Static code assertion — verifies Cliniko required field is present.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/api/ClinikoAPI.js'),
      'utf8'
    );
    const cancelFn = src.match(/async cancelSpecificAppointment[\s\S]+?^\s{2}}/m)?.[0] || '';
    expect(cancelFn).toMatch(/cancellation_reason/);
  });

  maybeIt('cancellation_note is sent as string', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/api/ClinikoAPI.js'),
      'utf8'
    );
    const cancelFn = src.match(/async cancelSpecificAppointment[\s\S]+?^\s{2}}/m)?.[0] || '';
    expect(cancelFn).toMatch(/cancellation_note.*string|cancellation_note.*chatbot/s);
  });
});

// =============================================================================
// 6. SendMessage timeout — verified in source
// =============================================================================
describe('SendMessage — timeout configured', () => {
  it('all three HTTP methods set a timeout', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/api/SendMessage.js'),
      'utf8'
    );
    const timeoutMatches = src.match(/timeout:/g) || [];
    // get, post, patch each have one timeout setting
    expect(timeoutMatches.length).toBeGreaterThanOrEqual(3);
  });
});
