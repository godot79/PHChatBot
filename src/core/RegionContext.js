// File: src/core/RegionContext.js
// Binds a region value to the current async call chain.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

/**
 * RegionContext
 * Why: let Cliniko headers pick the right API key per session without changing call sites.
 */
module.exports = {
  /** Run `fn` with `region` bound for the current async chain. */
  run(region, fn) { return als.run({ region: String(region || '').toUpperCase() }, fn); },
  /** Read the bound region. */
  get() { return als.getStore()?.region; }
};

