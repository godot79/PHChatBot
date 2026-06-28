jest.mock('../../src/api/WhatsAppAPI');
jest.mock('../../src/api/ClinikoAPI');

// Skipped: requires app.js extracted from server.js (app is not exported)
describe.skip('WhatsApp webhook endpoint', () => {
  // Deferred: install supertest and extract app.js from server.js before unskipping
  const request = null;
  const app = null;

  it('responds to message from known user', async () => {
    const payload = require('../fixtures/sample-messages.json').verifiedUser;

    const res = await request(app)
      .post('/webhook')
      .send(payload);

    expect(res.statusCode).toBe(200);
  });
});
