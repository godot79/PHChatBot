// File: src/core/BulkContext.js
// Marks the current async call chain as "bulk" so SendMessage can throttle
// concurrency for fan-out operations (e.g. BOOK_SOONEST's ~30-40 practitioner
// sweep) without affecting single-call requests from other users/flows.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

// TODO(calibrate): placeholder value, not a measured number. Borrowed from
// BULK_CONCURRENCY_LIMIT (SendMessage.js) purely as a starting point — that
// number was properly calibrated (real HK data, zero-failure ceiling) for a
// DIFFERENT question (how much concurrency Cliniko's gateway tolerates), not
// this one (how long a fan-out should wait before giving up and degrading).
// Revisit the same way: measure real bulkAll durations under both healthy
// and congested conditions, then pick the ceiling from that data.
const DEFAULT_BULK_TIMEOUT_MS = Number(process.env.BULK_FANOUT_TIMEOUT_MS ?? 8000);

/** Run `fn` with bulk mode bound for the current async chain. */
function run(fn) { return als.run({ bulk: true }, fn); }

/** True if the current async chain is inside a bulk-flagged operation. */
function isBulk() { return !!als.getStore()?.bulk; }

/**
 * Drop-in replacement for `Promise.all(items.map(fn))` for Cliniko fan-outs.
 * Flags the enclosing async chain as bulk so every SendMessage call made
 * inside `fn` throttles against SendMessage's shared bulk concurrency cap
 * instead of firing all of them at Cliniko at once. Regular (non-bulk) calls
 * never check this flag and are entirely unaffected.
 *
 * Must map lazily (items + fn, not a pre-built array of promises) — an async
 * function starts running synchronously up to its first await the moment
 * it's called, so the bulk flag has to be set before `fn` is invoked, not
 * after.
 *
 * Bounded by an overall deadline (timeoutMs, default DEFAULT_BULK_TIMEOUT_MS,
 * 0 disables it) so a congested Cliniko account can't leave a caller waiting
 * indefinitely — every fan-out gets this centrally, not per call site. Under
 * healthy conditions this is a no-op: behaves exactly like plain
 * Promise.all(items.map(fn)), including rethrowing on a real rejection. If
 * the deadline is hit first, returns whatever has resolved so far (still
 * awaiting each item's OWN promise for its final value, not aborting them —
 * this only stops waiting, it doesn't cancel the underlying request) as a
 * same-length array with a non-enumerable _partial marker, same convention
 * ClinikoAPI/_appointmentTypeHelpers already use for a degraded result.
 * Items that hadn't settled by the deadline come back as `undefined` at
 * their index — every existing bulkAll caller already defensively falls
 * back on a falsy entry (e.g. `(results[i] || [])`), so this degrades the
 * same way a genuinely failed individual fetch already does.
 */
function bulkAll(items, fn, { timeoutMs = DEFAULT_BULK_TIMEOUT_MS } = {}) {
  return run(async () => {
    const promises = items.map(fn);
    if (!(timeoutMs > 0)) return Promise.all(promises);

    const settled = new Array(items.length);
    promises.forEach((p, i) => { p.then((v) => { settled[i] = v; }, () => {}); });

    let timer;
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve('TIMED_OUT'), timeoutMs); });
    const winner = await Promise.race([Promise.all(promises).then((v) => ({ v })), timedOut]);
    clearTimeout(timer);

    if (winner === 'TIMED_OUT') {
      const arr = settled.slice();
      Object.defineProperty(arr, '_partial', { value: true, enumerable: false, configurable: true });
      return arr;
    }
    return winner.v;
  });
}

module.exports = { run, isBulk, bulkAll, DEFAULT_BULK_TIMEOUT_MS };
