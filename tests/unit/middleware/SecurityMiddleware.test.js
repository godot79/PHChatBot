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
    originalUrl: '/webhook',
    method: 'POST',
  };
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('SecurityMiddleware.checkSignature — returns boolean, never responds', () => {
  let middleware;

  beforeEach(() => {
    process.env.WHATSAPP_WEBHOOK_SECRET = SECRET;
    middleware = new SecurityMiddleware();
  });

  afterEach(() => { delete process.env.WHATSAPP_WEBHOOK_SECRET; });

  test('returns true for a valid signature', () => {
    const header = makeSignature(BODY, SECRET);
    expect(middleware.checkSignature(BODY, header)).toBe(true);
  });

  test('returns false for a wrong secret', () => {
    const header = makeSignature(BODY, 'wrong-secret');
    expect(middleware.checkSignature(BODY, header)).toBe(false);
  });

  test('returns false when header is missing', () => {
    expect(middleware.checkSignature(BODY, undefined)).toBe(false);
  });

  test('returns false when header lacks sha256= prefix', () => {
    const raw = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(middleware.checkSignature(BODY, raw)).toBe(false);
  });

  test('returns false when body differs from what was signed', () => {
    const header = makeSignature(Buffer.from('other body'), SECRET);
    expect(middleware.checkSignature(BODY, header)).toBe(false);
  });

  test('returns false when secret is not configured', () => {
    delete process.env.WHATSAPP_WEBHOOK_SECRET;
    middleware = new SecurityMiddleware();
    const header = makeSignature(BODY, SECRET);
    expect(middleware.checkSignature(BODY, header)).toBe(false);
  });
});

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
    const req = makeReq({ header: raw });
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
    middleware = new SecurityMiddleware();
    const req = makeReq({ header: makeSignature(BODY, SECRET) });
    const res = makeRes();
    middleware.verifyWebhookSignature(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONFIG_ERROR' }));
    expect(next).not.toHaveBeenCalled();
  });
});
