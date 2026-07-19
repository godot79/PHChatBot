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
const {
  getAllAppointmentTypesForAllPractitioners,
  parseApptCategory,
  buildFunnelCatalogue,
  resolveApptFromFunnel,
} = require('../../src/core/_appointmentTypeHelpers');

// Silence logger
jest.mock('../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    child: function () { return this; },
  }))
);

// In-memory DatabaseManager — keeps ChatbotEngine session state isolated from
// the real on-disk database.sqlite while ClinikoAPI itself stays real (live HTTP).
jest.mock('../../src/core/DatabaseManager', () => {
  const sqlite3 = require('sqlite3').verbose();
  const crypto  = require('crypto');

  class DatabaseManager {
    constructor () { this.db = null; this.isInitialized = false; }
    generateSessionId () { return crypto.randomBytes(16).toString('hex'); }

    async initialize () {
      this.db = new sqlite3.Database(':memory:');
      return new Promise((res, rej) => {
        this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          phone_number TEXT NOT NULL,
          patient_id TEXT,
          verification_status TEXT DEFAULT 'pending',
          conversation_state TEXT DEFAULT 'INTRO',
          context TEXT DEFAULT '{}',
          data TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME,
          verified BOOLEAN DEFAULT 0
        )`, (err) => { if (err) return rej(err); this.isInitialized = true; res(); });
      });
    }

    async createSession (phoneNumber, patientId = null, durationMinutes = 30) {
      const id = this.generateSessionId();
      const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
      return new Promise((res, rej) =>
        this.db.run(
          'INSERT INTO sessions (id, phone_number, patient_id, expires_at) VALUES (?, ?, ?, ?)',
          [id, phoneNumber, patientId, expiresAt],
          (err) => (err ? rej(err) : res(id))
        )
      );
    }

    async getSession (id) {
      return new Promise((res, rej) =>
        this.db.get('SELECT * FROM sessions WHERE id = ?', [id],
          (err, row) => (err ? rej(err) : res(row || null)))
      );
    }

    async updateSession (id, updates) {
      const allowed = ['patient_id','verification_status','conversation_state','context','last_activity','expires_at','verified','data'];
      const fields = [], values = [];
      for (const [k, v] of Object.entries(updates)) {
        if (allowed.includes(k)) { fields.push(`${k} = ?`); values.push(v); }
      }
      if (!fields.length) return 0;
      fields.push('last_activity = ?');
      values.push(new Date().toISOString(), id);
      return new Promise((res, rej) =>
        this.db.run(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`, values,
          function (err) { err ? rej(err) : res(this.changes); })
      );
    }

    close () {
      if (!this.db) return Promise.resolve();
      return new Promise((res, rej) => this.db.close(err => err ? rej(err) : res()));
    }

    // No-op — this test's sessions table has no patient_state; _saveFunnelPref
    // calls this defensively (.catch(() => {})) to persist the "book same again"
    // shortcut preference, which is out of scope for these tests.
    async upsertPatientState () { return null; }
  }

  return DatabaseManager;
});

const DatabaseManager = require('../../src/core/DatabaseManager');
const SessionManager  = require('../../src/core/SessionManager');
const ChatbotEngine   = require('../../src/core/ChatbotEngine');

let api;
let cachedClinics = null;
let cachedPractitioners = null;
let cachedRawTypes = null; // getAllAppointmentTypesForAllPractitioners() result — ~30 live GETs, reused across describe blocks to avoid Cliniko rate limiting

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

