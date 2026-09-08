'use strict';

const { CLINIC_TRANSLATIONS, translateClinicName } = require('../../../src/config/clinicTranslations');

describe('clinicTranslations', () => {
  test('all 4 confirmed HK clinics are keyed by their real live Cliniko business_name', () => {
    expect(Object.keys(CLINIC_TRANSLATIONS)).toHaveLength(4);
    expect(CLINIC_TRANSLATIONS['Prohealth Sports & Spinal Physiotherapy Centres (WS)']).toBe('中環威靈頓街');
    expect(CLINIC_TRANSLATIONS['Prohealth Sports and Spinal Physiotherapy Centres (WWH)']).toBe('中環環球大廈');
    expect(CLINIC_TRANSLATIONS['Prohealth Sports and Spinal Physiotherapy Centres (TST)']).toBe('尖沙咀海洋中心');
    expect(CLINIC_TRANSLATIONS['Prohealth Sports and Spinal Physiotherapy Centre (QB)']).toBe('鰂魚涌太古坊');
  });

  // 2026-08-28: the table was previously keyed by generic location names
  // ("Wellington Street, Central") that never matched Cliniko's actual
  // business_name field — every clinic name fell back to English, always,
  // at all 4 real HK clinics. Confirmed live and rekeyed. Guard against
  // regressing to the old keys.
  test('the old (never-matching) location-name keys are gone', () => {
    for (const oldKey of [
      'Prohealth Sports and Spinal Physiotherapy Centres',
      'Ocean Centre, Tsim Sha Tsui',
      'World Wide House, Central',
      'Wellington Street, Central',
      'Tai Koo Place, Quarry Bay',
    ]) {
      expect(CLINIC_TRANSLATIONS[oldKey]).toBeUndefined();
    }
  });

  test('English language passes the name through untranslated', () => {
    expect(translateClinicName('Prohealth Sports & Spinal Physiotherapy Centres (WS)', 'en'))
      .toBe('Prohealth Sports & Spinal Physiotherapy Centres (WS)');
  });

  test.each(['yue', 'zh'])('%s translates a known clinic name to Chinese', (lang) => {
    expect(translateClinicName('Prohealth Sports & Spinal Physiotherapy Centres (WS)', lang)).toBe('中環威靈頓街');
    expect(translateClinicName('Prohealth Sports and Spinal Physiotherapy Centre (QB)', lang)).toBe('鰂魚涌太古坊');
  });

  test('the WS clinic uses "&" not "and" — matching Cliniko exactly, not a normalized/lenient match', () => {
    // Cliniko itself is inconsistent (WS uses "&", the other three use "and"/singular
    // "Centre" for QB) — this table has no normalization, so it must match verbatim.
    const warn = jest.fn();
    expect(translateClinicName('Prohealth Sports and Spinal Physiotherapy Centres (WS)', 'yue', { warn })).toBe(
      'Prohealth Sports and Spinal Physiotherapy Centres (WS)'
    );
    expect(warn).toHaveBeenCalled();
  });

  test('an untabled clinic name falls back to English and logs a warning (never blocks booking)', () => {
    const warn = jest.fn();
    const result = translateClinicName('Some New Clinic', 'yue', { warn });
    expect(result).toBe('Some New Clinic');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Some New Clinic'));
  });

  test('a falsy name is returned as-is without throwing', () => {
    expect(translateClinicName('', 'yue')).toBe('');
    expect(translateClinicName(undefined, 'yue')).toBeUndefined();
  });

  test('missing logger does not throw on a lookup miss', () => {
    expect(() => translateClinicName('Unknown Clinic', 'zh')).not.toThrow();
  });
});
