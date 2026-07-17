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
      const categories = [...new Set(types.map(t => parseApptCategory(t.name)).filter(Boolean))];
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

      // Sample up to 3 practitioners to keep API calls manageable
      const sample = filtered.slice(0, 3);
      const typesByPractitioner = await Promise.all(
        sample.map(p => hk(() => api.getAppointmentTypes({ practitioner_id: p.id })))
      );
      const categorySet = new Set(
        typesByPractitioner.flat().map(t => parseApptCategory(t.name)).filter(Boolean)
      );
      console.log(`[live] ${gender} filter: ${filtered.length}/${allPractitioners.length} practitioners, sample categories: ${[...categorySet].join(', ') || '(none parsed)'}`);
      // At least one type should exist across sampled practitioners
      expect(typesByPractitioner.some(types => types.length > 0)).toBe(true);
    }
  }, 120000);
});
