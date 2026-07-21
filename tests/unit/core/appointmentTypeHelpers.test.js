'use strict';

jest.mock('../../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    child: function () { return this; },
  }))
);
jest.mock('../../../src/api/SendMessage');
jest.mock('../../../src/core/DatabaseManager', () => {
  return jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(true),
    getSession: jest.fn().mockResolvedValue(null),
    createSession: jest.fn().mockResolvedValue('session-id'),
    updateSession: jest.fn().mockResolvedValue(true),
    close: jest.fn(),
  }));
});

const {
  getAllAppointmentTypesForAllPractitioners,
  getPractitionersForType,
  getPractitionersForTypeName,
  parseApptCategory,
  parseApptPatientType,
  buildFunnelCatalogue,
  resolveApptFromFunnel,
} = require('../../../src/core/_appointmentTypeHelpers');

// Minimal mock of clinikoAPI — only getAppointmentTypes is needed here
function makeAPI(typesMap) {
  return {
    getAppointmentTypes: jest.fn(({ practitioner_id }) =>
      Promise.resolve(typesMap[practitioner_id] || [])
    ),
  };
}

const GROUP_AB = [
  {
    clinic_id: 'c1', clinic_name: 'Clinic A',
    practitioners: [{ id: 'p1', first_name: 'Alice' }, { id: 'p2', first_name: 'Bob' }],
  },
  {
    clinic_id: 'c2', clinic_name: 'Clinic B',
    practitioners: [{ id: 'p3', first_name: 'Carol' }],
  },
];

// ─── getAllAppointmentTypesForAllPractitioners ─────────────────────────────────

describe('getAllAppointmentTypesForAllPractitioners()', () => {
  test('returns deduplicated union of all types across practitioners', async () => {
    const api = makeAPI({
      p1: [{ id: 't1', name: 'Initial' }, { id: 't2', name: 'Follow-Up' }],
      p2: [{ id: 't2', name: 'Follow-Up' }, { id: 't3', name: 'Massage' }],
      p3: [{ id: 't1', name: 'Initial' }],
    });

    const result = await getAllAppointmentTypesForAllPractitioners(api, GROUP_AB);

    expect(result.map(t => t.id)).toEqual(['t1', 't2', 't3']);
    expect(api.getAppointmentTypes).toHaveBeenCalledTimes(3);
  });

  test('fires all practitioner fetches concurrently before any resolves', async () => {
    const callOrder = [];
    const resolvers = [];
    const api = {
      getAppointmentTypes: jest.fn(({ practitioner_id }) => {
        callOrder.push(practitioner_id);
        return new Promise(resolve => resolvers.push(resolve));
      }),
    };

    const resultPromise = getAllAppointmentTypesForAllPractitioners(api, GROUP_AB);
    await new Promise(r => setImmediate(r));

    // All 3 fetches must have started before any resolved
    expect(callOrder).toEqual(['p1', 'p2', 'p3']);

    resolvers.forEach(r => r([]));
    await resultPromise;
  });

  // Regression: firing every practitioner's fetch at once used to overwhelm
  // Cliniko's gateway and cascade into mass 15s timeouts (confirmed live
  // 2026-07-21). Concurrency is now throttled centrally in SendMessage's
  // bulk queue (see tests/unit/api/SendMessage.test.js) rather than by
  // batching the caller's array — this just confirms the fan-out actually
  // flags itself as bulk so that throttling engages, using a fake clinikoAPI
  // that reports whether BulkContext saw it as bulk while running.
  test('flags the fanout as bulk so SendMessage throttles it, regardless of clinikoAPI implementation', async () => {
    const BulkContext = require('../../../src/core/BulkContext');
    const sawBulk = [];
    const api = {
      getAppointmentTypes: jest.fn(({ practitioner_id }) => {
        sawBulk.push(BulkContext.isBulk());
        return Promise.resolve([{ id: `t-${practitioner_id}`, name: 'X' }]);
      }),
    };

    expect(BulkContext.isBulk()).toBe(false); // sanity: not bulk outside the call
    await getAllAppointmentTypesForAllPractitioners(api, GROUP_AB);

    expect(sawBulk).toEqual([true, true, true]); // one per practitioner in GROUP_AB
    expect(BulkContext.isBulk()).toBe(false); // flag doesn't leak outside the call
  });

  test('returns [] for empty groups', async () => {
    const api = makeAPI({});
    const result = await getAllAppointmentTypesForAllPractitioners(api, []);
    expect(result).toEqual([]);
  });

  test('skips null/undefined types entries gracefully', async () => {
    const api = makeAPI({ p1: null });
    // getAppointmentTypes returning null — guard handles it
    api.getAppointmentTypes = jest.fn().mockResolvedValue(null);
    const result = await getAllAppointmentTypesForAllPractitioners(api, [
      { clinic_id: 'c1', clinic_name: 'C', practitioners: [{ id: 'p1' }] },
    ]);
    expect(result).toEqual([]);
  });
});

