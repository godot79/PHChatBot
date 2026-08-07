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