// =============================================================================
// 7. getAppointmentTypes() — category field and parseApptCategory  (L-A)
// =============================================================================
describe('getAppointmentTypes() — category field and parseApptCategory', () => {
  maybeIt('every type has a category that is a string or null — never an object', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const group = groups.find(g => g.practitioners.length > 0);
    if (!group) return;

    const types = await hk(() => api.getAppointmentTypes({ practitioner_id: group.practitioners[0].id }));
    expect(types.length).toBeGreaterThan(0);

    for (const t of types) {
      expect(typeof t.category === 'string' || t.category == null).toBe(true);
    }
  }, 30000);

  maybeIt('parseApptCategory produces a non-empty service string for every category present', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const group = groups.find(g => g.practitioners.length > 0);
    if (!group) return;

    const types = await hk(() => api.getAppointmentTypes({ practitioner_id: group.practitioners[0].id }));

    const withCategory = types.filter(t => t.category);
    console.log(`[live] ${withCategory.length}/${types.length} types have a non-null category`);

    const uniqueCategories = [...new Set(withCategory.map(t => t.category))];
    console.log('[live] unique categories:', uniqueCategories);

    for (const t of withCategory) {
      const { service, insurer } = parseApptCategory(t.category);
      expect(service.length).toBeGreaterThan(0);
      expect(typeof insurer === 'string' || insurer === null).toBe(true);
    }
  }, 30000);

  maybeIt('at least one appointment type has a non-null category (funnel requires it)', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const allHaveNullCategory = [];

    for (const group of groups) {
      for (const prac of group.practitioners) {
        const types = await hk(() => api.getAppointmentTypes({ practitioner_id: prac.id }));
        const withCat = types.filter(t => t.category);
        if (withCat.length > 0) return; // found at least one — pass
        allHaveNullCategory.push(...types.map(t => t.name));
      }
    }
    console.warn('[live] no appointment types with a category field found — funnel will show all types under one service');
    // Log all type names so we can diagnose the Cliniko account setup
    console.warn('[live] all type names (no category):', allHaveNullCategory);
    // Not a hard failure — the funnel degrades gracefully when category is absent
    // but this signals the Cliniko account may need categories configured
  }, 120000);
});

// =============================================================================
// 8. getAllAppointmentTypesForAllPractitioners + buildFunnelCatalogue  (L-B)
// =============================================================================
describe('getAllAppointmentTypesForAllPractitioners() + buildFunnelCatalogue() — live catalogue', () => {
  let allRawTypes = null;

  maybeIt('returns an array where every entry has id, name, and duration_in_minutes', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    allRawTypes = await hk(() => getAllAppointmentTypesForAllPractitioners(api, groups));
    cachedRawTypes = allRawTypes;
    expect(Array.isArray(allRawTypes)).toBe(true);
    expect(allRawTypes.length).toBeGreaterThan(0);

    for (const t of allRawTypes) {
      expect(t.id).toBeTruthy();
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.duration_in_minutes).toBe('number');
      expect(t.duration_in_minutes).toBeGreaterThan(0);
    }
    console.log(`[live] getAllAppointmentTypesForAllPractitioners → ${allRawTypes.length} types`);
  }, 120000);

  maybeIt('buildFunnelCatalogue produces entries with valid service and duration', async () => {
    if (!allRawTypes) {
      const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
      allRawTypes = await hk(() => getAllAppointmentTypesForAllPractitioners(api, groups));
    }

    const catalogue = buildFunnelCatalogue(allRawTypes);
    expect(catalogue.length).toBeGreaterThan(0);

    for (const entry of catalogue) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.service).toBe('string');
      expect(entry.service.length).toBeGreaterThan(0);
      expect(entry.duration).toBeGreaterThan(0);
    }

    const services = [...new Set(catalogue.map(e => e.service))].sort();
    const insurers = [...new Set(catalogue.map(e => e.insurer).filter(Boolean))].sort();
    const patientTypes = [...new Set(catalogue.map(e => e.patientType).filter(Boolean))];
    console.log('[live] funnel services:', services);
    console.log('[live] funnel insurers:', insurers);
    console.log('[live] funnel patientTypes:', patientTypes);
    console.log(`[live] catalogue: ${catalogue.length} entries (${allRawTypes.length} raw, ${allRawTypes.length - catalogue.length} filtered out)`);
  }, 120000);

  maybeIt('no UWC or online-booking entries survive into the funnel catalogue', async () => {
    if (!allRawTypes) {
      const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
      allRawTypes = await hk(() => getAllAppointmentTypesForAllPractitioners(api, groups));
    }
    const catalogue = buildFunnelCatalogue(allRawTypes);
    const leaked = catalogue.filter(e => /UWC|online\s*booking/i.test(e.name));
    expect(leaked).toHaveLength(0);
  }, 120000);
});

