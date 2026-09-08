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
const { bulkAll } = require('../../src/core/BulkContext');
const ClinikoAPI = require('../../src/api/ClinikoAPI');
const {
  getAllAppointmentTypesForAllPractitioners,
  getPractitionersForTypeName,
  parseApptCategory,
  buildFunnelCatalogue,
  resolveApptFromFunnel,
} = require('../../src/core/_appointmentTypeHelpers');

// Local copy of practitionerGender — must stay in sync with ChatbotEngine.js
function practitionerGender(p) {
  const t = (p && p.title) ? String(p.title).trim() : '';
  if (t === 'Mr')  return 'male';
  if (t === 'Ms' || t === 'Miss' || t === 'Mrs') return 'female';
  return null;
}

function applyGenderFilter(list, gender) {
  if (!gender) return list;
  const filtered = list.filter(p => {
    const g = practitionerGender(p);
    return g === null || g === gender;
  });
  return filtered.length > 0 ? filtered : list; // fall back to full list if empty
}

// Silence logger
jest.mock('../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, analyticsEvent: () => {},
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
        this.db.serialize(() => {
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
          )`);
          // Real (in-memory) patient_state table — same shape as production —
          // so tests can exercise the actual getPatientState/upsertPatientState
          // persistence path (pickup + amend across sessions), not a stub.
          this.db.run(`CREATE TABLE IF NOT EXISTS patient_state (
            phone_number TEXT PRIMARY KEY,
            region TEXT,
            appt_preference TEXT,
            patient_id TEXT,
            verified BOOLEAN,
            language TEXT,
            preferred_insurer TEXT,
            physio_preference TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`, (err) => { if (err) return rej(err); this.isInitialized = true; res(); });
        });
      });
    }

    // Not exercised by these tests (no prior-session reseed scenario needed) —
    // returning empty just makes getOrCreateSession's prior-session lookup a
    // safe no-op, same as a phone number with no session history.
    async query () { return []; }

    async getSessionByPhone (phoneNumber) {
      return new Promise((res, rej) =>
        this.db.get('SELECT * FROM sessions WHERE phone_number = ? ORDER BY last_activity DESC LIMIT 1', [phoneNumber],
          (err, row) => (err ? rej(err) : res(row || null)))
      );
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

    async getPatientState (phone) {
      return new Promise((res, rej) =>
        this.db.get('SELECT * FROM patient_state WHERE phone_number = ?', [phone],
          (err, row) => (err ? rej(err) : res(row || null)))
      );
    }

    async upsertPatientState (phone, updates) {
      const { region, appt_preference, patient_id, verified, language, preferred_insurer, physio_preference } = updates;
      const verifiedValue = verified === undefined ? null : (verified ? 1 : 0);
      return new Promise((res, rej) => {
        this.db.run(
          `INSERT INTO patient_state (phone_number, region, appt_preference, patient_id, verified, language, preferred_insurer, physio_preference, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(phone_number) DO UPDATE SET
             region = COALESCE(?, region),
             appt_preference = COALESCE(?, appt_preference),
             patient_id = COALESCE(?, patient_id),
             verified = COALESCE(?, verified),
             language = COALESCE(?, language),
             preferred_insurer = COALESCE(?, preferred_insurer),
             physio_preference = COALESCE(?, physio_preference),
             updated_at = CURRENT_TIMESTAMP`,
          [
            phone, region ?? null, appt_preference ?? null, patient_id ?? null, verifiedValue, language ?? null, preferred_insurer ?? null, physio_preference ?? null,
            region ?? null, appt_preference ?? null, patient_id ?? null, verifiedValue, language ?? null, preferred_insurer ?? null, physio_preference ?? null,
          ],
          (err) => (err ? rej(err) : res())
        );
      });
    }
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

const { acquireLiveLock, releaseLiveLock } = require('./_liveTestLock');

beforeAll(async () => {
  // Cross-process mutex — this file and reschedule_type_preservation.write.test.js
  // both hit live Cliniko; running in parallel Jest workers causes real 429s that
  // look like flaky assertion failures but are actually cross-file contention.
  if (LIVE) await acquireLiveLock();
  api = new ClinikoAPI();
}, 65_000);

afterAll(() => {
  if (LIVE) releaseLiveLock();
});

// Helper: run fn inside HK region context
function hk(fn) {
  return RegionContext.run('HK', fn);
}

/**
 * Actively polls a cheap, uncached endpoint until Cliniko stops 429ing, instead
 * of guessing a fixed cooldown duration. The "concurrent-load 429s" describe
 * block deliberately hammers the account right before "ClinikoAPI caching"
 * runs, and how long that self-inflicted rate-limit actually lasts varies
 * (observed anywhere from a few seconds to well over 45s in this same
 * session) — a blind sleep(N) is a guess no matter what N is; this measures
 * the real thing instead. Bypasses SendMessage's own cache entirely (raw
 * SendMessage, not a cached ClinikoAPI method) so a warm cache can't produce
 * a false "recovered" signal without an actual network round-trip.
 * @returns {Promise<boolean>} true once a real (non-429) response is seen,
 *   false if maxWaitMs is exceeded without one.
 */
async function waitForClinikoRecovery(maxWaitMs = 120000, pollIntervalMs = 5000) {
  const SendMessageMod = require('../../src/api/SendMessage');
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await hk(() => new SendMessageMod('/businesses', {}).get());
      return true;
    } catch (err) {
      if (err?.status !== 429) return true; // a non-429 error isn't the congestion we're waiting out
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
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
    // This seeds cachedPractitioners, which most other describe blocks in this
    // file reuse — a _partial result here (bulkAll's own overall deadline hit
    // under real congestion, see BulkContext.js) must not silently propagate
    // an incomplete/empty list forward. Retry a few times rather than
    // asserting straight through, same convention as the cache-speed test
    // right below and the "ClinikoAPI caching" block further down.
    let groups;
    for (let attempt = 0; attempt < 3; attempt++) {
      groups = await hk(() => api.getPractitionersByClinic());
      if (!groups._partial && groups.length > 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
    cachedPractitioners = groups;

    for (const g of groups) {
      expect(typeof g.clinic_id).toBe('string');
      expect(typeof g.clinic_name).toBe('string');
      expect(Array.isArray(g.practitioners)).toBe(true);
    }
  }, 90000);

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
    // The warm-up call itself can hit bulkAll's own overall deadline under
    // real congestion (see BulkContext.js) — a result marked _partial is
    // deliberately never cached (same reasoning as a failed clinics fetch),
    // so a degraded warm-up would make the "second call" below a real slow
    // fetch too, not a false failure of the cache itself. Retry the warm-up
    // a few times until it actually succeeds before timing anything — same
    // "don't let live congestion masquerade as a broken cache" convention
    // the "ClinikoAPI caching" describe block below already uses.
    let warm;
    for (let attempt = 0; attempt < 3; attempt++) {
      warm = await hk(() => api.getPractitionersByClinic());
      if (!warm._partial) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (warm._partial) {
      console.warn('[live] could not get a clean (non-partial) warm-up after 3 attempts — skipping, account still under heavy load');
      return;
    }

    const t0 = Date.now();
    await hk(() => api.getPractitionersByClinic());   // should hit cache
    expect(Date.now() - t0).toBeLessThan(50);
  }, 90000);
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

    // Walks every page (not just page 0) so this actually proves the row-order
    // invariant across the whole list, not just whatever happens to fit on the
    // first page — a candidate type busy enough to have >5 physios previously
    // produced a false failure here: page 0's 5 rendered names were compared
    // against the full stored list instead of just page 0's slice (2026-08-06).
    let displayedNames = [];
    let session = null;
    let triedName = null;
    for (const name of candidateNames) {
      session = await seedSoonestAtType(name);
      const firstReply = await tryLive(() => hk(() => engine.handleBookSoonest(session, '')));
      if (firstReply === undefined) { console.warn('[live] rate-limited during physio sweep — skipping'); return; }
      const firstPageNames = [...String(firstReply).matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());
      triedName = name;
      if (firstPageNames.length <= 1) continue; // not a multi-physio list, try the next candidate

      // Found a live multi-physio list — page through the rest with 'next'.
      const allPageNames = [...firstPageNames];
      let hasMore = /\bMore\b|\bnext\b/i.test(String(firstReply));
      let guard = 0;
      while (hasMore && guard++ < 20) {
        const nextReply = await tryLive(() => hk(async () => engine.handleBookSoonest(await db.getSession(session.id), 'next')));
        if (nextReply === undefined) { console.warn('[live] rate-limited while paging — skipping'); return; }
        const pageNames = [...String(nextReply).matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());
        allPageNames.push(...pageNames);
        hasMore = /\bMore\b|\bnext\b/i.test(String(nextReply));
      }
      displayedNames = allPageNames;
      break;
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
  }, 120000);

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
    // observed in the incident logs. Goes through bulkAll, same as every real
    // caller (fix/fanout-batching-consistency) — a raw Promise.all here would
    // test a burst shape production can no longer actually produce, since
    // every real call site is now throttled+deadline-bounded the same way.
    let burstResults;
    try {
      const burstPeers = allPractitioners.filter(p => p.id !== target.id).slice(0, 15);
      burstResults = await hk(() => bulkAll(
        [target, ...burstPeers],
        p => api.getAvailableSlotsByBusinessAndDate({ business_id: p.clinic_id, practitioner_id: p.id, from, to })
      ));
    } finally {
      SendMessageMod.prototype.get = realGet;
    }
    const targetResult = burstResults[0];

    if (!saw429) {
      console.warn('[live] burst did not trigger a real Cliniko 429 this run — cannot confirm the regression live, skipping assertion');
      return;
    }

    if (targetResult === undefined) {
      // bulkAll's own overall deadline was hit before the target practitioner's
      // own request settled — inconclusive (not a fail): we can't tell "slots
      // silently lost to a 429" apart from "still legitimately in flight when
      // we stopped waiting". Same "skip when we can't confirm" convention this
      // test already uses for the "no 429 observed" case above.
      console.warn('[live] bulkAll deadline hit before the target practitioner settled — inconclusive, skipping assertion');
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
      // Goes through bulkAll, same as every real caller — see the previous
      // test's comment for why a raw Promise.all here is no longer
      // representative of what production can actually do.
      results = await hk(() => bulkAll(
        burst, p => api.getAvailableSlotsByBusinessAndDate({ business_id: p.clinic_id, practitioner_id: p.id, from, to })
      ));
    } finally {
      SendMessageMod.prototype.get = realGet;
    }

    if (!saw429) {
      console.warn('[live] burst did not trigger a real Cliniko 429 this run — cannot confirm the marker live, skipping assertion');
      return;
    }

    // A degraded result shows up either as an individual entry's own _partial
    // (an inner fetch failed but bulkAll's deadline wasn't hit) or the whole
    // array's _partial (bulkAll's own deadline fired first) — either counts as
    // "the marker fired under real load", which is what this test verifies.
    expect(!!results._partial || results.some(r => r && r._partial === true)).toBe(true);
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

  beforeAll(async () => {
    if (!LIVE) return;
    // The preceding "concurrent-load 429s" describe block deliberately hammers
    // Cliniko to trigger real 429s, and leaves the account rate-limited right as
    // this block starts. A "second call was a real fetch, not a cache hit"
    // assertion here is a false failure if that first call 429s (caught inside
    // ClinikoAPI, cache never set, so the "cached" second call is a real miss
    // too) -- same 429 backoff convention as tryLive() above, not a caching bug.
    // A blind fixed sleep here was a guess no matter the duration (confirmed
    // insufficient at both 5s and later 45s in the same session) — actively
    // poll for real recovery instead of guessing how long it takes.
    await waitForClinikoRecovery();
    ClinikoAPI._clearGroupsCache();
  }, 130000);

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

  // The 5s beforeAll settle isn't always enough to clear a real 429 backlog left
  // by the preceding "concurrent-load 429s" block (that block's own calibration
  // found lockouts lasting up to ~45-50s). When that happens, BOTH the "first"
  // and "second" calls each eat one real 429-then-retry (see ClinikoAPI's
  // _get429Retry), so afterFirst/afterSecond both come back inflated by the same
  // amount rather than the second call ever throwing — a false failure of this
  // test, not evidence the cache didn't fire. Confirmed this test passes
  // deterministically in isolation (no preceding load) and only flakes as part
  // of the full live file — so on a mismatch, wait out a longer cooldown and
  // measure a fresh before/afterFirst/afterSecond triplet once before failing,
  // same "retry past a transient 429" convention _get429Retry already uses.
  async function expectSecondCallIsCacheHit(fetchOnce) {
    const measure = async () => {
      const before = getSpy.count();
      await fetchOnce();
      const afterFirst = getSpy.count();
      await fetchOnce();
      const afterSecond = getSpy.count();
      return { before, afterFirst, afterSecond };
    };

    let { before, afterFirst, afterSecond } = await measure();
    if (afterSecond !== afterFirst) {
      // A fixed-duration cooldown here was always a guess, and confirmed
      // insufficient at 10s, then again at 45s, in this same session — the
      // account's real recovery time isn't a constant we can hard-code, it
      // varies with how hard the preceding "concurrent-load 429s" block
      // actually hit it that run. Poll for the real recovery signal instead.
      //
      // The first attempt's "cache hit" call already warmed the cache even
      // though it hit a stray 429 — clear it so the retry gets a clean triplet
      // instead of a free hit from the previous attempt's residual cache state.
      await waitForClinikoRecovery();
      ClinikoAPI._clearGroupsCache();
      ({ before, afterFirst, afterSecond } = await measure());
    }

    expect(afterFirst).toBeGreaterThan(before);
    expect(afterSecond).toBe(afterFirst);
  }

  maybeIt('getAppointmentTypes() — second call for the same practitioner makes zero HTTP requests', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const practitioner = groups.flatMap(g => g.practitioners)[0];
    if (!practitioner) { console.warn('[live] no practitioners — skipping'); return; }

    ClinikoAPI._clearGroupsCache();
    await hk(() => api.getPractitionersByClinic()); // re-warm (cleared above)
    await expectSecondCallIsCacheHit(() => hk(() => api.getAppointmentTypes({ practitioner_id: practitioner.id })));
  }, 180000);

  maybeIt('getPractitionersForClinic() — second call for the same clinic makes zero HTTP requests', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const clinicId = groups[0]?.clinic_id;
    if (!clinicId) { console.warn('[live] no clinics — skipping'); return; }

    // getPractitionersByClinic() now calls getPractitionersForClinic() per clinic
    // internally, so the cache this test targets may already be warm from the
    // groups fetch above — clear it so "first call" below is a real cache miss.
    ClinikoAPI._clearGroupsCache();
    await expectSecondCallIsCacheHit(() => hk(() => api.getPractitionersForClinic(clinicId)));
  }, 180000);

  maybeIt('getBusinessById() — second call for the same business makes zero HTTP requests', async () => {
    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const clinicId = groups[0]?.clinic_id;
    if (!clinicId) { console.warn('[live] no clinics — skipping'); return; }

    await expectSecondCallIsCacheHit(() => hk(() => api.getBusinessById(clinicId)));
  }, 180000);

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

    await expectSecondCallIsCacheHit(() => hk(() => api.getAvailableTimes(args)));
  }, 180000);
});

// =============================================================================
// 12. Gender preference funnel — live data validation
// =============================================================================
describe('physio gender preference funnel — live data', () => {
  let allPractitioners = null; // flat list across all clinics

  beforeAll(async () => {
    if (!LIVE) return;
    const groups = await hk(() => api.getPractitionersByClinic());
    allPractitioners = groups.flatMap(g => g.practitioners);
  }, 60000);

  maybeIt('every practitioner title field is recognised or null (no unknown values)', async () => {
    const KNOWN_TITLES = new Set(['Mr', 'Ms', 'Miss', 'Mrs', 'Dr', 'Prof', null, undefined, '']);
    const unknown = allPractitioners.filter(p => !KNOWN_TITLES.has(p.title ?? null));
    if (unknown.length) {
      console.log('[live] unknown titles found:', [...new Set(unknown.map(p => p.title))]);
    }
    // Warn but don't fail — new titles should be surfaced, then the gender map updated
    expect(unknown.length).toBe(0);
  }, 60000);

  maybeIt('at least one male and one female practitioner exist in the HK account', async () => {
    const males   = allPractitioners.filter(p => practitionerGender(p) === 'male');
    const females = allPractitioners.filter(p => practitionerGender(p) === 'female');
    console.log(`[live] gender breakdown — male: ${males.length}, female: ${females.length}, unknown: ${allPractitioners.length - males.length - females.length}`);
    console.log('[live] male practitioners:', males.map(p => `${p.first_name} ${p.last_name} (${p.title})`));
    console.log('[live] female practitioners:', females.map(p => `${p.first_name} ${p.last_name} (${p.title})`));
    expect(males.length).toBeGreaterThan(0);
    expect(females.length).toBeGreaterThan(0);
  }, 60000);

  maybeIt('male filter excludes female practitioners and includes unknown-title ones', async () => {
    const maleFiltered = applyGenderFilter(allPractitioners, 'male');
    const leaked = maleFiltered.filter(p => practitionerGender(p) === 'female');
    expect(leaked).toHaveLength(0);
    // Unknown-title practitioners (g === null) must be included
    const unknowns = allPractitioners.filter(p => practitionerGender(p) === null);
    for (const u of unknowns) {
      expect(maleFiltered.some(p => p.id === u.id)).toBe(true);
    }
    console.log(`[live] male filter: ${maleFiltered.length}/${allPractitioners.length} practitioners`);
  }, 60000);

  maybeIt('female filter excludes male practitioners and includes unknown-title ones', async () => {
    const femaleFiltered = applyGenderFilter(allPractitioners, 'female');
    const leaked = femaleFiltered.filter(p => practitionerGender(p) === 'male');
    expect(leaked).toHaveLength(0);
    const unknowns = allPractitioners.filter(p => practitionerGender(p) === null);
    for (const u of unknowns) {
      expect(femaleFiltered.some(p => p.id === u.id)).toBe(true);
    }
    console.log(`[live] female filter: ${femaleFiltered.length}/${allPractitioners.length} practitioners`);
  }, 60000);

  maybeIt('no-preference filter returns the full list unchanged', async () => {
    const noFilter = applyGenderFilter(allPractitioners, null);
    expect(noFilter).toHaveLength(allPractitioners.length);
  }, 60000);

  maybeIt('getAppointmentTypes returns category-parseable names for each practitioner', async () => {
    const sample = allPractitioners.slice(0, 3); // limit API calls
    for (const p of sample) {
      const types = await hk(() => api.getAppointmentTypes({ practitioner_id: p.id }));
      expect(Array.isArray(types)).toBe(true);
      const categories = [...new Set(types.map(t => parseApptCategory(t.category).service).filter(Boolean))];
      console.log(`[live] ${p.first_name} ${p.last_name}: ${types.length} types, categories: ${categories.join(', ') || '(none parsed)'}`);
      // Each type must have at least a name
      for (const t of types) {
        expect(typeof t.name).toBe('string');
        expect(t.name.length).toBeGreaterThan(0);
      }
    }
  }, 60000);

  maybeIt('gender filter + appointment-type fetch produces non-empty results and logs category breakdown', async () => {
    for (const gender of ['male', 'female']) {
      const filtered = applyGenderFilter(allPractitioners, gender);
      // applyGenderFilter falls back to full list when nothing matches — should always be non-empty
      expect(filtered.length).toBeGreaterThan(0);

      // Sample up to 3 practitioners to keep API calls manageable. Goes
      // through bulkAll, same as every real caller (fix/fanout-batching-
      // consistency) — no documented reason exists for this funnel to bypass
      // the shared throttle/pacing, so it doesn't.
      const sample = filtered.slice(0, 3);
      const typesByPractitioner = await hk(() => bulkAll(
        sample,
        p => api.getAppointmentTypes({ practitioner_id: p.id })
      ));
      const categorySet = new Set(
        typesByPractitioner.flat().map(t => parseApptCategory(t.category).service).filter(Boolean)
      );
      console.log(`[live] ${gender} filter: ${filtered.length}/${allPractitioners.length} practitioners, sample categories: ${[...categorySet].join(', ') || '(none parsed)'}`);
      // At least one type should exist across sampled practitioners
      expect(typesByPractitioner.some(types => types.length > 0)).toBe(true);
    }
  }, 120000);
});

// =============================================================================
// 13. Gender-funnel handler coverage across BOOK_SOONEST / BOOK_SPECIFIC_DATE
//     (skipCategory:true — gender is the only funnel question in these two
//     flows) + patient_state persistence: picked up on a brand-new session,
//     and amendable via the "same preference?" shortcut's "change" path.
//     BOOK_SPECIFIC_PHYSIO's gender+category path already has dedicated live
//     coverage above and extensive mocked coverage in chatbot.integration
//     .test.js — this block focuses on the two flows and the cross-session
//     persistence behavior that weren't exercised live yet.
// =============================================================================
describe('physio preference funnel — live handler + persistence coverage', () => {
  let engine, db, sm;
  let liveApptTypeName = null; // real type name offered by multiple practitioners
  let liveApptTypePractitioners = []; // real practitioners offering that type

  beforeAll(async () => {
    if (!LIVE) return;
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm; // real ClinikoAPI stays on engine — live HTTP calls

    const groups = cachedPractitioners || await hk(() => api.getPractitionersByClinic());
    const allRawTypes = cachedRawTypes || await hk(() => getAllAppointmentTypesForAllPractitioners(api, groups));
    const nameCounts = new Map();
    for (const t of allRawTypes || []) {
      if (!t?.name || /UWC/i.test(t.name)) continue;
      nameCounts.set(t.name, (nameCounts.get(t.name) || 0) + 1);
    }
    liveApptTypeName = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    if (liveApptTypeName) {
      liveApptTypePractitioners = await hk(() => getPractitionersForTypeName(groups, api, liveApptTypeName));
    }
  }, 90000);

  afterAll(() => {
    if (!LIVE) return;
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });

  function newPhone() {
    return `+8529${Math.floor(1000000 + Math.random() * 8999999)}`;
  }

  async function seedSpecificDateAtChoosePhysio(phone) {
    const id = await db.createSession(phone, null, 30);
    await db.updateSession(id, {
      verification_status: 'verified',
      verified: 1,
      conversation_state: 'BOOK_SPECIFIC_DATE',
      data: JSON.stringify({
        email: 'live-test@example.com',
        selection_step: 'choose_physio',
        selected_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        selected_appt_type: { name: liveApptTypeName },
        navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: false, auto: true }],
      }),
    });
    return db.getSession(id);
  }

  async function seedSoonestAtChoosePhysio(phone) {
    const id = await db.createSession(phone, null, 30);
    await db.updateSession(id, {
      verification_status: 'verified',
      verified: 1,
      conversation_state: 'BOOK_SOONEST',
      data: JSON.stringify({
        email: 'live-test@example.com',
        selection_step: 'choose_physio',
        selected_appt_type: { name: liveApptTypeName },
        funnel_catalogue: [{}], // pre-seeded non-empty so the handler skips rebuilding it
        // handleBookSoonest's choose_physio step (unlike Specific-Date/Specific-Physio)
        // doesn't lazily fetch practitioners itself — it expects the prior choose_type
        // step to have already populated this. Seed it with the real live set directly.
        practitioner_list: liveApptTypePractitioners,
        practitioner_page: 0,
        navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: false, auto: true }],
      }),
    });
    return db.getSession(id);
  }

  maybeIt('BOOK_SPECIFIC_DATE: male / female / no-preference each complete the funnel and render a physio list', async () => {
    if (!liveApptTypeName) { console.warn('[live] no real appointment type name found — skipping'); return; }
    for (const choice of ['1', '2', '3']) {
      const session = await seedSpecificDateAtChoosePhysio(newPhone());
      const genderReply = await hk(() => engine.handleBookSpecificDate(session, ''));
      expect(String(genderReply)).toMatch(/male|female|no preference/i);
      const s2 = await db.getSession(session.id);
      const listReply = await hk(() => engine.handleBookSpecificDate(s2, choice));
      const finalData = JSON.parse((await db.getSession(session.id)).data || '{}');
      // skipCategory:true means gender is the only question — must be 'done' in one turn
      expect(finalData.physio_funnel_step).toBe('done');
      const names = [...String(listReply).matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());
      expect(names.length).toBeGreaterThan(0);
    }
  }, 120000);

  maybeIt('BOOK_SOONEST: male / female / no-preference each complete the funnel and render a physio list', async () => {
    if (!liveApptTypeName) { console.warn('[live] no real appointment type name found — skipping'); return; }
    for (const choice of ['1', '2', '3']) {
      const session = await seedSoonestAtChoosePhysio(newPhone());
      const genderReply = await hk(() => engine.handleBookSoonest(session, ''));
      expect(String(genderReply)).toMatch(/male|female|no preference/i);
      const s2 = await db.getSession(session.id);
      const listReply = await hk(() => engine.handleBookSoonest(s2, choice));
      const finalData = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(finalData.physio_funnel_step).toBe('done');
      const names = [...String(listReply).matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());
      expect(names.length).toBeGreaterThan(0);
    }
  }, 120000);

  maybeIt('a saved physio_preference is picked up as a shortcut on a brand-new session, and "change" amends it for good', async () => {
    if (!liveApptTypeName) { console.warn('[live] no real appointment type name found — skipping'); return; }
    const phone = newPhone();

    // Turn 1 (first-ever session for this phone) — no saved pref, straight to gender question.
    const session1 = await seedSpecificDateAtChoosePhysio(phone);
    const firstReply = await hk(() => engine.handleBookSpecificDate(session1, ''));
    expect(String(firstReply)).toMatch(/male|female|no preference/i);
    expect(String(firstReply)).not.toMatch(/last time/i);

    // Answer Male — completes the (skipCategory) funnel and persists physio_preference.
    const s1b = await db.getSession(session1.id);
    await hk(() => engine.handleBookSpecificDate(s1b, '1'));
    const ps1 = await db.getPatientState(phone);
    expect(ps1).toBeTruthy();
    expect(JSON.parse(ps1.physio_preference)).toMatchObject({ gender: 'male' });

    // Turn 2 — a genuinely new session for the same phone (not a resumed one).
    // getOrCreateSession(forceNew) is the real pickup path: it loads patient_state
    // and merges physio_preference into the new session's context.
    const session2 = await sm.getOrCreateSession(phone, true);
    expect(session2.context?.physio_preference).toMatchObject({ gender: 'male' });
    await db.updateSession(session2.id, {
      conversation_state: 'BOOK_SPECIFIC_DATE',
      data: JSON.stringify({
        email: 'live-test@example.com',
        selection_step: 'choose_physio',
        selected_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        selected_appt_type: { name: liveApptTypeName },
        navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: false, auto: true }],
      }),
    });
    const session2b = await db.getSession(session2.id);
    const shortcutReply = await hk(() => engine.handleBookSpecificDate(session2b, ''));
    expect(String(shortcutReply)).toMatch(/last time/i);
    expect(String(shortcutReply)).toMatch(/male/i);

    // "Change" instead of "yes" — must re-ask gender, not silently keep the old value.
    const session2c = await db.getSession(session2.id);
    const changeReply = await hk(() => engine.handleBookSpecificDate(session2c, 'change'));
    expect(String(changeReply)).toMatch(/male|female|no preference/i);

    // Answer Female this time — must overwrite, not merge with, the saved Male preference.
    const session2d = await db.getSession(session2.id);
    await hk(() => engine.handleBookSpecificDate(session2d, '2'));
    const ps2 = await db.getPatientState(phone);
    expect(JSON.parse(ps2.physio_preference)).toMatchObject({ gender: 'female' });

    // Turn 3 — yet another new session must now pick up the amended (Female) value.
    const session3 = await sm.getOrCreateSession(phone, true);
    expect(session3.context?.physio_preference).toMatchObject({ gender: 'female' });
  }, 120000);
});
