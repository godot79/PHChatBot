'use strict';

/**
 * Unit tests for the session-rollback-on-failed-send fix in webhook.js.
 *
 * Background: practitioner/type/clinic/slot list pagination persists its page
 * cursor to the session BEFORE the WhatsApp send is attempted. If the send
 * then fails (e.g. Meta's #131056 per-recipient rate limit), the cursor was
 * silently left advanced past a page the user never actually received —
 * physios/types/slots on that page effectively vanished from the user's view.
 *
 * These tests exercise webhook.js's handleIncomingMessage directly (exposed
 * via router.handleIncomingMessage) rather than over HTTP, since the fix's
 * logic lives entirely in that function and doesn't need the raw-body/
 * signature layer that the HTTP-level webhook-message-parsing.test.js covers.
 */

const mockEngineInstance = {
  handleMessageEnvelope: jest.fn().mockResolvedValue('reply'),
  STATES: {
    BOOK_HISTORY: 'BOOK_HISTORY',
    BOOK_SPECIFIC_DATE: 'BOOK_SPECIFIC_DATE',
    BOOK_SPECIFIC_PHYSIO: 'BOOK_SPECIFIC_PHYSIO',
    BOOK_SPECIFIC_CLINIC: 'BOOK_SPECIFIC_CLINIC',
    SELECT_SLOT: 'SELECT_SLOT',
    RESCHEDULE_CONFIRM_INTENT: 'RESCHEDULE_CONFIRM_INTENT',
    CONFIRM_BOOKING: 'CONFIRM_BOOKING',
    REGISTER_PATIENT: 'REGISTER_PATIENT',
    CONFIRM_CANCEL: 'CONFIRM_CANCEL',
    CONFIRM_RESCHEDULE: 'CONFIRM_RESCHEDULE',
  },
  sessionManager: {
    getSessionByPhone: jest.fn(),
    updateSession: jest.fn().mockResolvedValue({}),
  },
};
const mockApiInstance = {
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendInteractive: jest.fn().mockResolvedValue({}),
};

jest.mock('../../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), analyticsEvent: jest.fn(),
  }))
);
jest.mock('../../../src/middleware/SecurityMiddleware', () =>
  jest.fn().mockImplementation(() => ({ checkSignature: jest.fn().mockReturnValue(true) }))
);
jest.mock('../../../src/middleware/RateLimitMiddleware', () =>
  jest.fn().mockImplementation(() => ({ getWhatsappLimiter: jest.fn().mockReturnValue((_req, _res, next) => next()) }))
);
jest.mock('../../../src/core/ChatbotEngine', () => jest.fn().mockReturnValue(mockEngineInstance));
jest.mock('../../../src/api/WhatsAppAPI', () => jest.fn().mockReturnValue(mockApiInstance));

const webhookRouter = require('../../../src/routes/webhook');

jest.useFakeTimers();

function rateLimitError() {
  const err = new Error('rate limited');
  err.response = { status: 400, data: { error: { message: '(#131056) pair rate limit hit', code: 131056 } } };
  return err;
}

function otherSendError() {
  return new Error('network blip');
}

function session(overrides) {
  return {
    id: 'session-1',
    conversation_state: 'BOOK_SPECIFIC_PHYSIO',
    context: { region: 'HK' },
    data: { practitioner_page: 2 },
    patient_id: 'pat-1',
    verified: true,
    ...overrides,
  };
}

// Drives handleIncomingMessage and lets any pending retry-sleep timers run.
async function drive(messages) {
  const promise = webhookRouter.handleIncomingMessage({ messages });
  await jest.runAllTimersAsync();
  await promise;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEngineInstance.handleMessageEnvelope.mockResolvedValue('reply');
  mockEngineInstance.sessionManager.getSessionByPhone.mockResolvedValue(session());
  mockEngineInstance.sessionManager.updateSession.mockResolvedValue({});
  mockApiInstance.sendTextMessage.mockResolvedValue({});
  mockApiInstance.sendInteractive.mockResolvedValue({});
});

