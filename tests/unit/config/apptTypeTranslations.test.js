'use strict';

const { APPT_TYPE_TRANSLATIONS, translateApptTypeName, normName } = require('../../../src/config/apptTypeTranslations');

describe('apptTypeTranslations', () => {
  test('has 32 entries (33 "certain" PDF entries minus the flagged soft-tissue-release type)', () => {
    expect(Object.keys(APPT_TYPE_TRANSLATIONS)).toHaveLength(32);
  });

  test('English language passes the name through untranslated', () => {
    expect(translateApptTypeName('New Patient', 'en')).toBe('New Patient');
  });

  test('yue and zh use different wording for the same type (not shared like clinic/insurer)', () => {
    expect(translateApptTypeName('New Patient', 'yue')).toBe('新症');
    expect(translateApptTypeName('New Patient', 'zh')).toBe('新患者');
    expect(translateApptTypeName('New Patient', 'yue')).not.toBe(translateApptTypeName('New Patient', 'zh'));
  });

  test('lookup is normName-keyed, so hyphen/spacing variants of the same type still match', () => {
    expect(translateApptTypeName('Follow Up Appointment', 'yue')).toBe('覆診');
    expect(translateApptTypeName('Follow-Up Appointment', 'yue')).toBe('覆診');
    expect(translateApptTypeName('follow   up appointment', 'yue')).toBe('覆診');
  });

  test('the flagged "Clinical Soft Tissue Release Treatment - Manual" is deliberately absent and falls back to English + logs a warning', () => {
    const warn = jest.fn();
    const result = translateApptTypeName('Clinical Soft Tissue Release Treatment - Manual', 'yue', { warn });
    expect(result).toBe('Clinical Soft Tissue Release Treatment - Manual');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Clinical Soft Tissue Release Treatment - Manual'));
  });

  test('a doubtful/no-idea PDF entry (VALD Assessment, Complimentary Voucher) falls back to English + logs a warning', () => {
    for (const name of ['VALD Assessment', 'Complimentary Voucher']) {
      const warn = jest.fn();
      expect(translateApptTypeName(name, 'zh', { warn })).toBe(name);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(name));
    }
  });

  test('an untabled type (future new Cliniko type) falls back to English and logs a warning', () => {
    const warn = jest.fn();
    const result = translateApptTypeName('Some Brand New Type', 'yue', { warn });
    expect(result).toBe('Some Brand New Type');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Some Brand New Type'));
  });

  test('a falsy name is returned as-is without throwing', () => {
    expect(translateApptTypeName('', 'yue')).toBe('');
    expect(translateApptTypeName(undefined, 'yue')).toBeUndefined();
  });

  test('normName is exported and idempotent', () => {
    expect(normName('Follow-Up Appointment')).toBe(normName(normName('Follow-Up Appointment')));
  });
});