// ─── getPractitionersForType ──────────────────────────────────────────────────

describe('getPractitionersForType()', () => {
  test('returns only practitioners offering the given type ID', async () => {
    const api = makeAPI({
      p1: [{ id: 't1', name: 'Initial' }],
      p2: [{ id: 't2', name: 'Follow-Up' }],
      p3: [{ id: 't1', name: 'Initial' }],
    });

    const result = await getPractitionersForType(GROUP_AB, api, 't1');

    expect(result.map(p => p.id)).toEqual(['p1', 'p3']);
  });

  test('deduplicates practitioners who appear in multiple groups', async () => {
    const groups = [
      { clinic_id: 'c1', clinic_name: 'A', practitioners: [{ id: 'p1', first_name: 'Alice' }] },
      { clinic_id: 'c2', clinic_name: 'B', practitioners: [{ id: 'p1', first_name: 'Alice' }] },
    ];
    const api = makeAPI({ p1: [{ id: 't1', name: 'Initial' }] });

    const result = await getPractitionersForType(groups, api, 't1');

    expect(result).toHaveLength(1);
    expect(api.getAppointmentTypes).toHaveBeenCalledTimes(1); // fetched once despite appearing twice
  });

  test('matches type IDs coerced to string', async () => {
    const api = makeAPI({ p1: [{ id: 99, name: 'Initial' }] }); // numeric ID from Cliniko
    const groups = [{ clinic_id: 'c1', clinic_name: 'C', practitioners: [{ id: 'p1' }] }];

    const result = await getPractitionersForType(groups, api, '99'); // string ID from caller

    expect(result).toHaveLength(1);
  });

  test('returns [] when no practitioners match', async () => {
    const api = makeAPI({ p1: [{ id: 't2', name: 'Massage' }] });
    const groups = [{ clinic_id: 'c1', clinic_name: 'C', practitioners: [{ id: 'p1' }] }];

    const result = await getPractitionersForType(groups, api, 't1');

    expect(result).toEqual([]);
  });
});

// ─── getPractitionersForTypeName ──────────────────────────────────────────────

describe('getPractitionersForTypeName()', () => {
  test('returns practitioners whose type name matches (case-insensitive)', async () => {
    const api = makeAPI({
      p1: [{ id: 't1', name: 'Initial Consultation' }],
      p2: [{ id: 't2', name: 'Massage' }],
      p3: [{ id: 't3', name: 'INITIAL CONSULTATION' }],
    });

    const result = await getPractitionersForTypeName(GROUP_AB, api, 'initial consultation');

    expect(result.map(p => p.id)).toEqual(['p1', 'p3']);
  });

  test('normalises hyphen variants — Cliniko hyphen matches user space', async () => {
    const api = makeAPI({
      p1: [{ id: 't1', name: 'Follow-Up Appointment' }], // Cliniko uses hyphen
    });
    const groups = [{ clinic_id: 'c1', clinic_name: 'C', practitioners: [{ id: 'p1' }] }];

    const result = await getPractitionersForTypeName(groups, api, 'Follow Up Appointment');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
  });

  test('deduplicates practitioners appearing in multiple groups', async () => {
    const groups = [
      { clinic_id: 'c1', clinic_name: 'A', practitioners: [{ id: 'p1' }] },
      { clinic_id: 'c2', clinic_name: 'B', practitioners: [{ id: 'p1' }] },
    ];
    const api = makeAPI({ p1: [{ id: 't1', name: 'Initial' }] });

    const result = await getPractitionersForTypeName(groups, api, 'Initial');

    expect(result).toHaveLength(1);
    expect(api.getAppointmentTypes).toHaveBeenCalledTimes(1);
  });

  test('returns [] when no practitioners match', async () => {
    const api = makeAPI({ p1: [{ id: 't1', name: 'Massage' }] });
    const groups = [{ clinic_id: 'c1', clinic_name: 'C', practitioners: [{ id: 'p1' }] }];

    const result = await getPractitionersForTypeName(groups, api, 'Initial');

    expect(result).toEqual([]);
  });
});

