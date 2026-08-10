'use strict';

const { CLINIC_TRANSLATIONS, translateClinicName } = require('../../../src/config/clinicTranslations');

describe('clinicTranslations', () => {
  test('all 5 confirmed HK clinics have a Chinese translation', () => {
    expect(Object.keys(CLINIC_TRANSLATIONS)).toHaveLength(5);
    expect(CLINIC_TRANSLATIONS['Prohealth Sports and Spinal Physiotherapy Centres']).toBe('Prohealth 運動與脊椎物理治療中心');
    expect(CLINIC_TRANSLATIONS['Ocean Centre, Tsim Sha Tsui']).toBe('尖沙咀海洋中心');
    expect(CLINIC_TRANSLATIONS['World Wide House, Central']).toBe('中環環球大廈');
    expect(CLINIC_TRANSLATIONS['Wellington Street, Central']).toBe('中環威靈頓街');
    expect(CLINIC_TRANSLATIONS['Tai Koo Place, Quarry Bay']).toBe('鰂魚涌太古坊');
  });

  test('English language passes the name through untranslated', () => {
    expect(translateClinicName('Wellington Street, Central', 'en')).toBe('Wellington Street, Central');
  });

  test.each(['yue', 'zh'])('%s translates a known clinic name to Chinese', (lang) => {
    expect(translateClinicName('Wellington Street, Central', lang)).toBe('中環威靈頓街');
    expect(translateClinicName('Tai Koo Place, Quarry Bay', lang)).toBe('鰂魚涌太古坊');
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
