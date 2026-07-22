'use strict';
/**
 * Reproduces the 2026-07-19 23:24 production incident: a verified user goes
 * idle past the 30-minute session TTL. The periodic cleanup job (every 10 min)
 * hard-deletes the expired session row before the user's next message arrives.
 * getOrCreateSession()'s "seed from prior session" carryover depends on that
 * row still existing, so it silently loses verified status — the next message
 * (e.g. tapping "Try Again", which sends "1") gets interpreted under a fresh
 * INTRO session, routing "1" into patient registration instead of resuming
 * booking.
 *
 * Uses the real DatabaseManager (real SQLite schema, real ALTER TABLE
 * migration, real column types) and real SessionManager — no mocking — since
 * the bug lives in how the two interact, not in either one's isolated logic.
 */

jest.mock('../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, analyticsEvent: () => {},
    child: function () { return this; },
  }))
);

// DatabaseManager hardcodes its file path (no override hook), so redirect
// the underlying sqlite3.Database constructor to :memory: — this must not
// write to the real, git-tracked database.sqlite.
jest.mock('sqlite3', () => {
  const actual = jest.requireActual('sqlite3');
  const verboseModule = actual.verbose();
  return {
    verbose: () => ({
      ...verboseModule,
      Database: function (_dbPath, cb) {
        return new verboseModule.Database(':memory:', cb);
      },
    }),
  };
});

const DatabaseManager = require('../../src/core/DatabaseManager');
const SessionManager = require('../../src/core/SessionManager');

describe('Verified-user carryover survives session expiry + cleanup', () => {
  let db, sm;
  const phone = '+85298377469';

  beforeEach(async () => {
    db = new DatabaseManager();
    await db.initialize();
    sm = new SessionManager(db);
    await sm.initialize();
  });

  afterEach(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });

  test('a verified session that expires and gets cleaned up still routes the next message to BOOK_MANAGE_OPTIONS, not INTRO', async () => {
    const s1 = await sm.getOrCreateSession(phone);
    expect(s1.conversation_state).toBe('INTRO');

    // Simulate a successful VERIFY (mirrors ChatbotEngine.js handleVerifyState's success path)
    await sm.updateSession(s1.id, { verified: true, patient_id: 'PAT-123', conversation_state: 'BOOK_MANAGE_OPTIONS' });
    await db.upsertPatientState(phone, { patient_id: 'PAT-123', verified: true });

    // Expire the session, then run the SAME cleanup job production runs every 10 min —
    // this deletes the row the old "seed from prior session" logic depended on.
    await db.query(`UPDATE sessions SET expires_at = datetime('now', '-1 minutes') WHERE id = ?`, [s1.id]);
    const cleaned = await db.cleanupExpiredSessions();
    expect(cleaned).toBeGreaterThan(0);
    expect(await db.getSession(s1.id)).toBeNull(); // row is really gone

    // User's next message ("Try Again" -> "1") arrives after the row was purged.
    const s2 = await sm.getOrCreateSession(phone);

    expect(s2.conversation_state).toBe('BOOK_MANAGE_OPTIONS');
    expect(s2.verified).toBeTruthy();
    expect(s2.patient_id).toBe('PAT-123');
  });

  test('logout clears the durable verified flag so a later expiry does not resurrect the old session', async () => {
    const s1 = await sm.getOrCreateSession(phone);
    await sm.updateSession(s1.id, { verified: true, patient_id: 'PAT-123', conversation_state: 'BOOK_MANAGE_OPTIONS' });
    await db.upsertPatientState(phone, { patient_id: 'PAT-123', verified: true });

    await sm.deleteSessionAndData(s1.id);

    const s2 = await sm.getOrCreateSession(phone);
    expect(s2.conversation_state).toBe('INTRO');
    expect(s2.verified).toBeFalsy();
  });

  test('unverified prior session does not get promoted to BOOK_MANAGE_OPTIONS', async () => {
    const s1 = await sm.getOrCreateSession(phone);
    await db.query(`UPDATE sessions SET expires_at = datetime('now', '-1 minutes') WHERE id = ?`, [s1.id]);
    await db.cleanupExpiredSessions();

    const s2 = await sm.getOrCreateSession(phone);
    expect(s2.conversation_state).toBe('INTRO');
  });
});
