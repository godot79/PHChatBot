// ✅ tests/unit/services/NotificationService.test.js
const NotificationService = require('../../../src/services/NotificationService');
const WhatsAppAPI = require('../../../src/api/WhatsAppAPI');

jest.mock('../../../src/api/WhatsAppAPI');

describe('NotificationService', () => {
  beforeEach(() => {
    WhatsAppAPI.sendMessage.mockClear();
  });

  test('sends a reminder message via WhatsAppAPI', async () => {
    WhatsAppAPI.sendMessage.mockResolvedValue(true);

    const result = await NotificationService.sendReminder({
      phoneNumber: '1234567890',
      time: '2025-07-01T09:00:00Z'
    });

    expect(result).toBe(true);
    expect(WhatsAppAPI.sendMessage).toHaveBeenCalledWith('1234567890', expect.stringContaining('reminder'));
  });
});
