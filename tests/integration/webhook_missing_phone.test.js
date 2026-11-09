// Regression coverage for a real incident (HK prod, 2026-10-20): a genuine
// inbound message arrived with no `from` field at all. Without a guard this
// cascaded into session-creation throwing ("Invalid phone number provided")
// and 3 separate unhelpful error log lines, instead of one clear warning —
// and either way there's no address to reply to, so skipping is correct.
// The raw payload that would explain WHY `from` was missing predates the
// console-log metadata fix and is gone; this only covers the guard itself.
const crypto = require('crypto');

process.env.WHATSAPP_WEBHOOK_SECRET = 'test-webhook-secret';

jest.mock('../../src/api/WhatsAppAPI');
jest.mock('../../src/api/ClinikoAPI');

const ChatbotEngine = require('../../src/core/ChatbotEngine.js');
const Logger = require('../../src/core/Logger.js');
const webhookRouter = require('../../src/routes/webhook.js');

function getPostHandler() {
  const layer = webhookRouter.stack.find(
    (l) => l.route && l.route.path === '/' && l.route.methods.post
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function signedRequest(bodyObj) {
  const rawBody = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.WHATSAPP_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const req = {
    body: rawBody,
    get: (header) => (header === 'X-Hub-Signature-256' ? signature : undefined),
  };
  const res = { sendStatus: jest.fn(), status: jest.fn(() => res), json: jest.fn(), send: jest.fn() };
  return { req, res };
}

const MISSING_FROM_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA_ID',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '85262170979', phone_number_id: '1153340851204354' },
        messages: [{ id: 'wamid.NOFROM', timestamp: '1792568600', text: { body: 'Hi there, massage therapy?' }, type: 'text' }],
      },
    }],
  }],
};

describe('webhook POST / — a message with no from/phone number (fix/webhook-missing-phone-guard)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(ChatbotEngine.prototype, 'handleMessageEnvelope').mockResolvedValue('reply');
  });

  test('is skipped with a single clear warning, never reaches the chatbot engine, and does not throw', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    const handler = getPostHandler();
    const { req, res } = signedRequest(MISSING_FROM_PAYLOAD);
    await expect(handler(req, res)).resolves.not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no phone number'),
      expect.objectContaining({ type: 'text' })
    );
    expect(ChatbotEngine.prototype.handleMessageEnvelope).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