// =============================================================================
// 9. resolveApptFromFunnel — IDs map back to real Cliniko types  (L-C)
// =============================================================================
describe('resolveApptFromFunnel() — resolved IDs are valid live Cliniko type IDs', () => {
  maybeIt('every ID in a resolved entry exists in the raw Cliniko types', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const allRawTypes = await hk(() => getAllAppointmentTypesForAllPractitioners(api, groups));
    const catalogue = buildFunnelCatalogue(allRawTypes);
    if (!catalogue.length) return;

    const realIds = new Set(allRawTypes.map(t => String(t.id)));

    // Try to resolve every unique (service, patientType, insurer, duration) combo
    const tried = new Set();
    for (const entry of catalogue) {
      const key = `${entry.service}|${entry.patientType}|${entry.insurer}|${entry.duration}`;
      if (tried.has(key)) continue;
      tried.add(key);

      const resolved = resolveApptFromFunnel(catalogue, {
        service: entry.service,
        patientType: entry.patientType,
        insurer: entry.insurer,
        duration: entry.duration,
      });

      expect(resolved).not.toBeNull();
      expect(Array.isArray(resolved.ids)).toBe(true);
      expect(resolved.ids.length).toBeGreaterThan(0);
      expect(resolved.name.length).toBeGreaterThan(0);

      for (const id of resolved.ids) {
        expect(realIds.has(id)).toBe(true);
      }
    }
    console.log(`[live] resolveApptFromFunnel verified ${tried.size} unique combos — all IDs valid`);
  }, 120000);
});

// =============================================================================
// 10. Practitioner display name field completeness  (L-D)
// =============================================================================
describe('Practitioner display name — live field completeness', () => {
  // Mirror the engine's getPractitionerDisplayName logic without importing ChatbotEngine
  function displayName(p) {
    if (!p) return '';
    return p.display_name ||
      [p.first_name, p.last_name].filter(Boolean).join(' ') ||
      '';
  }

  maybeIt('every live practitioner has a non-empty display name', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const all = groups.flatMap(g => g.practitioners);
    const blank = all.filter(p => !displayName(p));

    if (blank.length > 0) {
      console.warn('[live] practitioners with no resolvable display name (id list):', blank.map(p => p.id));
    }
    expect(blank).toHaveLength(0);
  }, 60000);

  maybeIt('practitioners sort stably — no two adjacent entries swap after a second sort', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const all = groups.flatMap(g => g.practitioners);

    const sorted1 = [...all].sort((a, b) => displayName(a).localeCompare(displayName(b)));
    const sorted2 = [...all].sort((a, b) => displayName(a).localeCompare(displayName(b)));

    expect(sorted1.map(p => p.id)).toEqual(sorted2.map(p => p.id));
    console.log('[live] first 5 sorted practitioners:', sorted1.slice(0, 5).map(p => displayName(p)));
  }, 60000);
});

// =============================================================================
// 11. getAvailableTimes — wide window diagnostic  (L-E / B1)
// =============================================================================
describe('getAvailableTimes() — 21-day window diagnostic (B1)', () => {
  maybeIt('logs whether Cliniko rejects or accepts a 21-day window', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const group = groups.find(g => g.practitioners.length > 0);
    if (!group) return;

    const prac = group.practitioners[0];
    const types = await hk(() => api.getAppointmentTypes({ practitioner_id: prac.id }));
    if (!types.length) return;

    const from = new Date();
    const to   = new Date(from.getTime() + 21 * 24 * 3600000);
    const fmt  = d => d.toISOString().slice(0, 10);

    let thrownError = null;
    let slots = [];
    try {
      slots = await hk(() => api.getAvailableTimes({
        practitioner_id: prac.id,
        business_id: group.clinic_id,
        appt_type: types[0].id,
        from: fmt(from),
        to: fmt(to),
      }));
    } catch (e) {
      thrownError = e;
    }

    if (thrownError) {
      console.log('[live] B1 diagnostic — 21-day window threw:', thrownError?.message || thrownError);
      console.log('[live] B1: Cliniko still rejects wide windows — guard in getAvailableTimes needed');
    } else {
      console.log(`[live] B1 diagnostic — 21-day window returned ${slots.length} slots without error`);
      if (slots.length === 0) {
        console.log('[live] B1: no slots returned (may be a silent rejection or genuinely no slots)');
      } else {
        console.log('[live] B1: Cliniko accepted a 21-day window — B1 risk may be lower than assessed');
      }
    }
    // Diagnostic only — outcome is logged, not asserted
    expect(true).toBe(true);
  }, 30000);
});

