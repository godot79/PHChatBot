'use strict';
/**
 * Cross-process mutex so live-Cliniko test files never run concurrently.
 *
 * When the whole repo suite runs (`npx jest`), Jest spreads test files across
 * parallel worker processes. cliniko.live.test.js and
 * reschedule_type_preservation.write.test.js both make real HTTP calls to the
 * same Cliniko account; running at the same time causes genuine 429s that have
 * nothing to do with either file's own logic (confirmed 2026-08-06 — 29 real
 * 429s from /businesses in one run, tracing to concurrent-process load, not a
 * caching bug). Uses fs.mkdir's atomicity as a simple cross-process lock.
 */
const fs = require('fs');
const path = require('path');

const LOCK_DIR = path.join(__dirname, '.live-test.lock');
const POLL_MS = 250;
const MAX_WAIT_MS = 60_000;

async function acquireLiveLock() {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > MAX_WAIT_MS) {
        // Stale lock from a crashed prior run — reclaim rather than hang forever.
        try { fs.rmdirSync(LOCK_DIR); } catch { /* another process may have just released it */ }
        continue;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

function releaseLiveLock() {
  try { fs.rmdirSync(LOCK_DIR); } catch { /* already released or never acquired */ }
}

module.exports = { acquireLiveLock, releaseLiveLock };
