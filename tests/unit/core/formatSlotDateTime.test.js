/**
 * Tests for formatSlotDateTime timezone-awareness.
 *
 * All slots from Cliniko arrive as UTC ISO strings. The function must render
 * them in the clinic's local timezone. Cloud Run runs in UTC, so without an
 * explicit timeZone option the output would always be UTC — wrong for HK/SG/PH/IN.
 *
 * We import the function via the ChatbotEngine module so we're testing the
 * actual exported/used implementation, not a copy.
 */

// formatSlotDateTime is a module-level function in ChatbotEngine — not exported.
// We extract it by calling the engine's display code path indirectly through
// a unit-testable wrapper. Instead, we test it directly by requiring the
// module and using a regex/snapshot approach on known UTC inputs.

// Since formatSlotDateTime is not exported we test it through ChatbotEngine's
// _regionTz helper and by stubbing enough state to call the enrichment path.
// For unit isolation we test the pure function inline after extracting it from
// the source, to avoid spinning up a full engine.

const fs = require('fs');
const path = require('path');

// Pull the function source out so we can eval it standalone.
// This is intentional: we want to test the exact production function,
// not a manually-written copy.
let formatSlotDateTime;
beforeAll(() => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/core/ChatbotEngine.js'),
    'utf8'
  );
  // Extract just the function definition
  const match = src.match(/function formatSlotDateTime\([\s\S]*?\n\}/m);
  if (!match) throw new Error('Could not locate formatSlotDateTime in ChatbotEngine.js');
  // eslint-disable-next-line no-new-func
  formatSlotDateTime = new Function(`${match[0]}; return formatSlotDateTime;`)();
});

// Reference UTC instant: 2026-07-01T00:00:00Z
// HK/SG/PH = UTC+8  → 08:00
// IN        = UTC+5:30 → 05:30
const UTC_MIDNIGHT = '2026-07-01T00:00:00Z';
// UTC 14:20 → HK 22:20, IN 19:50
const UTC_AFTERNOON = '2026-07-01T14:20:00Z';

describe('formatSlotDateTime — no timezone (baseline, UTC)', () => {
  test('returns a non-empty string for a valid ISO date', () => {
    const result = formatSlotDateTime(UTC_MIDNIGHT);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(4);
  });

  test('returns fallback string for invalid input', () => {
    expect(formatSlotDateTime('not-a-date')).toBe('not-a-date');
    expect(formatSlotDateTime('bad string')).toBe('bad string');
  });
});

describe('formatSlotDateTime — with timezone (HK = Asia/Hong_Kong, UTC+8)', () => {
  const tz = 'Asia/Hong_Kong';

  test('midnight UTC shows as 08:00 in HKT', () => {
    const result = formatSlotDateTime(UTC_MIDNIGHT, tz);
    expect(result).toMatch(/08:00/);
  });

  test('14:20 UTC shows as 22:20 in HKT', () => {
    const result = formatSlotDateTime(UTC_AFTERNOON, tz);
    expect(result).toMatch(/22:20/);
  });

  test('date portion is still 01 Jul 2026 for midnight UTC', () => {
    const result = formatSlotDateTime(UTC_MIDNIGHT, tz);
    expect(result).toMatch(/01 Jul 2026/);
  });

  test('uses 24-hour format (no AM/PM in output)', () => {
    const result = formatSlotDateTime(UTC_MIDNIGHT, tz);
    expect(result).not.toMatch(/am|pm/i);
  });
});

describe('formatSlotDateTime — with timezone (SG = Asia/Singapore, UTC+8)', () => {
  const tz = 'Asia/Singapore';

  test('midnight UTC shows as 08:00 SGT', () => {
    expect(formatSlotDateTime(UTC_MIDNIGHT, tz)).toMatch(/08:00/);
  });

  test('14:20 UTC shows as 22:20 SGT', () => {
    expect(formatSlotDateTime(UTC_AFTERNOON, tz)).toMatch(/22:20/);
  });
});

describe('formatSlotDateTime — with timezone (PH = Asia/Manila, UTC+8)', () => {
  const tz = 'Asia/Manila';

  test('midnight UTC shows as 08:00 PHT', () => {
    expect(formatSlotDateTime(UTC_MIDNIGHT, tz)).toMatch(/08:00/);
  });
});

describe('formatSlotDateTime — with timezone (IN = Asia/Kolkata, UTC+5:30)', () => {
  const tz = 'Asia/Kolkata';

  test('midnight UTC shows as 05:30 IST', () => {
    expect(formatSlotDateTime(UTC_MIDNIGHT, tz)).toMatch(/05:30/);
  });

  test('14:20 UTC shows as 19:50 IST', () => {
    expect(formatSlotDateTime(UTC_AFTERNOON, tz)).toMatch(/19:50/);
  });
});

describe('formatSlotDateTime — Date object input', () => {
  test('accepts a Date object (not just ISO string)', () => {
    const dt = new Date(UTC_MIDNIGHT);
    const result = formatSlotDateTime(dt, 'Asia/Hong_Kong');
    expect(result).toMatch(/08:00/);
  });
});

describe('formatSlotDateTime — backward-compatible: no tz arg still works', () => {
  test('omitting tz does not throw', () => {
    expect(() => formatSlotDateTime(UTC_MIDNIGHT)).not.toThrow();
  });

  test('omitting tz returns a string', () => {
    expect(typeof formatSlotDateTime(UTC_MIDNIGHT)).toBe('string');
  });
});
