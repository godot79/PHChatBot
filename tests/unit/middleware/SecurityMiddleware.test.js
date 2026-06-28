'use strict';

const crypto = require('crypto');

jest.mock('../../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info:  () => {},
    warn:  () => {},
    error: () => {},
    debug: () => {},
  }))
);

const SecurityMiddleware = require('../../../src/middleware/SecurityMiddleware');

const SECRET = 'test-webhook-secret';
const BODY   = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));

function makeSignature(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function makeReq({ header, body = BODY } = {}) {
  return {
    get:  (h) => (h === 'X-Hub-Signature-256' ? header : undefined),
    body,
    ip:   '127.0.0.1',
  };
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('SecurityMiddleware.verifyWebhookSignature', () => {
  let middleware;
  const next = jest.fn();

  beforeEach(() => {
    process.env.WHATSAPP_WEBHOOK_SECRET = SECRET;
    middleware = new SecurityMiddleware();
    next.mockClear();
  });

  afterEach(() => {
    delete process.env.WHATSAPP_WEBHOOK_SECRET;
  });

  test('calls next() for a valid HMAC signature', () => {
    const req = makeReq({ header: makeSignature(BODY, SECRET) });
    const res = makeRes();
    middleware.verifyWebhookSignature(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 when X-Hub-Signature-256 header is missing', () => {
    const req = makeReq({ header: undefined });
    const res = makeRes();
    middleware.verifyWebhookSignature(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MALFORMED_SIGNATURE_HEADER' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when header lacks sha256= prefix', () => {
    const raw = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    const req = makeReq({ header: raw }); // no "sha256=" prefix
    const res = makeRes();
    middleware.verifyWebhookSignature(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MALFORMED_SIGNATURE_HEADER' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when signature is wrong', () => {
    const req = makeReq({ header: makeSignature(BODY, 'wrong-secret') });
    const res = makeRes();
    middleware.verifyWebhookSignature(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 500 when WHATSAPP_WEBHOOK_SECRET is not configured', () => {
    delete process.env.WHATSAPP_WEBHOOK_SECRET;
    middleware = new SecurityMiddleware(); // re-instantiate without secret
    const req = makeReq({ header: makeSignature(BODY, SECRET) });
    const res = makeRes();
    middleware.verifyWebhookSignature(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONFIG_ERROR' }));
    expect(next).not.toHaveBeenCalled();
  });
});
