'use strict';
/**
 * tests/session_reseed.test.js
 *
 * Covers the cold-start / session-expiry reseed bug where a verified user's
 * expired session is reseeded into a new session that was landing in INTRO.
 * In INTRO, numeric input "1" maps to "Register as new patient" — so returning
 * verified users who tap "1" (Book Appointment) from their old menu were routed
 * into the registration flow instead.
 *
 * Fix: seeding a verified prior session now also seeds conversation_state =
 * BOOK_MANAGE_OPTIONS so the new session bypasses INTRO entirely.
 */

jest.mock('../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, analyticsEvent: () => {},
    child: function () { return this; },
  }))
);

jest.mock('../../src/core/DatabaseManager', () => {
  const sqlite3 = require('sqlite3').verbose();
  const crypto  = require('crypto');

  class DatabaseManager {
    constructor () { this.db = null; this.isInitialized = false; }

    generateSessionId () { return `session_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`; }

    async initialize () {
      this.db = new sqlite3.Database(':memory:');
      return new Promise((res, rej) => {
        this.db.serialize(() => {
          this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            phone_number TEXT NOT NULL,
            patient_id TEXT,
            verification_status TEXT DEFAULT 'pending',
            conversation_state TEXT DEFAULT 'INTRO',
            context TEXT DEFAULT '{}',
            data TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME,
            verified BOOLEAN DEFAULT 0
          )`);
          this.db.run(`CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT, message TEXT, response TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          )`);
          this.db.run(`CREATE TABLE IF NOT EXISTS verification_codes (
            id TEXT PRIMARY KEY, phone_number TEXT, code TEXT, patient_id TEXT,
            attempts INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME
          )`, (err) => { if (err) return rej(err); this.isInitialized = true; res(); });
        });
      });
    }

    async createSession (phoneNumber, patientId = null, durationMinutes = 30) {
      const id = this.generateSessionId();
      const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
      return new Promise((res, rej) =>
        this.db.run(
          'INSERT INTO sessions (id, phone_number, patient_id, expires_at) VALUES (?, ?, ?, ?)',
          [id, phoneNumber, patientId, expiresAt],
          (err) => (err ? rej(err) : res(id))
        )
      );
    }

    async getSession (id) {
      return new Promise((res, rej) =>
        this.db.get('SELECT * FROM sessions WHERE id = ?', [id],
          (err, row) => (err ? rej(err) : res(row || null)))
      );
    }

    async getSessionByPhone (phone) {
      return new Promise((res, rej) =>
        this.db.get(
          `SELECT * FROM sessions WHERE phone_number = ?
           AND (expires_at IS NULL OR expires_at > datetime('now'))
           ORDER BY created_at DESC LIMIT 1`,
          [phone],
          (err, row) => (err ? rej(err) : res(row || null))
        )
      );
    }

    async updateSession (id, updates) {
      const allowed = [
        'patient_id','verification_status','conversation_state',
        'context','last_activity','expires_at','verified','data',
      ];
      const fields = [], values = [];
      for (const [k, v] of Object.entries(updates)) {
        if (allowed.includes(k)) { fields.push(`${k} = ?`); values.push(v); }
      }
      if (!fields.length) return 0;
      fields.push('last_activity = ?');
      values.push(new Date().toISOString(), id);
      return new Promise((res, rej) =>
        this.db.run(
          `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`,
          values,
          function (err) { err ? rej(err) : res(this.changes); }
        )
      );
    }

    async deleteSession (id) {
      return new Promise((res, rej) =>
        this.db.run('DELETE FROM sessions WHERE id = ?', [id],
          (err) => (err ? rej(err) : res()))
      );
    }

    async cleanupExpiredSessions () { return 0; }

    async addChatHistory (sessionId, message, response) {
      return new Promise((res, rej) =>
        this.db.run(
          'INSERT INTO chat_history (session_id, message, response) VALUES (?, ?, ?)',
          [sessionId, message, response],
          (err) => (err ? rej(err) : res())
        )
      );
    }

    async query (sql, params = []) {
      return new Promise((res, rej) =>
        this.db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows || [])))
      );
    }

    close () {
      if (!this.db) return Promise.resolve();
      return new Promise((res, rej) => this.db.close(err => err ? rej(err) : res()));
    }
  }

  return DatabaseManager;
});

jest.mock('../../src/api/ClinikoAPI');
jest.mock('../../src/api/WhatsAppAPI');

const DatabaseManager = require('../../src/core/DatabaseManager');
const SessionManager  = require('../../src/core/SessionManager');
const ChatbotEngine   = require('../../src/core/ChatbotEngine');
const ClinikoAPI      = require('../../src/api/ClinikoAPI');

// Silence console noise from the engine
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { jest.restoreAllMocks(); });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function expiredIso () {
  return new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
}

async function plantExpiredVerifiedSession (db, phone, patientId = 'PAT-PRIOR') {
  const id = `prior_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await new Promise((res, rej) =>
    db.run(
      `INSERT INTO sessions
         (id, phone_number, patient_id, verified, verification_status,
          conversation_state, context, expires_at, last_activity)
       VALUES (?, ?, ?, 1, 'verified', 'BOOK_MANAGE_OPTIONS', '{}', ?, ?)`,
      [id, phone, patientId, expiredIso(), expiredIso()],
      (err) => (err ? rej(err) : res())
    )
  );
  return id;
}

async function plantExpiredUnverifiedSession (db, phone) {
  const id = `prior_unverified_${Date.now()}`;
  await new Promise((res, rej) =>
    db.run(
      `INSERT INTO sessions
         (id, phone_number, verified, verification_status,
          conversation_state, context, expires_at, last_activity)
       VALUES (?, ?, 0, 'pending', 'INTRO', '{}', ?, ?)`,
      [id, phone, expiredIso(), expiredIso()],
      (err) => (err ? rej(err) : res())
    )
  );
  return id;
}

// Build a fresh engine + initialized db for each suite
async function buildEngine () {
  const db = new DatabaseManager();
  await db.initialize();
  const sm = new SessionManager(db);
  await sm.initialize();
  const engine = new ChatbotEngine();
  engine.sessionManager = sm;
  engine.isInitialized = true;
  ClinikoAPI.prototype.findPatientByEmailAndDob = jest.fn().mockResolvedValue(null);
  return { engine, sm, db: db.db };
}

// ─── Suite 1: SessionManager seeding ─────────────────────────────────────────

describe('SessionManager.getOrCreateSession — reseed from prior session', () => {
  let sm, db;

  beforeEach(async () => {
    const built = await buildEngine();
    sm = built.sm;
    db = built.db;
  });

  afterEach(async () => { await sm.close(); });

  test('prior verified session → new session gets conversation_state BOOK_MANAGE_OPTIONS', async () => {
    const phone = '+6591000001';
    await plantExpiredVerifiedSession(db, phone, 'PAT-001');
    const session = await sm.getOrCreateSession(phone);
    expect(session.conversation_state).toBe('BOOK_MANAGE_OPTIONS');
  });

  test('prior verified session → new session gets verified=true', async () => {
    const phone = '+6591000002';
    await plantExpiredVerifiedSession(db, phone, 'PAT-002');
    const session = await sm.getOrCreateSession(phone);
    expect(session.verified).toBe(true);
  });

  test('prior verified session → new session carries patient_id', async () => {
    const phone = '+6591000003';
    await plantExpiredVerifiedSession(db, phone, 'PAT-003');
    const session = await sm.getOrCreateSession(phone);
    expect(session.patient_id).toBe('PAT-003');
  });

  test('prior unverified session → new session stays in INTRO', async () => {
    const phone = '+6591000004';
    await plantExpiredUnverifiedSession(db, phone);
    const session = await sm.getOrCreateSession(phone);
    expect(session.conversation_state).toBe('INTRO');
  });

  test('no prior session → new session stays in INTRO', async () => {
    const session = await sm.getOrCreateSession('+6591000099');
    expect(session.conversation_state).toBe('INTRO');
  });
});

// ─── Suite 2: ChatbotEngine routing after cold-start reseed ──────────────────

describe('ChatbotEngine — verified reseed routes correctly (cold-start bug)', () => {
  let engine, sm, db;

  beforeEach(async () => {
    const built = await buildEngine();
    engine = built.engine;
    sm     = built.sm;
    db     = built.db;

    // Verified menu options: Book=1, Cancel=2, Resched=3
    ClinikoAPI.prototype.getBookingsByPatientId = jest.fn().mockResolvedValue([]);
    ClinikoAPI.prototype.getPatientById         = jest.fn().mockResolvedValue({ id: 'PAT-RESEED', first_name: 'T', last_name: 'U' });
    ClinikoAPI.prototype.getPractitionersByClinic = jest.fn().mockResolvedValue([]);
    ClinikoAPI.prototype.getAvailableSlots      = jest.fn().mockResolvedValue([]);
  });

  afterEach(async () => { await sm.close(); });

  test('"1" after verified reseed goes to booking menu, not registration', async () => {
    const phone = '+6591100001';
    await plantExpiredVerifiedSession(db, phone, 'PAT-RESEED');
    const reply = await engine.handleMessage('1', phone);
    // Should land in the booking method menu (How would you like to book?)
    expect(reply).toMatch(/book/i);
    expect(reply).not.toMatch(/first name/i);
    expect(reply).not.toMatch(/register/i);
    // Confirm via raw DB that the active session is not in REGISTER_PATIENT
    const rows = await sm.db.query(
      `SELECT conversation_state FROM sessions WHERE phone_number = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    expect(rows[0]?.conversation_state).not.toBe('REGISTER_PATIENT');
  });

  test('"2" after verified reseed goes to cancel flow, not verify flow', async () => {
    const phone = '+6591100002';
    await plantExpiredVerifiedSession(db, phone, 'PAT-RESEED');
    ClinikoAPI.prototype.getUpcomingAppointments = jest.fn().mockResolvedValue([]);
    const reply = await engine.handleMessage('2', phone);
    expect(reply).not.toMatch(/first name/i);
    expect(reply).not.toMatch(/register/i);
    expect(reply).not.toMatch(/email address/i);
    const rows = await sm.db.query(
      `SELECT conversation_state FROM sessions WHERE phone_number = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    expect(rows[0]?.conversation_state).not.toBe('REGISTER_PATIENT');
    expect(rows[0]?.conversation_state).not.toBe('VERIFY');
  });

  test('"hi" after verified reseed shows the verified main menu', async () => {
    const phone = '+6591100003';
    await plantExpiredVerifiedSession(db, phone, 'PAT-RESEED');
    const reply = await engine.handleMessage('hi', phone);
    // Verified menu has Book / Cancel / Reschedule, no Register option
    expect(reply).toMatch(/book|cancel|reschedule/i);
    expect(reply).not.toMatch(/register as new patient/i);
  });

  test('unverified new session still routes "1" to registration', async () => {
    const phone = '+6591100004';
    // No prior session — fresh unverified start
    const reply = await engine.handleMessage('1', phone);
    // INTRO with region set (SG from phone prefix) → "1" = Register
    // The reply could be region selection first, or registration — either way, NOT booking
    expect(reply).not.toMatch(/how would you like to book/i);
  });
});
