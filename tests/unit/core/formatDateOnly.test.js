/**
 * Tests for formatDateOnly — the date-picker/prompt-header formatter used
 * throughout the Specific Date booking flow.
 *
 * Guards against the regression this function fixes: dt.toLocaleDateString()
 * with no locale argument depends on the server process's resolved locale
 * (unset/minimal on Cloud Run), silently rendering Western numeric dates
 * inside otherwise fully-translated yue/zh prompts. formatDateOnly pins a
 * fixed locale so output is deterministic regardless of the host environment.
 *
 * Same extraction approach as formatSlotDateTime.test.js: pull the actual
 * production function out of ChatbotEngine.js rather than testing a copy.
 */

const fs = require('fs');
const path = require('path');

let formatDateOnly;
beforeAll(() => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/core/ChatbotEngine.js'),
    'utf8'
  );
  const match = src.match(/function formatDateOnly\([\s\S]*?\n\}/m);
  if (!match) throw new Error('Could not locate formatDateOnly in ChatbotEngine.js');
  // eslint-disable-next-line no-new-func
  formatDateOnly = new Function(`${match[0]}; return formatDateOnly;`)();
});

describe('formatDateOnly', () => {
  test('formats a UTC ISO date as "DD Mon YYYY", independent of server locale', () => {
    expect(formatDateOnly('2026-08-29T00:00:00Z')).toBe('29 Aug 2026');
  });

  test('accepts a Date object (not just ISO string)', () => {
    expect(formatDateOnly(new Date('2026-01-05T00:00:00Z'))).toBe('05 Jan 2026');
  });

  test('never contains Western-locale slash-separated digits (the bug this fixes)', () => {
    const result = formatDateOnly('2026-08-29T00:00:00Z');
    expect(result).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
  });

  test('returns fallback string for invalid input, does not throw', () => {
    expect(formatDateOnly('not-a-date')).toBe('not-a-date');
    expect(() => formatDateOnly('bad string')).not.toThrow();
  });
});