afterAll(() => {
  jest.useRealTimers();
});

const msg = { from: '85298604442', type: 'text', text: { body: 'next' } };

describe('webhook: rollback on failed send — pagination states', () => {
  const paginationStates = [
    'BOOK_HISTORY',
    'BOOK_SPECIFIC_DATE',
    'BOOK_SPECIFIC_PHYSIO',
    'BOOK_SPECIFIC_CLINIC',
    'SELECT_SLOT',
    'RESCHEDULE_CONFIRM_INTENT',
  ];

  test.each(paginationStates)('%s: send fails (non-131056) → session restored to pre-turn snapshot', async (state) => {
    const preTurn = session({ conversation_state: state, data: { practitioner_page: 3 } });
    mockEngineInstance.sessionManager.getSessionByPhone.mockResolvedValue(preTurn);
    mockApiInstance.sendTextMessage.mockRejectedValue(otherSendError());

    await drive([msg]);

    expect(mockEngineInstance.sessionManager.updateSession).toHaveBeenCalledWith('session-1', {
      conversation_state: state,
      context: preTurn.context,
      data: preTurn.data,
      patient_id: preTurn.patient_id,
      verified: preTurn.verified,
    });
  });

  test('131056 error → retries once after delay, and on retry success no rollback occurs (cursor stays advanced)', async () => {
    mockApiInstance.sendTextMessage
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce({});

    await drive([msg]);

    expect(mockApiInstance.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(mockEngineInstance.sessionManager.updateSession).not.toHaveBeenCalled();
  });

  test('131056 error → retry also fails → falls back to rollback', async () => {
    mockApiInstance.sendTextMessage.mockRejectedValue(rateLimitError());

    await drive([msg]);

    expect(mockApiInstance.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(mockEngineInstance.sessionManager.updateSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ conversation_state: 'BOOK_SPECIFIC_PHYSIO' })
    );
  });

  test('no session found (expired/unknown) → send fails → no rollback attempted, no crash', async () => {
    mockEngineInstance.sessionManager.getSessionByPhone.mockResolvedValue(null);
    mockApiInstance.sendTextMessage.mockRejectedValue(otherSendError());

    await expect(drive([msg])).resolves.toBeUndefined();
    expect(mockEngineInstance.sessionManager.updateSession).not.toHaveBeenCalled();
  });

  test('send succeeds → no rollback, no retry, happy path unaffected', async () => {
    await drive([msg]);

    expect(mockApiInstance.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mockEngineInstance.sessionManager.updateSession).not.toHaveBeenCalled();
  });

  test('array reply (text-then-interactive) failing on the second part still rolls back correctly', async () => {
    mockEngineInstance.handleMessageEnvelope.mockResolvedValue(['heads up', { interactive: { type: 'list' } }]);
    mockApiInstance.sendTextMessage.mockResolvedValue({});
    mockApiInstance.sendInteractive.mockRejectedValue(otherSendError());

    await drive([msg]);

    expect(mockApiInstance.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mockApiInstance.sendInteractive).toHaveBeenCalledTimes(1);
    expect(mockEngineInstance.sessionManager.updateSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ conversation_state: 'BOOK_SPECIFIC_PHYSIO' })
    );
  });
});

describe('webhook: rollback guard — Cliniko-write states must never be rolled back', () => {
  const writeStates = ['CONFIRM_BOOKING', 'REGISTER_PATIENT', 'CONFIRM_CANCEL', 'CONFIRM_RESCHEDULE'];

  test.each(writeStates)('%s: send fails → rollback is NOT attempted (Cliniko write may have already happened)', async (state) => {
    mockEngineInstance.sessionManager.getSessionByPhone.mockResolvedValue(session({ conversation_state: state }));
    mockApiInstance.sendTextMessage.mockRejectedValue(otherSendError());

    await drive([msg]);

    expect(mockEngineInstance.sessionManager.updateSession).not.toHaveBeenCalled();
  });
});