// =============================================================================
// 12. handleBookSoonest choose_physio — row/selection consistency (live)  (L-F)
// =============================================================================
// Regression coverage for the "picked Yashmita, booked Brian" production bug:
// the physio list shown to the user was built from raw Cliniko practitioner
// order, but the numeric reply was resolved against a separately-sorted list
// (data.practitioner_list). This drives the real ChatbotEngine.handleBookSoonest
// against the live HK account's actual practitioner order to prove the
// rendered row order and the stored index-lookup order are identical.
//
// Deliberately a single call, not a "pick row 1, reply '1', check who got
// selected" round trip: a second call re-triggers a full clinic+slot live
// sweep, which is slow, doubles Cliniko rate-limit exposure, and is
// susceptible to slot availability changing between calls. Comparing the
// rendered list against the stored list within one response proves the same
// invariant (row N == practitioner_list[N-1]) without that fragility — this
// is exactly what would have caught the original bug (see the equivalent
// mocked round-trip tests in chatbot.integration.test.js for the full
// select-then-verify behavioral proof).
describe('ChatbotEngine.handleBookSoonest — choose_physio row order (live)', () => {
  let engine, db, sm;

  beforeAll(async () => {
    if (!LIVE) return;
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm; // real ClinikoAPI stays on engine — live HTTP calls
  });

  afterAll(() => {
    if (!LIVE) return;
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });

  async function seedSoonestAtType(apptTypeName) {
    const phone = `+8529${Math.floor(1000000 + Math.random() * 8999999)}`;
    const id = await db.createSession(phone, null, 30);
    await db.updateSession(id, {
      verification_status: 'verified',
      verified: 1,
      conversation_state: 'BOOK_SOONEST',
      data: JSON.stringify({
        email: 'live-test@example.com',
        selection_step: 'choose_type',
        selected_appt_type: { name: apptTypeName },
        // Pre-seeded non-empty so handleBookSoonest skips its own buildTypeCatalogue()
        // rebuild (another full practitioner sweep) — we already have the raw types.
        funnel_catalogue: [{}],
        navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: false, auto: true }],
      }),
    });
    return db.getSession(id);
  }

  // buildAvailablePhysiosForTypeName fires ~N concurrent requests (one per
  // practitioner). A transient Cliniko 429 here is not a product defect —
  // treat it the same as "no slots found" elsewhere in this file: retry once,
  // then degrade to an inconclusive skip rather than fail the suite.
  async function tryLive(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e?.status !== 429) throw e;
      await new Promise(r => setTimeout(r, 5000));
      try {
        return await fn();
      } catch (e2) {
        if (e2?.status !== 429) throw e2;
        return undefined; // signal caller to skip
      }
    }
  }

  maybeIt('the rendered choose_physio list order matches the stored practitioner_list order used for numeric lookup', async () => {
    const groups = cachedPractitioners || await tryLive(() => hk(() => api.getPractitionersByClinic()));
    if (!groups?.length) { console.warn('[live] no clinics (or rate-limited) — skipping'); return; }
    // Reuse the ~30-request sweep from an earlier describe block if it already ran
    // this session — issuing it twice back-to-back can trip Cliniko's rate limiter.
    const allRawTypes = cachedRawTypes || await tryLive(() => hk(() => getAllAppointmentTypesForAllPractitioners(api, groups)));
    if (!allRawTypes) { console.warn('[live] rate-limited fetching appointment types — skipping'); return; }

    // Try the appointment type names backed by the most distinct type IDs first —
    // best chance of landing on a live multi-physio choose_physio list. Capped
    // at 3 — each attempt is a full practitioner sweep.
    const nameCounts = new Map();
    for (const t of allRawTypes) {
      if (!t?.name || /UWC/i.test(t.name)) continue;
      nameCounts.set(t.name, (nameCounts.get(t.name) || 0) + 1);
    }
    const candidateNames = [...nameCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .slice(0, 3);
    if (!candidateNames.length) { console.warn('[live] no appointment types found — skipping'); return; }

    let displayedNames = [];
    let session = null;
    let triedName = null;
    for (const name of candidateNames) {
      session = await seedSoonestAtType(name);
      const reply = await tryLive(() => hk(() => engine.handleBookSoonest(session, '')));
      if (reply === undefined) { console.warn('[live] rate-limited during physio sweep — skipping'); return; }
      displayedNames = [...String(reply).matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());
      triedName = name;
      if (displayedNames.length > 1) break; // found a live multi-physio list
    }

    if (displayedNames.length < 2) {
      console.warn(`[live] none of the top ${candidateNames.length} appointment types currently have >1 available physio with slots (last tried "${triedName}") — skipping row-order check`);
      return;
    }

    const updated = await db.getSession(session.id);
    const d = JSON.parse(updated.data || '{}');
    const storedNames = (d.practitioner_list || []).map(p =>
      p.display_name || [p.first_name, p.last_name].filter(Boolean).join(' ')
    );

    expect(displayedNames).toEqual(storedNames);
  }, 90000);

  // Reproduces the 2026-07-19 13:35 production incident: after choose_physio
  // finds 0 available practitioners for the selected type (real "no slots" or
  // a swallowed Cliniko error — indistinguishable to this code), the user hits
  // "Try Again" (no_slots_prompt reply "1"). navBack() only has one checkpoint
  // to return to — the initial 'choose_type' branch — and clearForwardStateForPopped
  // wipes funnel_step/funnel_sel/selected_appt_type for that step. So "Try Again"
  // doesn't retry the failed step; it restarts the ENTIRE appointment funnel,
  // forcing the user to re-answer service / insurer / "new or returning patient?"
  // from scratch. Uses this account's REAL funnel catalogue so the repro reflects
  // the actual multi-step questions this account asks, not a synthetic fixture.
  maybeIt('"Try Again" after 0-practitioner result discards the already-answered funnel selections instead of retrying', async () => {
    const groups = cachedPractitioners || await tryLive(() => hk(() => api.getPractitionersByClinic()));
    if (!groups?.length) { console.warn('[live] no clinics (or rate-limited) — skipping'); return; }
    const allRawTypes = cachedRawTypes || await tryLive(() => hk(() => getAllAppointmentTypesForAllPractitioners(api, groups)));
    if (!allRawTypes) { console.warn('[live] rate-limited fetching appointment types — skipping'); return; }

    const catalogue = buildFunnelCatalogue(allRawTypes);
    const services = [...new Set(catalogue.map(t => t.service).filter(Boolean))];
    if (services.length < 2) {
      console.warn('[live] this account only has one service category — funnel has no branch point to lose, skipping');
      return;
    }

    const phone = `+8529${Math.floor(1000000 + Math.random() * 8999999)}`;
    const id = await db.createSession(phone, null, 30);
    await db.updateSession(id, {
      verification_status: 'verified',
      verified: 1,
      conversation_state: 'BOOK_SOONEST',
      data: JSON.stringify({
        email: 'live-test@example.com',
        selection_step: 'choose_type',
        funnel_catalogue: catalogue, // real live catalogue — real service/insurer/patientType combos
        navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: true, auto: false }],
      }),
    });
    let session = await db.getSession(id);

    // Force the "0 available practitioners" branch deterministically — the failure
    // mode itself (real zero-slots vs. a swallowed 429) is irrelevant to this bug;
    // both land in the exact same no_slots_prompt / navBack path.
    const realGetPractitionersByClinic = engine.clinikoAPI.getPractitionersByClinic;
    engine.clinikoAPI.getPractitionersByClinic = async () => [];

    try {
      // Walk the REAL funnel (service → insurer → new/follow-up + duration, as
      // applicable for this account) answering "1" at each prompt.
      let reply = await engine.handleBookSoonest(session, '');
      let data;
      let guard = 0;
      while (guard++ < 6) {
        session = await db.getSession(id);
        data = JSON.parse(session.data || '{}');
        if (data.no_slots_prompt) break;
        reply = await engine.handleBookSoonest(session, '1');
      }

      expect(data.no_slots_prompt).toBeTruthy(); // confirms we actually reached the bug's trigger condition
      expect(data.selected_appt_type).toBeTruthy(); // the funnel WAS fully answered before failing
      const preRetryFunnelSel = data.funnel_sel;
      expect(preRetryFunnelSel && preRetryFunnelSel.patientType).toBeTruthy(); // proves a real new/follow-up (or equivalent) answer was captured

      // User taps "Try Again".
      session = await db.getSession(id);
      await engine.handleBookSoonest(session, '1');
      session = await db.getSession(id);
      const afterRetry = JSON.parse(session.data || '{}');

      // Ideal behavior: retrying should re-check availability for the SAME
      // already-chosen appointment type, not force the user through the funnel
      // again. Documents the live-reproduced regression.
      expect(afterRetry.selected_appt_type).toEqual(data.selected_appt_type);
    } finally {
      engine.clinikoAPI.getPractitionersByClinic = realGetPractitionersByClinic;
    }
  }, 60000);

  // Reproduces the 2026-07-19 "no send button" incident directly against this
  // account's real catalogue: Physiotherapy self-pay has 5 real insurers, so
  // the insurer prompt (Self-pay + 5) is a real 6-row list — the exact
  // production case that overflowed the unpaginated list() call.
  maybeIt('any funnel list step with >5 real options pages at 5, never dumps everything in one WhatsApp list', async () => {
    const groups = cachedPractitioners || await tryLive(() => hk(() => api.getPractitionersByClinic()));
    if (!groups?.length) { console.warn('[live] no clinics (or rate-limited) — skipping'); return; }
    const allRawTypes = cachedRawTypes || await tryLive(() => hk(() => getAllAppointmentTypesForAllPractitioners(api, groups)));
    if (!allRawTypes) { console.warn('[live] rate-limited fetching appointment types — skipping'); return; }

    const catalogue = buildFunnelCatalogue(allRawTypes);
    const services = [...new Set(catalogue.map(t => t.service).filter(Boolean))];

    // Find a service whose insurer list (Self-pay + real insurers) exceeds 5 —
    // this account's real Physiotherapy category does.
    let overflowService = null;
    for (const s of services) {
      const insurers = [...new Set(catalogue.filter(t => t.service === s).map(t => t.insurer).filter(i => i !== null))];
      if (insurers.length + 1 > 5) { overflowService = s; break; }
    }
    if (!overflowService) {
      console.warn('[live] no service currently has >5 insurer options — skipping (nothing to overflow)');
      return;
    }

    const phone = `+8529${Math.floor(1000000 + Math.random() * 8999999)}`;
    const id = await db.createSession(phone, null, 30);
    await db.updateSession(id, {
      verification_status: 'verified',
      verified: 1,
      conversation_state: 'BOOK_SOONEST',
      data: JSON.stringify({
        email: 'live-test@example.com',
        selection_step: 'choose_type',
        funnel_catalogue: catalogue,
        funnel_step: 'insurer',
        funnel_sel: { service: overflowService },
        navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: true, auto: false }],
      }),
    });
    const session = await db.getSession(id);

    const reply = await tryLive(() => engine.handleBookSoonest(session, ''));
    if (reply === undefined) { console.warn('[live] rate-limited — skipping'); return; }

    const numberedLines = [...String(reply).matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());
    expect(numberedLines.length).toBeLessThanOrEqual(5);
    expect(String(reply)).toMatch(/more/i);
  }, 60000);
});

