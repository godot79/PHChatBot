jest.mock('../../src/api/WhatsAppAPI');
jest.mock('../../src/api/ClinikoAPI');

// Skipped: requires app.js extracted from server.js + mock rewrites (mocked methods don't match real ClinikoAPI)
describe.skip('End-to-End Booking Flow', () => {
  // Deferred: install supertest and extract app.js from server.js before unskipping
  const request = null;
  const app = null;
  const WhatsAppAPI = require('../../src/api/WhatsAppAPI');
  const ClinikoAPI = require('../../src/api/ClinikoAPI');

  const verifiedUserMessage = {
    messages: [
      {
        from: '1234567890',
        type: 'text',
        text: { body: 'Book appointment' }
      }
    ]
  };

  beforeEach(() => {
    WhatsAppAPI.sendMessage.mockResolvedValue(true);
    ClinikoAPI.getPatientByPhone.mockResolvedValue({ id: 1 });
    ClinikoAPI.createAppointment.mockResolvedValue({ id: 555 });
    ClinikoAPI.getAvailableSlots.mockResolvedValue([
      { id: 101, start: '2025-07-01T09:00:00Z', practitioner_id: 5 }
    ]);
  });

  test('responds to appointment request from verified user', async () => {
    const res = await request(app)
      .post('/webhook')
      .send(verifiedUserMessage);

    expect(res.statusCode).toBe(200);
    expect(WhatsAppAPI.sendMessage).toHaveBeenCalled();
    expect(ClinikoAPI.createAppointment).toHaveBeenCalled();
  });

  test('fetches available appointment slots from Cliniko', async () => {
    const slots = await ClinikoAPI.getAvailableSlots({ date: '2025-07-01', practitionerId: 5 });
    expect(slots).toHaveLength(1);
    expect(slots[0].start).toBe('2025-07-01T09:00:00Z');
  });

  test('sends reminder to user after booking', async () => {
    // simulate reminder trigger
    const reminderService = require('../../src/services/NotificationService');
    jest.spyOn(reminderService, 'sendReminder').mockResolvedValue(true);

    const success = await reminderService.sendReminder({ phoneNumber: '1234567890', time: '2025-07-01T09:00:00Z' });
    expect(success).toBe(true);
  });
});
