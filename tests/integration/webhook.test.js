const request = require('supertest');
const app = require('../../app');
jest.mock('../../src/api/WhatsAppAPI');
jest.mock('../../src/api/ClinikoAPI');

describe('WhatsApp webhook endpoint', () => {
  it('responds to message from known user', async () => {
    const payload = require('../fixtures/sample-messages.json').verifiedUser;

    const res = await request(app)
      .post('/webhook')
      .send(payload);

    expect(res.statusCode).toBe(200);
  });
});
