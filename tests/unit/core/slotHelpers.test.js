'use strict';

const { normalizeTypeName } = require('../../../src/core/_slotHelpers.js');

describe('_slotHelpers.normalizeTypeName', () => {
  test('collapses whitespace, hyphens, and casing for consistent matching', () => {
    expect(normalizeTypeName('Follow-Up Appointment-Physiotherapy')).toBe('follow up appointment physiotherapy');
    expect(normalizeTypeName('  New   Patient  ')).toBe('new patient');
    expect(normalizeTypeName('Test(A)')).toBe('test (a)');
    expect(normalizeTypeName('')).toBe('');
    expect(normalizeTypeName(undefined)).toBe('');
  });
});
