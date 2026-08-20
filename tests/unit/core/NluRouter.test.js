'use strict';

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

const { classifyIntent, NO_CLASSIFICATION, isConfident, KNOWN_INTENTS } = require('../../../src/core/NluRouter.js');

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
