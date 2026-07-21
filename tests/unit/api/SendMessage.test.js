'use strict';

jest.mock('axios');
jest.mock('../../../src/api/ClinikoHeaders.js', () => ({
  build: jest.fn(() => ({ Authorization: 'Basic test' })),
}));

const axios = require('axios');
const BulkContext = require('../../../src/core/BulkContext');
const SendMessage = require('../../../src/api/SendMessage');

describe('SendMessage — bulk concurrency gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('non-bulk calls fire immediately, unthrottled, regardless of volume', async () => {
    let started = 0;
    axios.get.mockImplementation(() => {
      started++;
      return Promise.resolve({ data: {} });
    });

    const calls = Array.from({ length: 30 }, () => new SendMessage('/x', {}).get());
    await Promise.all(calls);

    expect(started).toBe(30); // no throttling — none of these were ever flagged bulk
  });

  // Regression: firing all ~30-40 practitioner requests at once regularly
  // overwhelmed Cliniko's gateway and cascaded into mass 15s timeouts
  // (confirmed live 2026-07-21). This proves the actual throttling mechanism,
  // not just that callers remember to batch their own array client-side.
  test('bulk-flagged calls beyond BULK_CONCURRENCY_LIMIT queue until a slot frees up', async () => {
    const started = [];
    const resolvers = [];
    axios.get.mockImplementation(() => {
      started.push(started.length);
      return new Promise((resolve) => resolvers.push(() => resolve({ data: {} })));
    });

    const limit = SendMessage.BULK_CONCURRENCY_LIMIT;
    const total = limit + 3; // guarantees some calls must queue
    const items = Array.from({ length: total }, (_, i) => i);

    const resultPromise = BulkContext.bulkAll(items, () => new SendMessage('/x', {}).get());
    await new Promise((r) => setImmediate(r));

    // Only the concurrency limit's worth have actually reached axios so far
    expect(started.length).toBe(limit);

    // Resolve the in-flight batch — the queued ones should now start
    resolvers.splice(0).forEach((r) => r());
    await new Promise((r) => setImmediate(r));

    expect(started.length).toBe(total);

    resolvers.splice(0).forEach((r) => r());
    await resultPromise;
  });

  // The whole point of gating on a bulk flag rather than SendMessage globally:
  // an unrelated single call (e.g. a different user's booking) must not sit
  // behind a saturated bulk fan-out queue.
  test('a saturated bulk queue does not block a concurrent non-bulk call', async () => {
    const bulkResolvers = [];
    let nonBulkStarted = false;

    axios.get.mockImplementation((url) => {
      if (url.includes('/bulk-item')) {
        return new Promise((resolve) => bulkResolvers.push(() => resolve({ data: {} })));
      }
      nonBulkStarted = true;
      return Promise.resolve({ data: {} });
    });

    const limit = SendMessage.BULK_CONCURRENCY_LIMIT;
    const items = Array.from({ length: limit + 2 }, (_, i) => i);
    // Fill the bulk queue past capacity and leave it unresolved.
    const bulkPromise = BulkContext.bulkAll(items, () => new SendMessage('/bulk-item', {}).get());
    await new Promise((r) => setImmediate(r));

    // A regular single call made outside any bulk context proceeds immediately.
    await new SendMessage('/single-item', {}).get();
    expect(nonBulkStarted).toBe(true);

    // Clean up the still-pending bulk calls so the test doesn't hang.
    bulkResolvers.splice(0).forEach((r) => r());
    await new Promise((r) => setImmediate(r));
    bulkResolvers.splice(0).forEach((r) => r());
    await bulkPromise;
  });
});