// ─── Partial-failure tolerance ─────────────────────────────────────────────
// Regression: these three used to reject the whole lookup if any one
// practitioner's fetch failed, crashing the caller (ultimately surfacing as
// handleMessageEnvelope's generic "unexpected error" reply) instead of
// degrading to the practitioners that did resolve. Each fan-out now catches
// per-call, excludes the failed practitioner from the result, and marks the
// result _partial so callers can tell a real "none" apart from "incomplete."

describe('partial-failure tolerance — one practitioner fetch fails', () => {
  const groups = [{ clinic_id: 'c1', clinic_name: 'C', practitioners: [{ id: 'p1' }, { id: 'p2' }] }];

  test('getAllAppointmentTypesForAllPractitioners excludes the failed practitioner, marks result _partial', async () => {
    const api = {
      getAppointmentTypes: jest.fn()
        .mockResolvedValueOnce([{ id: 't1', name: 'Initial' }])
        .mockRejectedValueOnce(new Error('Cliniko 429')),
    };

    const result = await getAllAppointmentTypesForAllPractitioners(api, groups);

    expect(result).toEqual([{ id: 't1', name: 'Initial' }]);
    expect(result._partial).toBe(true);
  });

  test('getPractitionersForType excludes the failed practitioner, marks result _partial', async () => {
    const api = {
      getAppointmentTypes: jest.fn()
        .mockResolvedValueOnce([{ id: 't1', name: 'Initial' }])
        .mockRejectedValueOnce(new Error('network error')),
    };

    const result = await getPractitionersForType(groups, api, 't1');

    expect(result.map(p => p.id)).toEqual(['p1']);
    expect(result._partial).toBe(true);
  });

  test('getPractitionersForTypeName excludes the failed practitioner, marks result _partial', async () => {
    const api = {
      getAppointmentTypes: jest.fn()
        .mockResolvedValueOnce([{ id: 't1', name: 'Initial' }])
        .mockRejectedValueOnce(new Error('timeout')),
    };

    const result = await getPractitionersForTypeName(groups, api, 'Initial');

    expect(result.map(p => p.id)).toEqual(['p1']);
    expect(result._partial).toBe(true);
  });

  test('no failures — result is not marked _partial', async () => {
    const api = {
      getAppointmentTypes: jest.fn().mockResolvedValue([{ id: 't1', name: 'Initial' }]),
    };

    const result = await getAllAppointmentTypesForAllPractitioners(api, groups);

    expect(result._partial).toBeUndefined();
  });
});

// ─── parseApptCategory ────────────────────────────────────────────────────────

describe('parseApptCategory()', () => {
  test('self-pay format (no " : ") → insurer null, full string as service', () => {
    expect(parseApptCategory('Physiotherapy')).toEqual({ insurer: null, service: 'Physiotherapy' });
  });

  test('insured format "Insurer : Service" → splits on first " : "', () => {
    expect(parseApptCategory('Bupa Global : Physiotherapy')).toEqual({
      insurer: 'Bupa Global',
      service: 'Physiotherapy',
    });
  });

  test('insured with extra spaces around " : " → trims both parts', () => {
    expect(parseApptCategory('  Cigna  :  Sports Massage  ')).toEqual({
      insurer: 'Cigna',
      service: 'Sports Massage',
    });
  });

  test('service name that contains " : " keeps only first split', () => {
    // Hypothetical: "Insurer : A : B" — insurer is "Insurer", service is "A : B"
    expect(parseApptCategory('April : Clinical Pilates : Advanced')).toEqual({
      insurer: 'April',
      service: 'Clinical Pilates : Advanced',
    });
  });

  test('null input → insurer null, service empty string', () => {
    expect(parseApptCategory(null)).toEqual({ insurer: null, service: '' });
  });

  test('undefined input → insurer null, service empty string', () => {
    expect(parseApptCategory(undefined)).toEqual({ insurer: null, service: '' });
  });

  test('empty string → insurer null, service empty string', () => {
    expect(parseApptCategory('')).toEqual({ insurer: null, service: '' });
  });
});

// ─── parseApptPatientType ─────────────────────────────────────────────────────

