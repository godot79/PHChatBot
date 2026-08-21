'use strict';

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

const { classifyIntent, NO_CLASSIFICATION, isConfident, isSlotAutofillable, isSlotSuggestable, KNOWN_INTENTS } = require('../../../src/core/NluRouter.js');

describe('NluRouter.classifyIntent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('parses a valid tool-use classification', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'tool_use', name: 'classify_intent', input: { intent: 'book_appointment', slots: { date: 'next tuesday' }, confidence: 0.92 } },
      ],
    });

    const result = await classifyIntent('book me a physio next tuesday afternoon');

    expect(result).toEqual({ intent: 'book_appointment', slots: { date: 'next tuesday' }, confidence: 0.92 });
  });

  test('passes a system prompt containing today\'s date, for relative-date resolution', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'classify_intent', input: { intent: 'book_specific_date', slots: {}, confidence: 0.9 } }],
    });

    await classifyIntent('book me next tuesday');

    const todayIso = new Date().toISOString().slice(0, 10);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ system: expect.stringContaining(todayIso) }));
  });

  test('API error falls through to sentinel, never throws', async () => {
    mockCreate.mockRejectedValue(new Error('network error'));

    const result = await classifyIntent('hello');

    expect(result).toEqual(NO_CLASSIFICATION);
  });

  test('missing tool_use block falls through to sentinel', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'oops' }] });

    const result = await classifyIntent('hello');

    expect(result).toEqual(NO_CLASSIFICATION);
  });

  test('malformed tool input (missing confidence) falls through to sentinel', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'classify_intent', input: { intent: 'book_appointment' } }],
    });

    const result = await classifyIntent('hello');

    expect(result).toEqual(NO_CLASSIFICATION);
  });

  test('timeout (rejected promise) falls through to sentinel', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'APIConnectionTimeoutError' }));

    const result = await classifyIntent('hello');

    expect(result).toEqual(NO_CLASSIFICATION);
  });
});

describe('NluRouter.isConfident', () => {
  test('true when confidence meets the configured threshold (default 0.7) and intent is known', () => {
    expect(isConfident({ intent: 'book_appointment', confidence: 0.7 })).toBe(true);
    expect(isConfident({ intent: KNOWN_INTENTS[0], confidence: 0.99 })).toBe(true);
  });

  test('false when confidence is below the threshold', () => {
    expect(isConfident({ intent: 'book_appointment', confidence: 0.69 })).toBe(false);
  });

  test('false for an unknown intent regardless of confidence', () => {
    expect(isConfident({ intent: 'order_pizza', confidence: 0.99 })).toBe(false);
  });

  test('false for the NO_CLASSIFICATION sentinel', () => {
    expect(isConfident(NO_CLASSIFICATION)).toBe(false);
  });
});

// Default thresholds (config/anthropic.js): autofill 0.85, suggest 0.5 — both
// explicitly placeholders, not calibrated values. These tests pin behavior
// against whatever the current config exports, not against hardcoded numbers.
describe('NluRouter.isSlotAutofillable / isSlotSuggestable', () => {
  const config = require('../../../src/config/anthropic.js');

  test('autofillable when slot confidence meets the autofill threshold', () => {
    expect(isSlotAutofillable({ value: 'physio', confidence: config.slotAutofillThreshold })).toBe(true);
    expect(isSlotSuggestable({ value: 'physio', confidence: config.slotAutofillThreshold })).toBe(false);
  });

  test('suggestable when slot confidence is between suggest and autofill thresholds', () => {
    const mid = (config.slotSuggestThreshold + config.slotAutofillThreshold) / 2;
    expect(isSlotSuggestable({ value: 'physio', confidence: mid })).toBe(true);
    expect(isSlotAutofillable({ value: 'physio', confidence: mid })).toBe(false);
  });

  test('neither autofillable nor suggestable below the suggest threshold', () => {
    const low = config.slotSuggestThreshold - 0.01;
    expect(isSlotAutofillable({ value: 'physio', confidence: low })).toBe(false);
    expect(isSlotSuggestable({ value: 'physio', confidence: low })).toBe(false);
  });

  test('false for a missing/empty slot value regardless of confidence', () => {
    expect(isSlotAutofillable({ value: '', confidence: 0.99 })).toBe(false);
    expect(isSlotSuggestable({ value: '', confidence: 0.99 })).toBe(false);
    expect(isSlotAutofillable(undefined)).toBe(false);
    expect(isSlotSuggestable(null)).toBe(false);
  });
});
