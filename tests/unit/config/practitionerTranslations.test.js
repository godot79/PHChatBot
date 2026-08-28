'use strict';

const { PRACTITIONER_TRANSLATIONS, translatePractitionerName } = require('../../../src/config/practitionerTranslations');

describe('practitionerTranslations', () => {
  test('has 30 entries (25 base + 5 resolved: Kris Chow, Annika Leung, Bonnie Ung, Kelvin Yau, Kelvin Young)', () => {
    expect(Object.keys(PRACTITIONER_TRANSLATIONS)).toHaveLength(30);
  });

  test('English language passes the name through untranslated', () => {
    expect(translatePractitionerName('Leo Choi', 'en')).toBe('Leo Choi');
  });

  test.each(['yue', 'zh'])('%s translates a known practitioner name to Chinese', (lang) => {
    expect(translatePractitionerName('Leo Choi', lang)).toBe('蔡楚基');
    expect(translatePractitionerName('Alicia Lam', lang)).toBe('林雅莉');
  });

  test('the two resolved Kelvin entries are distinct people, not merged', () => {
    expect(translatePractitionerName('Kelvin Yau', 'yue')).toBe('邱子豐');
    expect(translatePractitionerName('Kelvin Young', 'yue')).toBe('楊凱程');
    expect(translatePractitionerName('Kelvin Yau', 'yue')).not.toBe(translatePractitionerName('Kelvin Young', 'yue'));
  });

  test('Bonnie is keyed by the corrected Cliniko surname "Ung", not the old "Ong"', () => {
    expect(translatePractitionerName('Bonnie Ung', 'yue')).toBe('吳婷婷');
    expect(PRACTITIONER_TRANSLATIONS['Bonnie Ong']).toBeUndefined();
  });

  // 2026-08-28: these 5 keys were transcribed wrong from the source PDF (see file
  // header) — live Cliniko data showed different last names/spacing. Confirmed
  // live: Amanda Kot, Arnold Tsang, Maritza Lue, Carmen Koo, Yifan Jia (no space).
  test.each([
    ['Amanda Kot', 'Amanda Ko', '葛妍彤'],
    ['Arnold Tsang', 'Arnold Tseng', '曾子瑜'],
    ['Maritza Lue', 'Maritza Lai', '雷小嫱'],
    ['Carmen Koo', 'Carmen Ku', '顧芷慜'],
    ['Yifan Jia', 'Yi Fan Jia', '賈一凡'],
  ])('is keyed by the corrected Cliniko name "%s", not the old "%s"', (correctKey, oldKey, expected) => {
    expect(translatePractitionerName(correctKey, 'yue')).toBe(expected);
    expect(PRACTITIONER_TRANSLATIONS[oldKey]).toBeUndefined();
  });

  test('confirmed no-Chinese-name practitioners (Greg Lock, Suki Law, Yashmita Changlani, Etienne Simonnet) fall back to English and log a warning', () => {
    for (const name of ['Greg Lock', 'Suki Law', 'Yashmita Changlani', 'Etienne Simonnet']) {
      const warn = jest.fn();
      expect(translatePractitionerName(name, 'yue', { warn })).toBe(name);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(name));
    }
  });

  test('an untabled practitioner (e.g. a future new hire) falls back to English and logs a warning', () => {
    const warn = jest.fn();
    const result = translatePractitionerName('New Hire Name', 'zh', { warn });
    expect(result).toBe('New Hire Name');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('New Hire Name'));
  });

  test('a falsy name is returned as-is without throwing', () => {
    expect(translatePractitionerName('', 'yue')).toBe('');
    expect(translatePractitionerName(undefined, 'yue')).toBeUndefined();
  });
});
