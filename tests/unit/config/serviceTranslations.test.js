'use strict';

const { SERVICE_TRANSLATIONS, translateServiceName } = require('../../../src/config/serviceTranslations');

describe('serviceTranslations', () => {
  test('has 6 entries (7 real HK service categories minus the trademarked GYROTONIC® METHOD)', () => {
    expect(Object.keys(SERVICE_TRANSLATIONS)).toHaveLength(6);
  });

  test('English language passes the name through untranslated', () => {
    expect(translateServiceName('Osteopathy', 'en')).toBe('Osteopathy');
  });

  test.each(['yue', 'zh'])('%s translates all 6 known service categories', (lang) => {
    for (const name of Object.keys(SERVICE_TRANSLATIONS)) {
      expect(translateServiceName(name, lang)).toBe(SERVICE_TRANSLATIONS[name][lang]);
    }
  });

  // GYROTONIC® METHOD is a registered trademark for a specific branded exercise
  // method — deliberately left untranslated, same treatment as other brand
  // names (e.g. WhatsApp) elsewhere in this app. Confirmed intentional, not a gap.
  test('GYROTONIC® METHOD is deliberately absent and falls back to English + logs a warning', () => {
    const warn = jest.fn();
    const result = translateServiceName('GYROTONIC® METHOD', 'yue', { warn });
    expect(result).toBe('GYROTONIC® METHOD');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GYROTONIC® METHOD'));
  });

  test('an untabled service (future new category) falls back to English and logs a warning', () => {
    const warn = jest.fn();
    const result = translateServiceName('Some Brand New Service', 'zh', { warn });
    expect(result).toBe('Some Brand New Service');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Some Brand New Service'));
  });

  test('a falsy name is returned as-is without throwing', () => {
    expect(translateServiceName('', 'yue')).toBe('');
    expect(translateServiceName(undefined, 'yue')).toBeUndefined();
  });
});
