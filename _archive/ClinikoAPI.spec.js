// test/ClinikoAPI.spec.js

const ClinikoAPI = require('../src/ClinikoAPI');
const SendMessage = require('../src/SendMessage');

// Mock SendMessage for all tests
jest.mock('../path/to/SendMessage');

describe('ClinikoAPI', () => {
  let api;

  beforeEach(() => {
    api = new ClinikoAPI();
    jest.clearAllMocks();
  });

  describe('bookAppointment', () => {
    const baseAppointment = {
      patient_id: 123,
      practitioner_id: 456,
      business_id: 789,
      appointment_type_id: 321,
      appointment_start: '2025-08-01T10:00:00Z'
    };

    it('should successfully book an appointment', async () => {
      const fakeResponse = {
        appointment: { id: 1000, ...baseAppointment }
      };
      SendMessage.prototype.post.mockResolvedValueOnce(fakeResponse);

      const result = await api.bookAppointment(baseAppointment);

      expect(result.success).toBe(true);
      expect(result.appointment).toHaveProperty('id', 1000);
      expect(SendMessage.prototype.post).toHaveBeenCalledTimes(1);
    });

    it('should handle booking errors gracefully', async () => {
      SendMessage.prototype.post.mockRejectedValueOnce(new Error('API error'));

      const result = await api.bookAppointment(baseAppointment);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Failed to book appointment/i);
    });
  });

  describe('cancelLatestAppointment', () => {
    it('should cancel the latest appointment if one exists', async () => {
      const fakeAppointment = { id: 2000 };
      SendMessage.prototype.get.mockResolvedValueOnce({ appointments: [fakeAppointment] });
      SendMessage.prototype.delete.mockResolvedValueOnce({});

      const result = await api.cancelLatestAppointment(12345);

      expect(result.success).toBe(true);
      expect(result.appointmentId).toBe(2000);
      expect(SendMessage.prototype.get).toHaveBeenCalledTimes(1);
      expect(SendMessage.prototype.delete).toHaveBeenCalledTimes(1);
    });

    it('should handle no appointments found', async () => {
      SendMessage.prototype.get.mockResolvedValueOnce({ appointments: [] });

      const result = await api.cancelLatestAppointment(12345);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/no recent appointments/i);
      expect(SendMessage.prototype.delete).not.toHaveBeenCalled();
    });

    it('should handle errors during cancellation', async () => {
      SendMessage.prototype.get.mockResolvedValueOnce({ appointments: [{ id: 3000 }] });
      SendMessage.prototype.delete.mockRejectedValueOnce(new Error('Delete failed'));

      const result = await api.cancelLatestAppointment(12345);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/failed to cancel appointment/i);
      expect(SendMessage.prototype.get).toHaveBeenCalledTimes(1);
      expect(SendMessage.prototype.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('findPatientByEmail', () => {
    it('should return patient if found', async () => {
      SendMessage.prototype.get.mockResolvedValueOnce({ patients: [{ id: 555, email: 'test@example.com' }] });

      const result = await api.findPatientByEmail('test@example.com');
      expect(result).toHaveProperty('id', 555);
    });

    it('should return null if not found', async () => {
      SendMessage.prototype.get.mockResolvedValueOnce({ patients: [] });

      const result = await api.findPatientByEmail('notfound@example.com');
      expect(result).toBeNull();
    });
  });
});
