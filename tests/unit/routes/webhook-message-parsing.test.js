'use strict';

/**
 * Unit tests for handleIncomingMessage in webhook.js.
 *
 * Covers the interactive message type parsing fix:
 *   - message.interactive absent/null  → plain text nudge, no chatbot call
 *   - message.interactive with unknown subtype → plain text nudge, no chatbot call
 *   - valid button_reply / list_reply   → routed to chatbot engine normally
 *   - text / button messages            → routed normally
 *   - unknown top-level type            → silent drop
 */

const http = require('http');
const express = require('express');

// ── Mock instances (mock-prefix required for jest.mock factory hoisting) ─────

const mockEngineInstance = {
  handleMessageEnvelope: jest.fn().mockResolvedValue('reply'),
};
const mockApiInstance = {
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendInteractive: jest.fn().mockResolvedValue({}),
};

// ── Mocks (hoisted before any require) ──────────────────────────────────────

jest.mock('../../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }))
);

jest.mock('../../../src/middleware/SecurityMiddleware', () =>
  jest.fn().mockImplementation(() => ({
    checkSignature: jest.fn().mockReturnValue(true),
  }))
);

jest.mock('../../../src/middleware/RateLimitMiddleware', () =>
  jest.fn().mockImplementation(() => ({
    getWhatsappLimiter: jest.fn().mockReturnValue((_req, _res, next) => next()),
  }))
);

jest.mock('../../../src/core/ChatbotEngine', () =>
  jest.fn().mockReturnValue(mockEngineInstance)
);

jest.mock('../../../src/api/WhatsAppAPI', () =>
  jest.fn().mockReturnValue(mockApiInstance)
);

// ── Module reference (after mocks) ──────────────────────────────────────────

const webhookRouter = require('../../../src/routes/webhook');

// ── Test server ──────────────────────────────────────────────────────────────

let server;

beforeAll(done => {
  const app = express();
  // Mirror server.js: webhook receives a raw Buffer, not parsed JSON
  app.use(express.raw({ type: 'application/json' }));
  app.use('/', webhookRouter);
  server = app.listen(0, done);
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
  jest.clearAllMocks();
  // Restore implementations after clearAllMocks resets call counts
  mockEngineInstance.handleMessageEnvelope.mockResolvedValue('reply');
  mockApiInstance.sendTextMessage.mockResolvedValue({});
  mockApiInstance.sendInteractive.mockResolvedValue({});
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function postWebhook(messages) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { messages } }] }],
    }));
    const req = http.request({
      hostname: 'localhost',
      port: server.address().port,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'X-Hub-Signature-256': 'sha256=test',
      },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// Webhook acks with 200 immediately then processes async; wait for the loop
const settle = () => new Promise(r => setTimeout(r, 50));

const ERROR_NUDGE = expect.stringContaining('type a number');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('webhook: interactive message parsing', () => {
  test('interactive with message.interactive = null → plain text nudge, no engine call', async () => {
    await postWebhook([{ from: '123', type: 'interactive', interactive: null }]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).not.toHaveBeenCalled();
    expect(mockApiInstance.sendTextMessage).toHaveBeenCalledWith('123', ERROR_NUDGE);
    expect(mockApiInstance.sendInteractive).not.toHaveBeenCalled();
  });

  test('interactive with message.interactive absent → plain text nudge, no engine call', async () => {
    await postWebhook([{ from: '123', type: 'interactive' }]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).not.toHaveBeenCalled();
    expect(mockApiInstance.sendTextMessage).toHaveBeenCalledWith('123', ERROR_NUDGE);
  });

  test('interactive with unknown subtype (nfm_reply) → plain text nudge, no engine call', async () => {
    await postWebhook([{
      from: '456',
      type: 'interactive',
      interactive: { type: 'nfm_reply', nfm_reply: { body: 'done', name: 'flow' } },
    }]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).not.toHaveBeenCalled();
    expect(mockApiInstance.sendTextMessage).toHaveBeenCalledWith('456', ERROR_NUDGE);
  });

  test('interactive with button_reply.id → engine called with id', async () => {
    await postWebhook([{
      from: '789',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: '2', title: 'Option 2' } },
    }]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).toHaveBeenCalledWith('2', '789');
  });

  test('interactive with list_reply.id → engine called with id', async () => {
    await postWebhook([{
      from: '789',
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: '5', title: 'Option 5' } },
    }]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).toHaveBeenCalledWith('5', '789');
  });

  test('interactive with button_reply title but empty id → falls back to title', async () => {
    await postWebhook([{
      from: '789',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: '', title: 'Yes' } },
    }]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).toHaveBeenCalledWith('Yes', '789');
  });
});

describe('webhook: other message types', () => {
  test('text message → engine called with body text', async () => {
    await postWebhook([{ from: '111', type: 'text', text: { body: 'hello' } }]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).toHaveBeenCalledWith('hello', '111');
  });

  test('button message → engine called with button text', async () => {
    await postWebhook([{ from: '222', type: 'button', button: { text: 'Confirm', payload: 'confirm' } }]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).toHaveBeenCalledWith('Confirm', '222');
  });

  test('unknown type (image) → silent drop, no engine call', async () => {
    await postWebhook([{ from: '333', type: 'image', image: { id: 'img1' } }]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).not.toHaveBeenCalled();
    expect(mockApiInstance.sendTextMessage).not.toHaveBeenCalled();
  });

  test('empty messages array → no processing', async () => {
    await postWebhook([]);
    await settle();
    expect(mockEngineInstance.handleMessageEnvelope).not.toHaveBeenCalled();
  });
});
