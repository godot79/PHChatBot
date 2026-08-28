/**
 * Tests for getPractitionerDisplayName — the single choke point every
 * user-facing practitioner name (physio lists, booking confirmations, cancel/
 * reschedule/history enrichment) is rendered through.
 *
 * Regression guard for the bug fixed 2026-08-28: Cliniko lets a clinic set
 * display_name to a first-name-only (or title-prefixed) value per
 * practitioner, independent of the reliable first_name/last_name fields.
 * The function must prefer the structured name over that freeform field, or
 * it silently shows an incomplete English name AND fails yue/zh translation
 * lookups (which are keyed by full name). Confirmed live for 8 real HK
 * practitioners before this fix.
 *
 * Same extraction approach as formatSlotDateTime.test.js: pull the actual
 * production function out of ChatbotEngine.js rather than testing a copy.
 */

const fs = require('fs');
const path = require('path');
const { translatePractitionerName } = require('../../../src/config/practitionerTranslations');

let getPractitionerDisplayName;
beforeAll(() => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/core/ChatbotEngine.js'),
    'utf8'
  );
  const match = src.match(/function getPractitionerDisplayName\([\s\S]*?\n\}/m);
  if (!match) throw new Error('Could not locate getPractitionerDisplayName in ChatbotEngine.js');
  // eslint-disable-next-line no-new-func
  getPractitionerDisplayName = new Function(
    'translatePractitionerName',
    `${match[0]}; return getPractitionerDisplayName;`
  )(translatePractitionerName);
});

describe('getPractitionerDisplayName', () => {
  test('prefers first_name+last_name over a first-name-only display_name (the live bug)', () => {
    const practitioner = { first_name: 'Alicia', last_name: 'Lam', display_name: 'Alicia' };
    expect(getPractitionerDisplayName(practitioner, 'en')).toBe('Alicia Lam');
  });

  test('the full name (not the truncated display_name) is what feeds yue/zh translation', () => {
    const practitioner = { first_name: 'Alicia', last_name: 'Lam', display_name: 'Alicia' };
    expect(getPractitionerDisplayName(practitioner, 'yue')).toBe('林雅莉');
  });

  test('prefers first_name+last_name over a title-prefixed display_name', () => {
    const practitioner = { first_name: 'Jane', last_name: 'Tan', display_name: 'Dr. Jane Tan' };
    expect(getPractitionerDisplayName(practitioner, 'en')).toBe('Jane Tan');
  });

  test('falls back to display_name when first_name/last_name are both absent', () => {
    const practitioner = { display_name: 'Dr Test' };
    expect(getPractitionerDisplayName(practitioner, 'en')).toBe('Dr Test');
  });

  test('falls back to "Practitioner" when nothing is available', () => {
    expect(getPractitionerDisplayName({}, 'en')).toBe('Practitioner');
  });

  test('returns "Practitioner" for a null/undefined practitioner', () => {
    expect(getPractitionerDisplayName(null, 'en')).toBe('Practitioner');
    expect(getPractitionerDisplayName(undefined, 'en')).toBe('Practitioner');
  });
});
