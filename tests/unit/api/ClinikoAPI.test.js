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

const ClinikoAPI = require('../../../src/api/ClinikoAPI');

describe('ClinikoAPI', () => {
  let api;
  let mockGet;
  let mockPost;

  beforeEach(() => {
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
});
