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
