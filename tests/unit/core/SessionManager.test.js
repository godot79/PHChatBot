const SessionManager = require('../../../src/core/SessionManager');
const DatabaseManager = require('../../../src/core/DatabaseManager');

jest.mock('../../../src/core/DatabaseManager');

describe('SessionManager', () => {
  let sessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager(DatabaseManager);
  });

  test('should start a new session', async () => {
    DatabaseManager.createSession.mockResolvedValue(true);
    const result = await sessionManager.startSession('12345');
    expect(result).toBeTruthy();
    expect(DatabaseManager.createSession).toHaveBeenCalledWith({ phoneNumber: '12345', state: 'new' });
  });
});
