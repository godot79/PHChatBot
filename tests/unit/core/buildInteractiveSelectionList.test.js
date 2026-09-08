/**
 * Tests for buildInteractiveSelectionList — the shared pagination/list-chrome
 * builder used by every selection screen in the app (appointment types,
 * physios, clinics, dates, and more — 26 call sites in ChatbotEngine.js).
 *
 * Regression guard for the bug fixed 2026-08-28: this function's nav chrome
 * ("← Previous", "M. More", "0. Back", "Tap to select, or type a number.",
 * the list button label) was fully hardcoded English with no language
 * parameter at all — every paginated list in every yue/zh flow showed this
 * English chrome mixed in with otherwise-correctly-translated row content.
 * Found via a live full-flow walk across every booking funnel.
 *
 * Same extraction approach as formatSlotDateTime.test.js: pull the actual
 * production function out of ChatbotEngine.js rather than testing a copy.
 */

const fs = require('fs');
const path = require('path');
const { MessageEnvelope } = require('../../../src/core/MessageBuilder');
const { t } = require('../../../src/config/strings');

let buildInteractiveSelectionList;
beforeAll(() => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/core/ChatbotEngine.js'),
    'utf8'
  );
  const match = src.match(/function buildInteractiveSelectionList\([\s\S]*?\n\}/m);
  if (!match) throw new Error('Could not locate buildInteractiveSelectionList in ChatbotEngine.js');
  // eslint-disable-next-line no-new-func
  buildInteractiveSelectionList = new Function(
    'MessageEnvelope', 't', 'INTERACTIVE_SELECT_PAGE_FIRST', 'INTERACTIVE_SELECT_PAGE_REST',
    `${match[0]}; return buildInteractiveSelectionList;`
  )(MessageEnvelope, t, 5, 4);
});

const items = ['A', 'B', 'C', 'D', 'E', 'F', 'G']; // 7 items -> forces pagination (page size 5)

function build(language, page = 0) {
  return buildInteractiveSelectionList({
    header: 'Pick one',
    items,
    rowFn: (item) => ({ title: item }),
    page,
    language,
  });
}

describe('buildInteractiveSelectionList — language-aware nav chrome', () => {
  test('defaults to English when language is omitted (backward compatible)', () => {
    const envelope = buildInteractiveSelectionList({ header: 'Pick one', items, rowFn: (i) => ({ title: i }), page: 0 });
    expect(envelope.interactive.action.button).toBe('Select option');
    const rows = envelope.interactive.action.sections[0].rows;
    expect(rows.some(r => r.title === 'More →')).toBe(true);
    expect(rows.some(r => r.title === '← Back')).toBe(true);
  });

  test.each(['en', 'yue', 'zh'])('%s: list rows carry the translated "More" and "Back" labels', (lang) => {
    const envelope = build(lang, 0);
    const rows = envelope.interactive.action.sections[0].rows;
    expect(rows.some(r => r.title === t(lang, 'listNav.moreLabel'))).toBe(true);
    expect(rows.some(r => r.title === t(lang, 'listNav.backLabel'))).toBe(true);
  });

  test.each(['en', 'yue', 'zh'])('%s: page 2 (has a "Previous" row) carries the translated Previous label', (lang) => {
    const envelope = build(lang, 1);
    const rows = envelope.interactive.action.sections[0].rows;
    expect(rows.some(r => r.title === t(lang, 'listNav.previousLabel'))).toBe(true);
  });

  test.each(['en', 'yue', 'zh'])('%s: body text carries the translated tap-to-select instruction, not the English one', (lang) => {
    const envelope = build(lang, 0);
    const body = envelope.interactive.body.text;
    expect(body).toContain(t(lang, 'listNav.tapToSelectInstruction'));
    if (lang !== 'en') {
      expect(body).not.toContain('Tap to select, or type a number.');
    }
  });

  test.each(['yue', 'zh'])('%s: the list button label is translated, not "Select option"', (lang) => {
    const envelope = build(lang, 0);
    expect(envelope.interactive.action.button).toBe(t(lang, 'listNav.selectOptionButton'));
    expect(envelope.interactive.action.button).not.toBe('Select option');
  });

  test.each(['yue', 'zh'])('%s: text fallback (non-interactive clients) carries translated nav, not English', (lang) => {
    const envelope = build(lang, 0);
    expect(String(envelope)).not.toMatch(/0\. Back|M\. More|Reply with number or option above\./);
  });
});