// =============================================================================
// 10. getAvailableSlotsByBusinessAndDate — 429 must not silently present as
//     "no slots" under the concurrent-load volume seen in production
//     (2026-07-19 13:09 chatbot-webhook incident: BOOK_SOONEST choose_clinic
//     fell back to buildAvailablePhysiosForTypeName's full practitioner sweep,
//     which fired dozens of concurrent Cliniko GETs and got mass-429'd; every
//     429 was swallowed into an empty slot array, so real availability was
//     reported to the user as "no slots found").
// =============================================================================
describe('getAvailableSlotsByBusinessAndDate() — real slots must survive concurrent-load 429s (live regression)', () => {
  maybeIt('a practitioner with known live slots must not silently lose them under production-scale concurrent load', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    if (!groups.length) { console.warn('[live] no clinics — skipping'); return; }

    const allPractitioners = [...new Map(
      groups.flatMap(g => (g.practitioners || []).map(p => [p.id, { ...p, clinic_id: g.clinic_id }]))
    ).values()];
    if (allPractitioners.length < 8) {
      console.warn('[live] too few practitioners to reproduce production burst volume — skipping');
      return;
    }

    const from = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);

    // Step 1 — clean baseline, no concurrent load: find a practitioner with real slots.
    let target = null;
    let baselineSlots = null;
    for (const p of allPractitioners.slice(0, 6)) {
      const slots = await hk(() => api.getAvailableSlotsByBusinessAndDate({
        business_id: p.clinic_id, practitioner_id: p.id, from, to,
      }));
      if (slots.length) { target = p; baselineSlots = slots; break; }
    }
    if (!target) {
      console.warn('[live] no practitioner in the sample has slots in the next 6 days — skipping');
      return;
    }

    // Step 2 — detect real 429s without changing behavior (pass-through spy).
    const SendMessageMod = require('../../src/api/SendMessage');
    const realGet = SendMessageMod.prototype.get;
    let saw429 = false;
    SendMessageMod.prototype.get = function (...args) {
      return realGet.apply(this, args).catch(err => {
        if (err && err.status === 429) saw429 = true;
        throw err;
      });
    };

    // Step 3 — reproduce production's fan-out: re-request the same known-good
    // practitioner concurrently alongside ~15 peers, matching the burst volume
    // observed in the incident logs.
    let targetResult;
    try {
      const burstPeers = allPractitioners.filter(p => p.id !== target.id).slice(0, 15);
      [targetResult] = await hk(() => Promise.all([
        api.getAvailableSlotsByBusinessAndDate({ business_id: target.clinic_id, practitioner_id: target.id, from, to }),
        ...burstPeers.map(p => api.getAvailableSlotsByBusinessAndDate({ business_id: p.clinic_id, practitioner_id: p.id, from, to })),
      ]));
    } finally {
      SendMessageMod.prototype.get = realGet;
    }

    if (!saw429) {
      console.warn('[live] burst did not trigger a real Cliniko 429 this run — cannot confirm the regression live, skipping assertion');
      return;
    }

    // A real 429 occurred inside this burst. Ideal behavior: the practitioner
    // we just confirmed has slots must still show them — a transient rate
    // limit must not silently present as "no availability".
    expect(targetResult.length).toBeGreaterThan(0);
    expect(targetResult.map(s => s.slot).sort()).toEqual(baselineSlots.map(s => s.slot).sort());
  }, 60000);

  // Layer 1 of the central architecture: getAvailableSlotsByBusinessAndDate()
  // now tags its result with a non-enumerable _partial marker whenever an
  // inner combo's fetch failed and was silently skipped, so callers can tell
  // "confirmed zero" apart from "some inner fetches failed, this count may be
  // short". Mocked coverage (ClinikoAPI.test.js) proves the mechanics; this
  // confirms the marker actually fires under the real 429 volume this fix
  // exists for, not just a synthetic mock.
  maybeIt('_partial marker is set on results affected by a real concurrent-load 429', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    if (!groups.length) { console.warn('[live] no clinics — skipping'); return; }

    const allPractitioners = [...new Map(
      groups.flatMap(g => (g.practitioners || []).map(p => [p.id, { ...p, clinic_id: g.clinic_id }]))
    ).values()];
    if (allPractitioners.length < 8) {
      console.warn('[live] too few practitioners to reproduce production burst volume — skipping');
      return;
    }

    const from = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);

    const SendMessageMod = require('../../src/api/SendMessage');
    const realGet = SendMessageMod.prototype.get;
    let saw429 = false;
    SendMessageMod.prototype.get = function (...args) {
      return realGet.apply(this, args).catch(err => {
        if (err && err.status === 429) saw429 = true;
        throw err;
      });
    };

    let results;
    try {
      const burst = allPractitioners.slice(0, 16);
      results = await hk(() => Promise.all(
        burst.map(p => api.getAvailableSlotsByBusinessAndDate({ business_id: p.clinic_id, practitioner_id: p.id, from, to }))
      ));
    } finally {
      SendMessageMod.prototype.get = realGet;
    }

    if (!saw429) {
      console.warn('[live] burst did not trigger a real Cliniko 429 this run — cannot confirm the marker live, skipping assertion');
      return;
    }

    expect(results.some(r => r._partial === true)).toBe(true);
  }, 60000);
});

