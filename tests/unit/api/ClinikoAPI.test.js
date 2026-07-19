'use strict';

jest.mock('../../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info:  () => {},
    warn:  () => {},
    error: () => {},
    debug: () => {},
  }))
);

jest.mock('../../../src/api/SendMessage');
const SendMessage = require('../../../src/api/SendMessage');

const RegionContext = require('../../../src/core/RegionContext');
const ClinikoAPI = require('../../../src/api/ClinikoAPI');

describe('ClinikoAPI', () => {
  let api;
  let mockGet;
  let mockPost;

  beforeEach(() => {
    ClinikoAPI._clearGroupsCache();
    mockGet  = jest.fn();
    mockPost = jest.fn();
    SendMessage.mockImplementation(() => ({ get: mockGet, post: mockPost }));
    api = new ClinikoAPI();
  });

  // ─── getClinics ────────────────────────────────────────────────────────────

  describe('getClinics()', () => {
    test('returns only non-UWC, non-Physiofocus clinics', async () => {
      mockGet.mockResolvedValue({
        businesses: [
          { id: '1', business_name: 'Prohealth In Touch Physiotherapy' },
          { id: '2', business_name: 'UWC East'                         },
          { id: '3', business_name: 'Prohealth Physiofocus Pte Ltd'    },
          { id: '4', business_name: 'Prohealth Novena'                 },
        ],
      });

      const result = await api.getClinics();

      expect(result).toHaveLength(2);
      expect(result.map(c => c.id)).toEqual(['1', '4']);
    });

    test('returns [] when SendMessage throws', async () => {
      mockGet.mockRejectedValue(new Error('network error'));
      const result = await api.getClinics();
      expect(result).toEqual([]);
    });
  });

  // ─── findPatientByEmailAndDob ──────────────────────────────────────────────

  describe('findPatientByEmailAndDob()', () => {
    const patient = { id: '42', email: 'test@example.com', date_of_birth: '1990-01-15' };

    test('returns patient when email + DOB match on first call', async () => {
      mockGet.mockResolvedValue({ patients: [patient] });

      const result = await api.findPatientByEmailAndDob('test@example.com', '1990-01-15');

      expect(result).toEqual(patient);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    test('falls back to email-only search when DOB is null', async () => {
      mockGet.mockResolvedValue({ patients: [patient] });

      const result = await api.findPatientByEmailAndDob('test@example.com', null);

      expect(result).toEqual(patient);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    test('performs client-side DOB filter when first call returns no match', async () => {
      // First call (email+DOB): API returns empty (tenant ignores DOB filter)
      // Second call (email-only): returns the patient — client filters by DOB
      mockGet
        .mockResolvedValueOnce({ patients: [] })
        .mockResolvedValueOnce({ patients: [patient] });

      const result = await api.findPatientByEmailAndDob('test@example.com', '1990-01-15');

      expect(result).toEqual(patient);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    test('returns null when email not found', async () => {
      mockGet.mockResolvedValue({ patients: [] });

      const result = await api.findPatientByEmailAndDob('nobody@example.com', null);

      expect(result).toBeNull();
    });
  });

  // ─── bookAppointment ───────────────────────────────────────────────────────

  describe('bookAppointment()', () => {
    const validArgs = {
      patient_id:           '10',
      practitioner_id:      '20',
      business_id:          '30',
      appointment_type_id:  '40',
      starts_at:            '2025-09-01T09:00:00Z',
    };

    test('returns {success: false} without making an HTTP call when a required field is missing', async () => {
      const { starts_at: _omit, ...missing } = validArgs;

      const result = await api.bookAppointment(missing);

      expect(result).toEqual({ success: false, message: 'Missing required field for booking.' });
      expect(mockPost).not.toHaveBeenCalled();
    });

    test('posts correct payload and returns {success: true} on success', async () => {
      const appointment = { id: '999', starts_at: validArgs.starts_at };
      mockPost.mockResolvedValue(appointment);

      const result = await api.bookAppointment(validArgs);

      expect(result).toEqual({ success: true, appointment });
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith(expect.objectContaining({
        patient_id:          '10',
        practitioner_id:     '20',
        business_id:         '30',
        appointment_type_id: '40',
        starts_at:           validArgs.starts_at,
      }));
    });

    test('returns {success: false} when SendMessage throws', async () => {
      mockPost.mockRejectedValue(new Error('Cliniko error'));

      const result = await api.bookAppointment(validArgs);

      expect(result).toEqual({ success: false, message: 'Failed to book appointment.' });
    });
  });

  // ─── cancelSpecificAppointment ─────────────────────────────────────────────

  describe('cancelSpecificAppointment()', () => {
    let mockPatch;

    beforeEach(() => {
      mockPatch = jest.fn();
      SendMessage.mockImplementation(() => ({ get: mockGet, post: mockPost, patch: mockPatch }));
      api = new ClinikoAPI();
    });

    test('PATCH to correct endpoint and returns {success: true}', async () => {
      mockPatch.mockResolvedValue({});

      const result = await api.cancelSpecificAppointment('123');

      expect(result).toEqual({ success: true, appointmentId: '123' });
      expect(mockPatch).toHaveBeenCalledTimes(1);
      expect(mockPatch).toHaveBeenCalledWith(
        expect.objectContaining({ cancellation_note: 'Cancelled via chatbot' })
      );
    });

    test('sends cancellation_reason in payload', async () => {
      mockPatch.mockResolvedValue({});

      await api.cancelSpecificAppointment('123');

      const payload = mockPatch.mock.calls[0][0];
      expect(payload).toHaveProperty('cancellation_reason', 50);
    });

    test('returns {success: false} when PATCH throws', async () => {
      mockPatch.mockRejectedValue({ status: 422, error: 'invalid' });

      const result = await api.cancelSpecificAppointment('123');

      expect(result.success).toBe(false);
    });
  });

  // ─── getClinics exclusion pattern ─────────────────────────────────────────

  describe('getClinics() exclusion — all PhysioFocus name variants', () => {
    const variants = [
      'Prohealth Physiofocus Pte Ltd',
      'Prohealth Physio Focus',
      'PhysioFocus Singapore',
      'physio  focus',
      'PHYSIOFOCUS',
    ];

    test.each(variants)('excludes clinic named "%s"', async (name) => {
      mockGet.mockResolvedValue({ businesses: [{ id: '1', business_name: name }] });
      const result = await api.getClinics();
      expect(result).toHaveLength(0);
    });
  });

  // ─── getBookingsByPatientId — single definition ────────────────────────────

  describe('getBookingsByPatientId()', () => {
    test('fetches from individual_appointments endpoint with patient_id filter', async () => {
      SendMessage.mockClear(); // start fresh so prior test calls do not pollute
      mockGet.mockResolvedValue({ individual_appointments: [] });

      const result = await api.getBookingsByPatientId('42', { when: 'past' });

      expect(Array.isArray(result)).toBe(true);
      expect(SendMessage.mock.calls.length).toBeGreaterThan(0);
      const urls = SendMessage.mock.calls.map(c => decodeURIComponent(String(c[0])));
      expect(urls.some(u => u.includes('/individual_appointments') && u.includes('patient_id'))).toBe(true);
    });

    test('deduplicates active + cancelled results by id', async () => {
      const appt = { id: 'X', starts_at: new Date().toISOString() };
      // Active and cancelled calls both return same appointment — should appear once
      mockGet.mockResolvedValue({ individual_appointments: [appt] });

      const result = await api.getBookingsByPatientId('42', { when: 'future', statusMode: 'both' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('X');
    });

    test('returns empty array when API throws', async () => {
      mockGet.mockRejectedValue({ status: 500, error: 'server error' });
      const result = await api.getBookingsByPatientId('42', { when: 'future' });
      expect(result).toEqual([]);
    });
  });

  // ─── getPractitionersByClinic ──────────────────────────────────────────────

  describe('getPractitionersByClinic()', () => {
    test('returns grouped array for all clinics', async () => {
      mockGet
        .mockResolvedValueOnce({
          businesses: [
            { id: 'c1', business_name: 'Clinic A' },
            { id: 'c2', business_name: 'Clinic B' },
          ],
        })
        .mockResolvedValueOnce({ practitioners: [{ id: 'p1' }] })
        .mockResolvedValueOnce({ practitioners: [{ id: 'p2' }] });

      const result = await api.getPractitionersByClinic();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ clinic_id: 'c1', clinic_name: 'Clinic A', practitioners: [{ id: 'p1' }] });
      expect(result[1]).toEqual({ clinic_id: 'c2', clinic_name: 'Clinic B', practitioners: [{ id: 'p2' }] });
    });

    test('dispatches all clinic fetches concurrently before any resolves', async () => {
      mockGet.mockResolvedValueOnce({
        businesses: [
          { id: 'c1', business_name: 'Clinic A' },
          { id: 'c2', business_name: 'Clinic B' },
        ],
      });

      const callOrder = [];
      const resolvers = [];
      mockGet
        .mockImplementationOnce(() => {
          callOrder.push('c1');
          return new Promise(resolve => resolvers.push({ resolve, data: { practitioners: [] } }));
        })
        .mockImplementationOnce(() => {
          callOrder.push('c2');
          return new Promise(resolve => resolvers.push({ resolve, data: { practitioners: [] } }));
        });

      const resultPromise = api.getPractitionersByClinic();
      await new Promise(r => setImmediate(r));

      // Both fetches must have started before either resolved
      expect(callOrder).toEqual(['c1', 'c2']);

      resolvers.forEach(r => r.resolve(r.data));
      await resultPromise;
    });

    test('returns [] when getClinics() throws', async () => {
      mockGet.mockRejectedValue(new Error('network error'));
      const result = await api.getPractitionersByClinic();
      expect(result).toEqual([]);
    });

    // Regression: a transient getClinics() failure (e.g. a 429 during a burst
    // of concurrent availability lookups) must not be cached as a confirmed
    // "zero clinics" result — that poisons every clinic/practitioner lookup
    // for the full GROUPS_CACHE_TTL_MS window, silently masking real
    // availability from callers like handleBookSoonest. See 2026-07-19
    // chatbot-webhook incident: a single rate-limited moment turned into a
    // ~30s outage window where real slots were reported as unavailable.
    test('a failed fetch is not cached — the very next call retries against Cliniko', async () => {
      mockGet.mockRejectedValueOnce(new Error('429 Too Many Requests'));
      const failed = await api.getPractitionersByClinic();
      expect(failed).toEqual([]);

      mockGet
        .mockResolvedValueOnce({ businesses: [{ id: 'c1', business_name: 'Clinic A' }] })
        .mockResolvedValueOnce({ practitioners: [{ id: 'p1' }] });
      const retried = await api.getPractitionersByClinic();

      expect(retried).toHaveLength(1);
      expect(retried[0]).toEqual({ clinic_id: 'c1', clinic_name: 'Clinic A', practitioners: [{ id: 'p1' }] });
    });

    test('returns [] when a clinic practitioner fetch throws', async () => {
      mockGet
        .mockResolvedValueOnce({ businesses: [{ id: 'c1', business_name: 'Clinic A' }] })
        .mockRejectedValueOnce(new Error('timeout'));
      const result = await api.getPractitionersByClinic();
      expect(result).toEqual([]);
    });

    test('returns empty practitioners array when API response has no practitioners key', async () => {
      mockGet
        .mockResolvedValueOnce({ businesses: [{ id: 'c1', business_name: 'Clinic A' }] })
        .mockResolvedValueOnce({});
      const result = await api.getPractitionersByClinic();
      expect(result[0].practitioners).toEqual([]);
    });

    test('cache hit: second call returns same data without any HTTP calls', async () => {
      mockGet
        .mockResolvedValueOnce({ businesses: [{ id: 'c1', business_name: 'Clinic A' }] })
        .mockResolvedValueOnce({ practitioners: [{ id: 'p1' }] });

      const first  = await api.getPractitionersByClinic();
      const second = await api.getPractitionersByClinic();

      expect(second).toBe(first);                // same object reference — cache hit
      expect(mockGet).toHaveBeenCalledTimes(2);  // getClinics + 1 clinic, never re-fetched
    });

    test('cache miss: expired entry triggers a fresh fetch', async () => {
      jest.useFakeTimers();
      mockGet
        .mockResolvedValueOnce({ businesses: [{ id: 'c1', business_name: 'Clinic A' }] })
        .mockResolvedValueOnce({ practitioners: [{ id: 'p1' }] })
        .mockResolvedValueOnce({ businesses: [{ id: 'c1', business_name: 'Clinic A' }] })
        .mockResolvedValueOnce({ practitioners: [{ id: 'p1' }] });

      await api.getPractitionersByClinic();
      jest.advanceTimersByTime(31_000);           // expire the cache entry
      await api.getPractitionersByClinic();

      expect(mockGet).toHaveBeenCalledTimes(4);  // 2 fetches × (getClinics + 1 clinic)
      jest.useRealTimers();
    });

    test('different regions are cached independently', async () => {
      const sgData = [{ id: 'sg1', business_name: 'SG Clinic' }];
      const hkData = [{ id: 'hk1', business_name: 'HK Clinic' }];

      mockGet
        .mockResolvedValueOnce({ businesses: sgData })
        .mockResolvedValueOnce({ practitioners: [] })
        .mockResolvedValueOnce({ businesses: hkData })
        .mockResolvedValueOnce({ practitioners: [] });

      const sgResult = await RegionContext.run('SG', () => api.getPractitionersByClinic());
      const hkResult = await RegionContext.run('HK', () => api.getPractitionersByClinic());

      expect(sgResult[0].clinic_id).toBe('sg1');
      expect(hkResult[0].clinic_id).toBe('hk1');
      expect(mockGet).toHaveBeenCalledTimes(4);  // each region fetched independently
    });
  });

  // ─── getAvailableSlotsByBusinessAndDate — _partial marker ─────────────────
  //
  // Regression: this method silently skips any practitioner/appointment-type
  // combo whose getAvailableTimes() call fails (e.g. a 429 under concurrent
  // load) — that combo just contributes zero slots, indistinguishable from a
  // genuine zero. Callers that treat a short/empty result as confirmed
  // unavailability (as handleBookSoonest's choose_clinic step used to) can
  // then discard valid user state. The array is tagged with a non-enumerable
  // _partial marker whenever this happened, so callers that care can tell
  // "confirmed zero" apart from "some inner fetches failed, so this count may
  // be short" without changing the array's shape for existing consumers.
  describe('getAvailableSlotsByBusinessAndDate() — _partial marker', () => {
    let api;
    let mockGet;

    beforeEach(() => {
      ClinikoAPI._clearGroupsCache();
      mockGet = jest.fn();
      SendMessage.mockImplementation(() => ({ get: mockGet }));
      api = new ClinikoAPI();
      api.getBusinessById = jest.fn().mockResolvedValue({ id: 'BIZ-1', business_name: 'Clinic A' });
      api.getPractitionersForClinic = jest.fn().mockResolvedValue([{ id: 'P1', first_name: 'A', last_name: 'B' }]);
      api.getAppointmentTypes = jest.fn().mockResolvedValue([
        { id: 'AT-1', name: 'Type One' },
        { id: 'AT-2', name: 'Type Two' },
      ]);
    });

    test('all inner fetches succeed → no _partial marker, all slots present', async () => {
      api.getAvailableTimes = jest.fn()
        .mockResolvedValueOnce([{ appointment_start: '2026-08-01T10:00:00Z' }])
        .mockResolvedValueOnce([{ appointment_start: '2026-08-01T11:00:00Z' }]);

      const result = await api.getAvailableSlotsByBusinessAndDate({
        business_id: 'BIZ-1', practitioner_id: 'P1', from: '2026-08-01', to: '2026-08-02',
      });

      expect(result).toHaveLength(2);
      expect(result._partial).toBeUndefined();
    });

    test('one inner fetch fails (e.g. a 429) → _partial marker set, other slots still returned', async () => {
      api.getAvailableTimes = jest.fn()
        .mockResolvedValueOnce([{ appointment_start: '2026-08-01T10:00:00Z' }])
        .mockRejectedValueOnce({ status: 429, message: 'Request failed with status code 429' });

      const result = await api.getAvailableSlotsByBusinessAndDate({
        business_id: 'BIZ-1', practitioner_id: 'P1', from: '2026-08-01', to: '2026-08-02',
      });

      expect(result).toHaveLength(1);          // the successful combo's slot survives
      expect(result._partial).toBe(true);      // but the count may be short — not confirmed zero
    });

    test('_partial is non-enumerable — does not change JSON.stringify or spread behavior', async () => {
      api.getAvailableTimes = jest.fn().mockRejectedValue({ status: 429 });

      const result = await api.getAvailableSlotsByBusinessAndDate({
        business_id: 'BIZ-1', practitioner_id: 'P1', from: '2026-08-01', to: '2026-08-02',
      });

      expect(result._partial).toBe(true);
      expect(JSON.stringify(result)).toBe('[]');   // doesn't leak into serialized session data
      expect([...result]).toEqual([]);             // spread/iteration unaffected
    });
  });
});
