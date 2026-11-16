jest.mock('../../../src/core/DatabaseManager');
jest.mock('../../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  }))
);

const SessionManager = require('../../../src/core/SessionManager');

describe('SessionManager.parseSession — legacy state normalization', () => {
  let sm;
  beforeAll(() => { sm = new SessionManager({ on: () => {} }); });

  const future = () => new Date(Date.now() + 60000).toISOString();

  test('"initial" is normalized to "INTRO"', () => {
    const parsed = sm.parseSession({ id: 'x', conversation_state: 'initial', expires_at: future() });
    expect(parsed.conversation_state).toBe('INTRO');
  });

  test('"INTRO" is unchanged', () => {
    const parsed = sm.parseSession({ id: 'x', conversation_state: 'INTRO', expires_at: future() });
    expect(parsed.conversation_state).toBe('INTRO');
  });

  test('null conversation_state is not changed to "INTRO" by parseSession', () => {
    const parsed = sm.parseSession({ id: 'x', conversation_state: null, expires_at: future() });
    expect(parsed.conversation_state).toBeNull();
  });

  test('known valid states are passed through unchanged', () => {
    for (const state of ['VERIFY', 'BOOK_MANAGE_OPTIONS', 'SELECT_SLOT', 'CONFIRM_BOOKING']) {
      const parsed = sm.parseSession({ id: 'x', conversation_state: state, expires_at: future() });
      expect(parsed.conversation_state).toBe(state);
    }
  });
});

describe('SessionManager.normalizePhoneNumber', () => {
  let sm;

  beforeAll(() => {
    // Pass a stub db so the constructor doesn't need a real DB
    sm = new SessionManager({ on: () => {} });
  });

  const cases = [
    // Singapore: CC 65 + 8-digit local = 10 digits — must NOT become Indian
    ['+6591000001',   '+6591000001'],
    ['6591000001',    '+6591000001'],
    ['+6512345678',   '+6512345678'],
    // India: correctly detected (12-digit with 91 prefix, or bare 10-digit non-65)
    ['+919100000001', '+919100000001'],
    ['9100000001',    '+919100000001'],
    // US/Canada
    ['+14155550123',  '+14155550123'],
    // Philippines
    ['+63912345678',  '+63912345678'],
  ];

  test.each(cases)('normalizePhoneNumber(%s) === %s', (input, expected) => {
    expect(sm.normalizePhoneNumber(input)).toBe(expected);
  });
});

describe('SessionManager.getRegionFromPhoneNumber', () => {
  let sm;

  beforeAll(() => {
    sm = new SessionManager({ on: () => {} });
  });

  const cases = [
    // Singapore: CC 65 + 8-digit local = 10 bare digits — must NOT become India
    ['+6592000001', 'SG'],
    ['6592000001', 'SG'],
    // India: only detected with the full 91 country code — bare-digit/local-format
    // guessing was removed (see comment in getRegionFromPhoneNumber) since it's
    // unreachable from real WhatsApp traffic and ambiguous with other countries.
    ['+919100000001', 'IN'],
    ['919100000001', 'IN'],
    // Philippines
    ['+639123456789', 'PH'],
    // Hong Kong local 8-digit (starts 5-7, distinct from SG's 8/9-prefix range)
    ['61234567', 'HK'],
    // UK/US domestic-format numbers (no country code) are genuinely ambiguous with
    // Indian domestic format — must NOT be silently misclassified as India anymore.
    ['07863464276', undefined],   // UK domestic mobile (leading 0)
    ['4155550123', undefined],    // US local 10-digit, no country code
    // Full international UK/US (real wa_id shape) were already correctly undetected
    ['447863464276', undefined],
    ['14155550123', undefined],
  ];

  test.each(cases)('getRegionFromPhoneNumber(%s).region === %s', (input, expectedRegion) => {
    expect(sm.getRegionFromPhoneNumber(input).region).toBe(expectedRegion);
  });
});

describe('SessionManager.getOrCreateSession — session_started analytics event', () => {
  // Regression: getRegionFromPhoneNumber() returns {region, ...}, not a bare
  // string — a call site that logs the whole object instead of .region
  // silently breaks any aggregation keyed on region downstream (caught live,
  // 2026-11-16, via a dashboard showing 0 sessions despite real traffic).
  test('region on the emitted event is a plain string, not the whole lookup object', async () => {
    const fakeDb = {
      getSessionByPhone: jest.fn().mockResolvedValue(null),
      createSession: jest.fn().mockResolvedValue('sess-1'),
      getSession: jest.fn().mockResolvedValue({ id: 'sess-1', conversation_state: 'INTRO', data: null }),
      getPatientState: jest.fn().mockResolvedValue(null),
    };
    const sm = new SessionManager(fakeDb);
    sm.logger.analyticsEvent = jest.fn();

    await sm.getOrCreateSession('+85298377469');

    const call = sm.logger.analyticsEvent.mock.calls.find(([payload]) => payload.event === 'session_started');
    expect(call).toBeDefined();
    expect(typeof call[0].region).toBe('string');
    expect(call[0].region).toBe('HK');
  });
});

describe('SessionManager.isTestPhoneNumber', () => {
  let sm;
  const originalEnv = process.env.TEST_PHONE_NUMBERS;

  beforeAll(() => {
    sm = new SessionManager({ on: () => {} });
  });

  afterEach(() => {
    process.env.TEST_PHONE_NUMBERS = originalEnv;
  });

  test('matches a number in the list regardless of formatting', () => {
    process.env.TEST_PHONE_NUMBERS = '85298377469,12345678901';
    expect(sm.isTestPhoneNumber('85298377469')).toBe(true);
    expect(sm.isTestPhoneNumber('+852 9837 7469')).toBe(true);
  });

  test('returns false for a number not in the list', () => {
    process.env.TEST_PHONE_NUMBERS = '85298377469';
    expect(sm.isTestPhoneNumber('85212345678')).toBe(false);
  });

  test('returns false when TEST_PHONE_NUMBERS is unset or blank', () => {
    delete process.env.TEST_PHONE_NUMBERS;
    expect(sm.isTestPhoneNumber('85298377469')).toBe(false);
    process.env.TEST_PHONE_NUMBERS = '   ';
    expect(sm.isTestPhoneNumber('85298377469')).toBe(false);
  });

  test('returns false for empty/missing input', () => {
    process.env.TEST_PHONE_NUMBERS = '85298377469';
    expect(sm.isTestPhoneNumber('')).toBe(false);
    expect(sm.isTestPhoneNumber(undefined)).toBe(false);
  });
});
