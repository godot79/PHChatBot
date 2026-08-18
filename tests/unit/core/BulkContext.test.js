'use strict';

describe('BulkContext.bulkAll — overall deadline', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  test('defaults to 8000ms when BULK_FANOUT_TIMEOUT_MS is unset', () => {
    delete process.env.BULK_FANOUT_TIMEOUT_MS;
    const BulkContext = require('../../../src/core/BulkContext');
    expect(BulkContext.DEFAULT_BULK_TIMEOUT_MS).toBe(8000);
  });

  test('is configurable via BULK_FANOUT_TIMEOUT_MS', () => {
    process.env.BULK_FANOUT_TIMEOUT_MS = '500';
    const BulkContext = require('../../../src/core/BulkContext');
    expect(BulkContext.DEFAULT_BULK_TIMEOUT_MS).toBe(500);
  });

  test('healthy case: behaves exactly like Promise.all when everything resolves before the deadline', async () => {
    const BulkContext = require('../../../src/core/BulkContext');
    const result = await BulkContext.bulkAll([1, 2, 3], (x) => Promise.resolve(x * 10));
    expect(result).toEqual([10, 20, 30]);
    expect(result._partial).toBeUndefined();
  });

  test('a real rejection before the deadline still propagates (preserves Promise.all semantics)', async () => {
    const BulkContext = require('../../../src/core/BulkContext');
    await expect(
      BulkContext.bulkAll([1, 2], (x) => (x === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(x)))
    ).rejects.toThrow('boom');
  });

  test('items still pending when the deadline hits come back as undefined, array tagged _partial', async () => {
    jest.useFakeTimers();
    const BulkContext = require('../../../src/core/BulkContext');
    let resolveSlow;
    const slow = new Promise((r) => { resolveSlow = r; });

    const resultPromise = BulkContext.bulkAll(
      ['fast', 'slow'],
      (item) => (item === 'fast' ? Promise.resolve('fast-value') : slow),
      { timeoutMs: 1000 }
    );

    // Let the fast item resolve, then push past the deadline.
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    const result = await resultPromise;
    expect(result[0]).toBe('fast-value');
    expect(result[1]).toBeUndefined();
    expect(result._partial).toBe(true);

    resolveSlow('too-late'); // clean up the still-pending promise
    jest.useRealTimers();
  });

  test('timeoutMs: 0 disables the deadline entirely — waits forever for real work', async () => {
    const BulkContext = require('../../../src/core/BulkContext');
    const result = await BulkContext.bulkAll(
      [1, 2],
      (x) => new Promise((resolve) => setTimeout(() => resolve(x), 5)),
      { timeoutMs: 0 }
    );
    expect(result).toEqual([1, 2]);
    expect(result._partial).toBeUndefined();
  });

  test('isBulk() is true during the call and false again after, even when the deadline is hit', async () => {
    jest.useFakeTimers();
    const BulkContext = require('../../../src/core/BulkContext');
    expect(BulkContext.isBulk()).toBe(false);

    let sawBulkInside = null;
    let resolveSlow;
    const slow = new Promise((r) => { resolveSlow = r; });
    const resultPromise = BulkContext.bulkAll(['x'], async () => {
      sawBulkInside = BulkContext.isBulk();
      return slow;
    }, { timeoutMs: 1000 });

    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    await resultPromise;

    expect(sawBulkInside).toBe(true);
    expect(BulkContext.isBulk()).toBe(false);

    resolveSlow('too-late');
    jest.useRealTimers();
  });
});
