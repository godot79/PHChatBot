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

// ─── getAppointmentTypes rejection behaviour ──────────────────────────────────
// Documents the current fast-fail behaviour: if one practitioner's fetch rejects,
// the whole Promise.all rejects and propagates up to the handler (and ultimately
// to handleMessageEnvelope's catch block). No partial results are returned.

describe('rejection propagation — current fast-fail behaviour', () => {
  const groups = [{ clinic_id: 'c1', clinic_name: 'C', practitioners: [{ id: 'p1' }, { id: 'p2' }] }];

  test('getAllAppointmentTypesForAllPractitioners rejects when one fetch fails', async () => {
    const api = {
      getAppointmentTypes: jest.fn()
        .mockResolvedValueOnce([{ id: 't1', name: 'Initial' }])
        .mockRejectedValueOnce(new Error('Cliniko 429')),
    };

    await expect(getAllAppointmentTypesForAllPractitioners(api, groups))
      .rejects.toThrow('Cliniko 429');
  });

  test('getPractitionersForType rejects when one fetch fails', async () => {
    const api = {
      getAppointmentTypes: jest.fn()
        .mockResolvedValueOnce([{ id: 't1', name: 'Initial' }])
        .mockRejectedValueOnce(new Error('network error')),
    };

    await expect(getPractitionersForType(groups, api, 't1'))
      .rejects.toThrow('network error');
  });

  test('getPractitionersForTypeName rejects when one fetch fails', async () => {
    const api = {
      getAppointmentTypes: jest.fn()
        .mockResolvedValueOnce([{ id: 't1', name: 'Initial' }])
        .mockRejectedValueOnce(new Error('timeout')),
    };

    await expect(getPractitionersForTypeName(groups, api, 'Initial'))
      .rejects.toThrow('timeout');
  });
});
