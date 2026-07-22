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

    // Regression: a failed fetch (e.g. a 429) must not read the same as a
    // genuine "zero clinics" response — see handleViewLocationsState, which
    // used to tell the user "No clinic information is currently available"
    // on a transient Cliniko error (2026-07-21 chatbot-webhook incident).
    test('returns [] marked _partial when SendMessage throws', async () => {
      mockGet.mockRejectedValue(new Error('network error'));
      const result = await api.getClinics();
      expect(result).toEqual([]);
      expect(result._partial).toBe(true);
    });

    test('genuine zero clinics (200 response, empty list) is not marked _partial', async () => {
      mockGet.mockResolvedValue({ businesses: [] });
      const result = await api.getClinics();
      expect(result).toEqual([]);
      expect(result._partial).toBeUndefined();
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

    // Regression: a real API failure (429/5xx/network) during patient lookup
    // used to be swallowed to null — identical to "you're not a registered
    // patient". A registered patient hitting a transient Cliniko error during
    // verification would be wrongly told to check their details / re-register,
    // instead of "try again". Genuine non-match (tested above) must still
    // resolve to null, not throw.
    test('genuine non-match still resolves to null, not an error', async () => {
      mockGet.mockResolvedValue({ patients: [] });
      await expect(api.findPatientByEmailAndDob('nobody@example.com', '1990-01-15'))
        .resolves.toBeNull();
    });

    test('throws (does not return null) when the primary lookup fails', async () => {
      mockGet.mockRejectedValue({ status: 429, message: 'Too Many Requests' });

      await expect(api.findPatientByEmailAndDob('test@example.com', '1990-01-15'))
        .rejects.toBeTruthy();
    });

    test('throws when the email-only lookup fails (no DOB provided)', async () => {
      mockGet.mockRejectedValue({ status: 500, message: 'server error' });

      await expect(api.findPatientByEmailAndDob('test@example.com', null))
        .rejects.toBeTruthy();
    });

    test('throws when the lenient DOB-fallback lookup fails after the primary call finds no match', async () => {
      // Primary email+DOB query succeeds with no rows, so it falls through to
      // the lenient email-only fallback — which then fails.
      mockGet
        .mockResolvedValueOnce({ patients: [] })
        .mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' });

      await expect(api.findPatientByEmailAndDob('test@example.com', '1990-01-15'))
        .rejects.toBeTruthy();
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

    // Regression guard for the analytics instrumentation added alongside
    // sessionId/region params — must not change the pre-existing return
    // shape or payload sent to Cliniko.
    test('sessionId/region are additive — return value and Cliniko payload unchanged whether present or omitted', async () => {
      const appointment = { id: '999', starts_at: validArgs.starts_at };
      mockPost.mockResolvedValue(appointment);

      const withoutAnalyticsFields = await api.bookAppointment(validArgs);
      const cliniko_payload_without = mockPost.mock.calls[0][0];

      mockPost.mockClear();
      const withAnalyticsFields = await api.bookAppointment({ ...validArgs, sessionId: 'session_abc', region: 'SG' });
      const cliniko_payload_with = mockPost.mock.calls[0][0];

      expect(withAnalyticsFields).toEqual(withoutAnalyticsFields);
      expect(cliniko_payload_with).toEqual(cliniko_payload_without);
    });

    test('emits a structured ANALYTICS_EVENT with booking fields on success', async () => {
      const appointment = { id: '999', starts_at: validArgs.starts_at };
      mockPost.mockResolvedValue(appointment);
      const infoSpy = jest.spyOn(api.logger, 'info');

      await api.bookAppointment({ ...validArgs, sessionId: 'session_abc', region: 'SG' });

      expect(infoSpy).toHaveBeenCalledWith('ANALYTICS_EVENT', expect.objectContaining({
        event:                'booking_confirmed',
        sessionId:            'session_abc',
        region:               'SG',
        patient_id:           validArgs.patient_id,
        practitioner_id:      validArgs.practitioner_id,
        business_id:          validArgs.business_id,
        appointment_type_id:  validArgs.appointment_type_id,
        appointment_id:       '999',
        starts_at:            validArgs.starts_at,
      }));
    });

    test('does not emit ANALYTICS_EVENT when booking fails validation (no HTTP call made)', async () => {
      const { starts_at: _omit, ...missing } = validArgs;
      const infoSpy = jest.spyOn(api.logger, 'info');

      await api.bookAppointment(missing);

      expect(infoSpy).not.toHaveBeenCalledWith('ANALYTICS_EVENT', expect.anything());
    });

    // The analytics log call is fire-and-forget (not awaited) — it must not
    // add measurable latency to the booking path itself.
    test('analytics logging adds no meaningful latency to bookAppointment', async () => {
      const appointment = { id: '999', starts_at: validArgs.starts_at };
      mockPost.mockResolvedValue(appointment);

      const iterations = 200;
      const start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        await api.bookAppointment({ ...validArgs, sessionId: `s${i}`, region: 'SG' });
      }
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

      // Generous ceiling — this only guards against an accidental blocking
      // call (e.g. a synchronous file write or awaited I/O) being introduced,
      // not a strict perf benchmark.
      expect(elapsedMs / iterations).toBeLessThan(5);
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

    test('returns [] marked _partial when API throws', async () => {
      mockGet.mockRejectedValue({ status: 500, error: 'server error' });
      const result = await api.getBookingsByPatientId('42', { when: 'future' });
      expect(result).toEqual([]);
      expect(result._partial).toBe(true);
    });

    // Regression: 'both' mode catches each side's failure locally so the
    // other side's real results still come back — but that success-path
    // return used to bypass the outer catch entirely, so a one-sided failure
    // here read as a complete, confirmed result instead of a possibly-short one.
    test('both mode: one side fails, other succeeds — merged result returned, marked _partial', async () => {
      const cancelledAppt = { id: 'C1', starts_at: new Date().toISOString() };
      mockGet
        .mockRejectedValueOnce({ status: 429, error: 'rate limited' })       // active fetch fails
        .mockResolvedValueOnce({ individual_appointments: [cancelledAppt] }); // cancelled fetch succeeds

      const result = await api.getBookingsByPatientId('42', { when: 'future', statusMode: 'both' });

      expect(result).toHaveLength(1);        // cancelled's real result survives
      expect(result[0].id).toBe('C1');
      expect(result._partial).toBe(true);    // but active-side rows may be missing
    });

    test('both mode: both sides succeed — not marked _partial', async () => {
      mockGet.mockResolvedValue({ individual_appointments: [] });
      const result = await api.getBookingsByPatientId('42', { when: 'future', statusMode: 'both' });
      expect(result._partial).toBeUndefined();
    });
  });

  // ─── getPractitionersForClinic ─────────────────────────────────────────────

  describe('getPractitionersForClinic()', () => {
    test('returns practitioners for a clinic', async () => {
      mockGet.mockResolvedValue({ practitioners: [{ id: 'p1' }] });
      const result = await api.getPractitionersForClinic('biz-1');
      expect(result).toEqual([{ id: 'p1' }]);
    });

    test('returns [] marked _partial when SendMessage throws', async () => {
      mockGet.mockRejectedValue({ status: 429, error: 'rate limited' });
      const result = await api.getPractitionersForClinic('biz-1');
      expect(result).toEqual([]);
      expect(result._partial).toBe(true);
    });

    test('genuine zero practitioners (200 response, no practitioners key) is not marked _partial', async () => {
      mockGet.mockResolvedValue({});
      const result = await api.getPractitionersForClinic('biz-1');
      expect(result).toEqual([]);
      expect(result._partial).toBeUndefined();
    });

    test('a failed fetch is not cached — the very next call retries against Cliniko', async () => {
      mockGet.mockRejectedValueOnce({ status: 429, error: 'rate limited' });
      const failed = await api.getPractitionersForClinic('biz-1');
      expect(failed._partial).toBe(true);

      mockGet.mockResolvedValueOnce({ practitioners: [{ id: 'p1' }] });
      const retried = await api.getPractitionersForClinic('biz-1');
      expect(retried).toEqual([{ id: 'p1' }]);
    });
  });

  // ─── getAppointmentTypes ────────────────────────────────────────────────────

  describe('getAppointmentTypes()', () => {
    test('returns filtered types for a practitioner', async () => {
      mockGet.mockResolvedValue({
        appointment_types: [{ id: 't1', name: 'Initial', show_in_online_bookings: true }],
      });
      const result = await api.getAppointmentTypes({ practitioner_id: 'p1' });
      expect(result).toEqual([{ id: 't1', name: 'Initial', show_in_online_bookings: true }]);
    });

    // Regression: this used to re-throw, which crashed every Promise.all fan-out
    // built on top of it (buildAvailablePhysiosForTypeName, getAllAppointmentTypesForAllPractitioners,
    // etc.) on a single practitioner's timeout instead of degrading gracefully.
    test('returns [] marked _partial when SendMessage throws — does not re-throw', async () => {
      mockGet.mockRejectedValue({ status: 429, error: 'timeout' });
      const result = await api.getAppointmentTypes({ practitioner_id: 'p1' });
      expect(result).toEqual([]);
      expect(result._partial).toBe(true);
    });

    test('a failed fetch is not cached — the very next call retries against Cliniko', async () => {
      mockGet.mockRejectedValueOnce({ status: 429, error: 'timeout' });
      const failed = await api.getAppointmentTypes({ practitioner_id: 'p1' });
      expect(failed._partial).toBe(true);

      mockGet.mockResolvedValueOnce({
        appointment_types: [{ id: 't1', name: 'Initial', show_in_online_bookings: true }],
      });
      const retried = await api.getAppointmentTypes({ practitioner_id: 'p1' });
      expect(retried).toEqual([{ id: 't1', name: 'Initial', show_in_online_bookings: true }]);
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

    // Regression: one clinic's practitioner fetch timing out used to discard
    // every other clinic's data too (Promise.all all-or-nothing). Confirmed
    // live 2026-07-21 — a single clinic timeout turned a valid multi-clinic
    // result into a false "no appointment types anywhere" for the user.
    test('one clinic practitioner fetch throws — other clinics still returned, result marked _partial', async () => {
      mockGet
        .mockResolvedValueOnce({
          businesses: [
            { id: 'c1', business_name: 'Clinic A' },
            { id: 'c2', business_name: 'Clinic B' },
          ],
        })
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ practitioners: [{ id: 'p2' }] });

      const result = await api.getPractitionersByClinic();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ clinic_id: 'c1', clinic_name: 'Clinic A', practitioners: [] });
      expect(result[1]).toEqual({ clinic_id: 'c2', clinic_name: 'Clinic B', practitioners: [{ id: 'p2' }] });
      expect(result._partial).toBe(true);
    });

    // A partial result must not be cached — the failed clinic should retry
    // for real on the very next call, not serve stale/incomplete data.
    test('a partial result (one clinic failed) is not cached', async () => {
      mockGet
        .mockResolvedValueOnce({ businesses: [{ id: 'c1', business_name: 'Clinic A' }] })
        .mockRejectedValueOnce(new Error('timeout'));
      await api.getPractitionersByClinic();

      mockGet
        .mockResolvedValueOnce({ businesses: [{ id: 'c1', business_name: 'Clinic A' }] })
        .mockResolvedValueOnce({ practitioners: [{ id: 'p1' }] });
      const retried = await api.getPractitionersByClinic();

      expect(retried[0].practitioners).toEqual([{ id: 'p1' }]);
      expect(retried._partial).toBeUndefined();
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
      jest.advanceTimersByTime(121_000);          // expire the cache entry
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
