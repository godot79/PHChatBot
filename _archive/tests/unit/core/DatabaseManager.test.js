const DatabaseManager = require('../../../src/core/DatabaseManager');
const sqlite3 = require('sqlite3').verbose();

describe('DatabaseManager', () => {
  let dbManager;

  beforeAll(() => {
    dbManager = new DatabaseManager(':memory:');
    return dbManager.init();  // assuming init runs schema SQL
  });

  afterAll(() => {
    dbManager.close();
  });

  test('should insert and retrieve a session', async () => {
    await dbManager.createSession({ phoneNumber: '1234567890', state: 'new' });
    const session = await dbManager.getSession('1234567890');
    expect(session).toBeDefined();
    expect(session.phoneNumber).toBe('1234567890');
    expect(session.state).toBe('new');
  });
});
