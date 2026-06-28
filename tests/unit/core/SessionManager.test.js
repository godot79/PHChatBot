jest.mock('../../../src/core/DatabaseManager');
jest.mock('../../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  }))
);

const SessionManager = require('../../../src/core/SessionManager');

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
