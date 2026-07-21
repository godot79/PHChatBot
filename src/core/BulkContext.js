// File: src/core/BulkContext.js
// Marks the current async call chain as "bulk" so SendMessage can throttle
// concurrency for fan-out operations (e.g. BOOK_SOONEST's ~30-40 practitioner
// sweep) without affecting single-call requests from other users/flows.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

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
 */
function bulkAll(items, fn) {
  return run(() => Promise.all(items.map(fn)));
}

module.exports = { run, isBulk, bulkAll };
