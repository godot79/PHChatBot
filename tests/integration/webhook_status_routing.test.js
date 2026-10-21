// Regression coverage for the status-callback routing bug found live 2026-10-21:
// Meta sends BOTH inbound messages and delivery-status updates under
// field: "messages" (the payload SHAPE — messages[] vs statuses[] — is what
// distinguishes them, never a separate "message_status" field value).
// webhook.js previously routed on change.field === 'message_status', which
// never matches real Meta traffic, so handleStatusUpdate was dead code and
// every real delivery status (sent/delivered/read/failed) was silently
// dropped with no error. Exercises the actual registered Express route
// handler directly (no supertest — see webhook.test.js's skip note for why
// that harness isn't available) with a real HMAC signature.
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
  // Last function in the route's own stack is the real handler; earlier
  // entries are middleware (e.g. the rate limiter) we don't need here.
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

const STATUS_UPDATE_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA_ID',
    changes: [{
      field: 'messages', // real Meta shape — status updates are NOT field: "message_status"
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '85262170979', phone_number_id: '1153340851204354' },
        statuses: [{ id: 'wamid.TEST', status: 'delivered', timestamp: '1792568600', recipient_id: '85298377469' }],
      },
    }],
  }],
};

const USER_MESSAGE_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA_ID',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '85262170979', phone_number_id: '1153340851204354' },
        contacts: [{ profile: { name: 'Test' }, wa_id: '85298377469' }],
        messages: [{ from: '85298377469', id: 'wamid.TEST2', timestamp: '1792568600', text: { body: 'Hi' }, type: 'text' }],
      },
    }],
  }],
};

describe('webhook POST / — status-callback vs user-message routing (fix/status-callback-field-routing)', () => {
  let debugSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    debugSpy = jest.spyOn(ChatbotEngine.prototype, 'handleMessageEnvelope').mockResolvedValue('reply');
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  test('a real Meta delivery-status update (field: "messages", statuses[] present) actually reaches handleStatusUpdate', async () => {
    // The old buggy dispatch (change.field === 'message_status') never matches
    // real Meta traffic (field is always "messages"), so handleStatusUpdate was
    // dead code — both old and new code correctly avoid calling
    // handleMessageEnvelope here (handleIncomingMessage just no-ops on an empty
    // messages[]), so that alone doesn't prove the fix. Spying on the real
    // side effect inside handleStatusUpdate (a logger.debug call) is what
    // actually distinguishes "dead code never ran" from "status handling ran".
    const debugLogSpy = jest.spyOn(Logger.prototype, 'debug');
    const handler = getPostHandler();
    const { req, res } = signedRequest(STATUS_UPDATE_PAYLOAD);
    await handler(req, res);
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget async body finish
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(debugLogSpy).toHaveBeenCalledWith('Message Status:', expect.objectContaining({
      id: 'wamid.TEST', status: 'delivered',
    }));
    // Must NOT be treated as a user message — no attempt to run it through the state machine.
    expect(ChatbotEngine.prototype.handleMessageEnvelope).not.toHaveBeenCalled();
    debugLogSpy.mockRestore();
  });

  test('a real inbound user message (field: "messages", messages[] present) still reaches the chatbot engine', async () => {
    const handler = getPostHandler();
    const { req, res } = signedRequest(USER_MESSAGE_PAYLOAD);
    await handler(req, res);
    await new Promise((r) => setImmediate(r));
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(ChatbotEngine.prototype.handleMessageEnvelope).toHaveBeenCalledWith('Hi', '85298377469');
  });

  test('a payload with neither messages[] nor statuses[] is ignored (no crash, no engine call)', async () => {
    const handler = getPostHandler();
    const malformed = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp' } }] }],
    };
    const { req, res } = signedRequest(malformed);
    await expect(handler(req, res)).resolves.not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(ChatbotEngine.prototype.handleMessageEnvelope).not.toHaveBeenCalled();
  });
});