describe('parseApptPatientType()', () => {
  test('"New Patient" → "new"', () => {
    expect(parseApptPatientType('New Patient 60 Min')).toBe('new');
  });

  test('"new patient" (lowercase) → "new"', () => {
    expect(parseApptPatientType('new patient initial')).toBe('new');
  });

  test('"NewPatient" (no space) → "new"', () => {
    expect(parseApptPatientType('NewPatient')).toBe('new');
  });

  test('"Follow-Up" → "follow_up"', () => {
    expect(parseApptPatientType('Follow-Up 40 Min')).toBe('follow_up');
  });

  test('"Follow Up" (space instead of hyphen) → "follow_up"', () => {
    expect(parseApptPatientType('Follow Up Visit')).toBe('follow_up');
  });

  test('"FOLLOW-UP" (uppercase) → "follow_up"', () => {
    expect(parseApptPatientType('FOLLOW-UP')).toBe('follow_up');
  });

  test('generic name with no patient type marker → null', () => {
    expect(parseApptPatientType('Physiotherapy 60 Min')).toBeNull();
  });

  test('null input → null', () => {
    expect(parseApptPatientType(null)).toBeNull();
  });

  test('empty string → null', () => {
    expect(parseApptPatientType('')).toBeNull();
  });
});

// ─── buildFunnelCatalogue ────────────────────────────────────────────────────

