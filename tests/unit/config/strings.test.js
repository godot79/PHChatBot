'use strict';

const { STRINGS, t } = require('../../../src/config/strings');

describe('strings — content-quality regression guards (2026-08-28 audit)', () => {
  describe('register consistency', () => {
    test('zh block uses formal 您 throughout — no informal 你 leaks in', () => {
      // insurerNoMatch.suffix previously used 你 twice while every other zh
      // string uses 您 — this is a systematic sweep, not just that one key,
      // so any future zh addition that slips back to 你 fails loudly here.
      const zhText = JSON.stringify(STRINGS.zh);
      expect(zhText).not.toContain('你');
    });

    test('insurerNoMatch.suffix (zh) specifically uses 您, not 你', () => {
      const result = t('zh', 'insurerNoMatch.suffix', { insurer: 'Bupa' });
      expect(result).toContain('您');
      expect(result).not.toContain('你');
    });
  });

  describe('no untranslated English leaking into yue strings', () => {
    test('bookSoonest.funnelLastTime (yue) does not contain the English word "book"', () => {
      const result = t('yue', 'bookSoonest.funnelLastTime', { label: 'Physio with Jolinna' });
      expect(result.toLowerCase()).not.toContain('book');
      expect(result).toContain('預約');
    });

    test('bookSoonest.funnelWhatType (yue) does not contain the English word "book"', () => {
      const result = t('yue', 'bookSoonest.funnelWhatType');
      expect(result.toLowerCase()).not.toContain('book');
      expect(result).toContain('預約');
    });
  });

  describe('oneUpcomingIntro simplification (dropped "upcoming" per user feedback, 2026-08-27)', () => {
    const cases = [
      ['yue', 'cancelFlow.oneUpcomingIntro', '你有一個預約：'],
      ['zh', 'cancelFlow.oneUpcomingIntro', '您有一个预约：'],
      ['yue', 'rescheduleFlow.oneUpcomingIntro', '你有一個預約：'],
      ['zh', 'rescheduleFlow.oneUpcomingIntro', '您有一个预约：'],
      ['yue', 'rescheduleFlow.oneUpcomingIntroPlain', '你有一個預約：'],
      ['zh', 'rescheduleFlow.oneUpcomingIntroPlain', '您有一个预约：'],
    ];

    test.each(cases)('%s %s starts with the simplified phrasing, no "upcoming" qualifier', (lang, key, expectedPrefix) => {
      const result = t(lang, key, { physio: 'Jolinna Chan', type: 'Follow-up', date: '01 Jan 2026' });
      expect(result.startsWith(expectedPrefix)).toBe(true);
      expect(result).not.toMatch(/即將嚟嘅|即将到来的/);
    });

    // upcomingAppointmentsHeader is a *list* header (possibly several
    // appointments) — a different grammatical context, deliberately left
    // unchanged, not part of this fix. Guard against accidentally touching it.
    test('upcomingAppointmentsHeader (list header, unaffected) still carries its "upcoming" qualifier', () => {
      expect(t('yue', 'cancelFlow.upcomingAppointmentsHeader')).toMatch(/即將嚟嘅/);
      expect(t('zh', 'cancelFlow.upcomingAppointmentsHeader')).toMatch(/即将到来的/);
    });
  });
});