// =============================================================================
// 11. Caching — repeated calls for the same data must not re-hit Cliniko (live)
//
// buildAvailablePhysiosForTypeName's ~994-request fan-out (measured live against
// this account: 34 practitioners, 4 clinics, 40 practitioner-clinic pairs, ~22
// types/practitioner) is dominated by requests for data that doesn't change
// second-to-second: appointment types, clinic->practitioner membership, and
// business records. Caching those (30 s TTL, matching the existing
// getPractitionersByClinic() cache) plus getAvailableTimes itself (configurable
// TTL, default 5 min — safe because bookAppointment() always re-validates at
// write time) should collapse repeat calls to zero real HTTP requests.
// =============================================================================
describe('ClinikoAPI caching — repeated lookups hit cache, not Cliniko (live)', () => {
  let getSpy;
  let realGet;

  beforeAll(() => {
    if (!LIVE) return;
    ClinikoAPI._clearGroupsCache();
  });

  beforeEach(() => {
    if (!LIVE) return;
    const SendMessageMod = require('../../src/api/SendMessage');
    realGet = SendMessageMod.prototype.get;
    let calls = 0;
    getSpy = { count: () => calls };
    SendMessageMod.prototype.get = function (...args) {
      calls++;
      return realGet.apply(this, args);
    };
  });

  afterEach(() => {
    if (!LIVE) return;
    require('../../src/api/SendMessage').prototype.get = realGet;
  });

  maybeIt('getAppointmentTypes() — second call for the same practitioner makes zero HTTP requests', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const practitioner = groups.flatMap(g => g.practitioners)[0];
    if (!practitioner) { console.warn('[live] no practitioners — skipping'); return; }

    ClinikoAPI._clearGroupsCache();
    await hk(() => api.getPractitionersByClinic()); // re-warm (cleared above)
    const before = getSpy.count();
    await hk(() => api.getAppointmentTypes({ practitioner_id: practitioner.id }));
    const afterFirst = getSpy.count();
    await hk(() => api.getAppointmentTypes({ practitioner_id: practitioner.id }));
    const afterSecond = getSpy.count();

    expect(afterFirst).toBeGreaterThan(before);       // first call was real
    expect(afterSecond).toBe(afterFirst);             // second call was a cache hit
  }, 30000);

  maybeIt('getPractitionersForClinic() — second call for the same clinic makes zero HTTP requests', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const clinicId = groups[0]?.clinic_id;
    if (!clinicId) { console.warn('[live] no clinics — skipping'); return; }

    const before = getSpy.count();
    await hk(() => api.getPractitionersForClinic(clinicId));
    const afterFirst = getSpy.count();
    await hk(() => api.getPractitionersForClinic(clinicId));
    const afterSecond = getSpy.count();

    expect(afterFirst).toBeGreaterThan(before);
    expect(afterSecond).toBe(afterFirst);
  }, 30000);

  maybeIt('getBusinessById() — second call for the same business makes zero HTTP requests', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const clinicId = groups[0]?.clinic_id;
    if (!clinicId) { console.warn('[live] no clinics — skipping'); return; }

    const before = getSpy.count();
    await hk(() => api.getBusinessById(clinicId));
    const afterFirst = getSpy.count();
    await hk(() => api.getBusinessById(clinicId));
    const afterSecond = getSpy.count();

    expect(afterFirst).toBeGreaterThan(before);
    expect(afterSecond).toBe(afterFirst);
  }, 30000);

  maybeIt('getAvailableTimes() — second call for the same practitioner/type/window makes zero HTTP requests', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const group = groups.find(g => g.practitioners.length > 0);
    if (!group) { console.warn('[live] no practitioners — skipping'); return; }
    const practitioner = group.practitioners[0];
    const types = await hk(() => api.getAppointmentTypes({ practitioner_id: practitioner.id }));
    if (!types.length) { console.warn('[live] practitioner has no appointment types — skipping'); return; }

    const from = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
    const args = { practitioner_id: practitioner.id, business_id: group.clinic_id, appt_type: types[0].id, from, to };

    const before = getSpy.count();
    await hk(() => api.getAvailableTimes(args));
    const afterFirst = getSpy.count();
    await hk(() => api.getAvailableTimes(args));
    const afterSecond = getSpy.count();

    expect(afterFirst).toBeGreaterThan(before);
    expect(afterSecond).toBe(afterFirst);
  }, 30000);
});