describe('buildFunnelCatalogue()', () => {
  const selfPayPhysio = { id: 1, name: 'New Patient 60 Min', category: 'Physiotherapy', duration_in_minutes: 60 };
  const bupaFollowUp = { id: 2, name: 'Follow-Up 40 Min', category: 'Bupa Global : Physiotherapy', duration_in_minutes: 40 };
  const onlineBooking = { id: 3, name: 'Online Booking', category: 'Physiotherapy', duration_in_minutes: 60 };
  const uwcType      = { id: 4, name: 'UWC New Patient', category: 'Physiotherapy', duration_in_minutes: 60 };
  const massageNew   = { id: 5, name: 'New Patient 60 Min', category: 'Sports Massage Therapy', duration_in_minutes: 60 };

  test('maps self-pay type correctly', () => {
    const [entry] = buildFunnelCatalogue([selfPayPhysio]);
    expect(entry).toEqual({
      id: '1',
      name: 'New Patient 60 Min',
      service: 'Physiotherapy',
      insurer: null,
      patientType: 'new',
      duration: 60,
    });
  });

  test('maps insured type correctly — insurer extracted from category', () => {
    const [entry] = buildFunnelCatalogue([bupaFollowUp]);
    expect(entry).toEqual({
      id: '2',
      name: 'Follow-Up 40 Min',
      service: 'Physiotherapy',
      insurer: 'Bupa Global',
      patientType: 'follow_up',
      duration: 40,
    });
  });

  test('filters out "Online Booking" types', () => {
    const result = buildFunnelCatalogue([selfPayPhysio, onlineBooking]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  test('filters out UWC types (case-insensitive)', () => {
    const result = buildFunnelCatalogue([selfPayPhysio, uwcType]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  test('IDs are coerced to string', () => {
    const [entry] = buildFunnelCatalogue([selfPayPhysio]);
    expect(typeof entry.id).toBe('string');
  });

  test('names with extra whitespace are normalised', () => {
    const raw = { id: 10, name: '  New  Patient  60 Min  ', category: 'Physiotherapy', duration_in_minutes: 60 };
    const [entry] = buildFunnelCatalogue([raw]);
    expect(entry.name).toBe('New Patient 60 Min');
  });

  test('keeps multiple types with same name but different services', () => {
    const result = buildFunnelCatalogue([selfPayPhysio, massageNew]);
    expect(result).toHaveLength(2);
    expect(result.map(t => t.service)).toEqual(['Physiotherapy', 'Sports Massage Therapy']);
  });

  test('null/undefined entries in array are skipped', () => {
    const result = buildFunnelCatalogue([null, selfPayPhysio, undefined]);
    expect(result).toHaveLength(1);
  });

  test('empty array → []', () => {
    expect(buildFunnelCatalogue([])).toEqual([]);
  });

  test('null input → []', () => {
    expect(buildFunnelCatalogue(null)).toEqual([]);
  });
});

// ─── resolveApptFromFunnel ────────────────────────────────────────────────────

describe('resolveApptFromFunnel()', () => {
  const catalogue = [
    { id: '1', name: 'New Patient 60 Min', service: 'Physiotherapy', insurer: null,          patientType: 'new',       duration: 60 },
    { id: '2', name: 'Follow-Up 40 Min',   service: 'Physiotherapy', insurer: null,          patientType: 'follow_up', duration: 40 },
    { id: '3', name: 'Follow-Up 60 Min',   service: 'Physiotherapy', insurer: null,          patientType: 'follow_up', duration: 60 },
    { id: '4', name: 'Follow-Up 40 Min',   service: 'Physiotherapy', insurer: 'Bupa Global', patientType: 'follow_up', duration: 40 },
    // Two entries for the same type across different practitioners (same name+attrs, different ID)
    { id: '5', name: 'New Patient 60 Min', service: 'Physiotherapy', insurer: null,          patientType: 'new',       duration: 60 },
  ];

  test('exact match on all four dimensions → returns name, ids, norm_name', () => {
    const result = resolveApptFromFunnel(catalogue, {
      service: 'Physiotherapy', patientType: 'new', insurer: null, duration: 60,
    });
    expect(result).toEqual({
      name: 'New Patient 60 Min',
      ids: ['1', '5'],
      norm_name: 'new patient 60 min',
    });
  });

  test('collects all IDs for matching entries (one per practitioner)', () => {
    const result = resolveApptFromFunnel(catalogue, {
      service: 'Physiotherapy', patientType: 'new', insurer: null, duration: 60,
    });
    expect(result.ids).toEqual(['1', '5']);
  });

  test('deduplicates IDs that appear more than once', () => {
    const dupe = [
      { id: '99', name: 'Test', service: 'Physio', insurer: null, patientType: 'new', duration: 60 },
      { id: '99', name: 'Test', service: 'Physio', insurer: null, patientType: 'new', duration: 60 },
    ];
    const result = resolveApptFromFunnel(dupe, { service: 'Physio', patientType: 'new', insurer: null, duration: 60 });
    expect(result.ids).toEqual(['99']);
  });

  test('insured match only returns types with matching insurer', () => {
    const result = resolveApptFromFunnel(catalogue, {
      service: 'Physiotherapy', patientType: 'follow_up', insurer: 'Bupa Global', duration: 40,
    });
    expect(result).not.toBeNull();
    expect(result.ids).toEqual(['4']);
  });

  test('self-pay match does not bleed into insured types', () => {
    const result = resolveApptFromFunnel(catalogue, {
      service: 'Physiotherapy', patientType: 'follow_up', insurer: null, duration: 40,
    });
    expect(result.ids).toEqual(['2']);
  });

  test('no match → null', () => {
    const result = resolveApptFromFunnel(catalogue, {
      service: 'Physiotherapy', patientType: 'new', insurer: null, duration: 80,
    });
    expect(result).toBeNull();
  });

  test('wrong service → null', () => {
    const result = resolveApptFromFunnel(catalogue, {
      service: 'Sports Massage Therapy', patientType: 'new', insurer: null, duration: 60,
    });
    expect(result).toBeNull();
  });

  test('norm_name is lowercase trimmed', () => {
    const result = resolveApptFromFunnel(catalogue, {
      service: 'Physiotherapy', patientType: 'new', insurer: null, duration: 60,
    });
    expect(result.norm_name).toBe('new patient 60 min');
  });

  // Regression: norm_name used to keep hyphens while every other normalizer
  // in the codebase (normalizeTypeName, this file's getPractitionersForTypeName)
  // strips them to spaces. handleBookSoonest compares this norm_name directly
  // against slot type names run through the hyphen-stripping normalizer, so a
  // hyphenated raw Cliniko name (e.g. "Follow-Up Appointment-Physiotherapy")
  // never matched — silently reporting "no slots" despite real availability
  // (confirmed live 2026-07-21/22).
  test('norm_name strips hyphens the same way normalizeTypeName does', () => {
    const hyphenated = [
      { id: '9', name: 'Follow-Up Appointment-Physiotherapy', service: 'Physiotherapy', insurer: null, patientType: 'follow_up', duration: 40 },
    ];
    const result = resolveApptFromFunnel(hyphenated, {
      service: 'Physiotherapy', patientType: 'follow_up', insurer: null, duration: 40,
    });
    expect(result.norm_name).toBe('follow up appointment physiotherapy');
  });

  test('empty catalogue → null', () => {
    expect(resolveApptFromFunnel([], { service: 'X', patientType: 'new', insurer: null, duration: 60 })).toBeNull();
  });
});
