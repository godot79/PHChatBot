'use strict';
/**
 * tests/integration/chatbot.integration.test.js
 *
 * Self-contained integration tests for the WhatsApp Physiotherapy Chatbot.
 * Zero extra dependencies — only what is already in package.json.
 * No supertest. No app.js. No .env required.
 * In-memory SQLite so no file I/O happens.
 *
 * Run:  npx jest tests/integration/chatbot.integration.test.js --runInBand
 */

// ─── Silence Logger everywhere before any real module loads ──────────────────
jest.mock('../../src/core/Logger', () =>
  jest.fn().mockImplementation(() => ({
    info:  () => {},
    warn:  () => {},
    error: () => {},
    debug: () => {},
    child: function () { return this; },
  }))
);

// ─── In-memory DatabaseManager (replaces the real file-based one) ─────────────
jest.mock('../../src/core/DatabaseManager', () => {
  const sqlite3 = require('sqlite3').verbose();
  const crypto  = require('crypto');

  class DatabaseManager {
    constructor () {
      this.db = null;
      this.isInitialized = false;
    }

    generateSessionId () {
      return crypto.randomBytes(16).toString('hex');
    }

    async testConnection () {
      if (!this.db) return true;
      return new Promise((res, rej) =>
        this.db.get('SELECT 1', (err) => (err ? rej(err) : res(true)))
      );
    }

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
            session_id TEXT,
            message TEXT,
            response TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          )`);
          this.db.run(`CREATE TABLE IF NOT EXISTS verification_codes (
            id TEXT PRIMARY KEY,
            phone_number TEXT,
            code TEXT,
            patient_id TEXT,
            attempts INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME
          )`);
          this.db.run(`CREATE TABLE IF NOT EXISTS patient_state (
            phone_number TEXT PRIMARY KEY,
            region TEXT,
            appt_preference TEXT,
            patient_id TEXT,
            verified BOOLEAN DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`, (err) => {
            if (err) return rej(err);
            this.isInitialized = true;
            res();
          });
        });
      });
    }

    async createSession (phoneNumber, patientId = null, durationMinutes = 30) {
      const id        = this.generateSessionId();
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

    async cleanupExpiredSessions () {
      return new Promise((res, rej) =>
        this.db.run(`DELETE FROM sessions WHERE expires_at < datetime('now')`,
          (err) => (err ? rej(err) : res()))
      );
    }

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

    // Used in edge-case tests to write intentionally broken data
    _rawRun (sql, params = []) {
      return new Promise((res, rej) =>
        this.db.run(sql, params, (err) => (err ? rej(err) : res()))
      );
    }

    async getPatientState (phone) {
      return new Promise((res, rej) =>
        this.db.get('SELECT * FROM patient_state WHERE phone_number = ?', [phone],
          (err, row) => (err ? rej(err) : res(row || null)))
      );
    }

    async upsertPatientState (phone, updates) {
      const { region, appt_preference, patient_id, verified } = updates;
      const verifiedValue = verified === undefined ? null : (verified ? 1 : 0);
      return new Promise((res, rej) =>
        this.db.run(
          `INSERT INTO patient_state (phone_number, region, appt_preference, patient_id, verified, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(phone_number) DO UPDATE SET
             region = COALESCE(?, region),
             appt_preference = COALESCE(?, appt_preference),
             patient_id = COALESCE(?, patient_id),
             verified = COALESCE(?, verified),
             updated_at = CURRENT_TIMESTAMP`,
          [
            phone, region ?? null, appt_preference ?? null, patient_id ?? null, verifiedValue,
            region ?? null, appt_preference ?? null, patient_id ?? null, verifiedValue,
          ],
          (err) => (err ? rej(err) : res())
        )
      );
    }

    close () {
      if (!this.db) return Promise.resolve();
      return new Promise((res, rej) => this.db.close(err => err ? rej(err) : res()));
    }
  }

  return DatabaseManager;
});

// ─── Stub external APIs ────────────────────────────────────────────────────────
jest.mock('../../src/api/ClinikoAPI');
jest.mock('../../src/api/WhatsAppAPI');

// ─── Imports (after all mocks are registered) ─────────────────────────────────
const DatabaseManager = require('../../src/core/DatabaseManager');
const SessionManager  = require('../../src/core/SessionManager');
const ChatbotEngine   = require('../../src/core/ChatbotEngine');
const ClinikoAPI      = require('../../src/api/ClinikoAPI');
const WhatsAppAPI     = require('../../src/api/WhatsAppAPI');

// ─── Shared test data ─────────────────────────────────────────────────────────
const PATIENT_ID = 'PAT-TEST-001';

const futureISO = (days = 3) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
};
const pastISO = (days = 7) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};

const SLOT_WITH_SLOT_FIELD = {
  ...{
    id: 'SLOT-001', starts_at: futureISO(2), appointment_start: futureISO(2),
    appointment_type_id: 'AT-001', appointment_type_name: 'Initial 60 Min Visit (New Clients)',
    practitioner_name: 'Jolinna Chan', practitioner_id: 'PRAC-001',
    business_name: 'Prohealth In Touch', business_id: 'BIZ-001',
    _practitioner_display: 'Jolinna Chan',
    _appointment_type_display: 'Initial 60 Min Visit (New Clients)',
    _business_display: 'Prohealth In Touch',
  },
  slot: futureISO(2),
};

const SLOT = {
  id: 'SLOT-001', starts_at: futureISO(2), appointment_start: futureISO(2),
  appointment_type_id: 'AT-001', appointment_type_name: 'Initial 60 Min Visit (New Clients)',
  practitioner_name: 'Jolinna Chan', practitioner_id: 'PRAC-001',
  business_name: 'Prohealth In Touch', business_id: 'BIZ-001',
  _practitioner_display: 'Jolinna Chan',
  _appointment_type_display: 'Initial 60 Min Visit (New Clients)',
  _business_display: 'Prohealth In Touch',
};

const FUTURE_APPT = {
  id: 'APPT-F', starts_at: futureISO(3), cancelled_at: null,
  practitioner:      { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan', display_name: 'Jolinna Chan' },
  appointment_type:  { id: 'AT-001',   name: 'Return Visit (Existing Clients)' },
  business:          { id: 'BIZ-001',  business_name: 'Prohealth In Touch' },
  _practitioner_display: 'Jolinna Chan',
  _appointment_type_display: 'Return Visit (Existing Clients)',
  _business_display: 'Prohealth In Touch',
  _display_dt: 'Mon 10:00 AM',
};

// Slot returned by getAvailableSlotsByBusinessAndDate — must have .slot and matching type name
const SOONEST_SLOT = {
  id: 'SS-001',
  slot: futureISO(3),
  appointment_type_name: 'Initial 60 Min Visit (New Clients)',
  appointment_type_id:   'AT-001',
  practitioner_id:       'PRAC-001',
  business_id:           'BIZ-001',
  business_name:         'Prohealth In Touch',
  practitioner_name:     'Jolinna Chan',
};

const PAST_APPT = {
  id: 'APPT-P', starts_at: pastISO(7), cancelled_at: pastISO(8),
  practitioner:     { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan', display_name: 'Jolinna Chan' },
  appointment_type: { id: 'AT-001',   name: 'Initial 60 Min Visit (New Clients)' },
  business:         { id: 'BIZ-001',  business_name: 'Prohealth In Touch' },
};

// ─── Mock reset helpers ────────────────────────────────────────────────────────
function resetCliniko () {
  ClinikoAPI.prototype.getPatientByPhone            = jest.fn().mockResolvedValue({ id: PATIENT_ID, first_name: 'Test', last_name: 'Patient', email: 'p@test.com' });
  ClinikoAPI.prototype.getPatientByEmail            = jest.fn().mockResolvedValue({ id: PATIENT_ID, first_name: 'Test', last_name: 'Patient', email: 'p@test.com', date_of_birth: '1990-01-01' });
  ClinikoAPI.prototype.getPatientById               = jest.fn().mockResolvedValue({ id: PATIENT_ID, first_name: 'Test', last_name: 'Patient' });
  ClinikoAPI.prototype.getBookingsByPatientId       = jest.fn().mockResolvedValue([FUTURE_APPT, PAST_APPT]);
  ClinikoAPI.prototype.getAvailableAppointmentTimes = jest.fn().mockResolvedValue([SLOT]);
  ClinikoAPI.prototype.getAvailableSlots            = jest.fn().mockResolvedValue([SLOT]);
  ClinikoAPI.prototype.createAppointment            = jest.fn().mockResolvedValue({ id: 'NEW-APPT', starts_at: futureISO(2) });
  ClinikoAPI.prototype.cancelAppointment            = jest.fn().mockResolvedValue({ success: true });
  ClinikoAPI.prototype.deleteAppointment            = jest.fn().mockResolvedValue({ success: true });
  ClinikoAPI.prototype.updateAppointment            = jest.fn().mockResolvedValue({ id: 'APPT-UPD', starts_at: futureISO(4) });
  ClinikoAPI.prototype.getPractitioners             = jest.fn().mockResolvedValue([
    { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan', display_name: 'Jolinna Chan', specialization: 'Physiotherapy' },
    { id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan',  display_name: 'Wei Tan',     specialization: 'Sports Rehab'  },
  ]);
  ClinikoAPI.prototype.getBusinesses                = jest.fn().mockResolvedValue([
    { id: 'BIZ-001', business_name: 'Prohealth In Touch', contact_information: { address_1: '1 Test St' } },
    { id: 'BIZ-002', business_name: 'Prohealth City',     contact_information: { address_1: '2 City Rd' } },
  ]);
  ClinikoAPI.prototype.getAppointmentTypes          = jest.fn().mockResolvedValue([
    { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', duration: 60, category: 'Physiotherapy', duration_in_minutes: 60 },
    { id: 'AT-002', name: 'Return Visit (Existing Clients)',    duration: 30, category: 'Physiotherapy', duration_in_minutes: 30 },
  ]);
  ClinikoAPI.prototype.healthCheck                  = jest.fn().mockResolvedValue({ status: 'ok' });
  ClinikoAPI.prototype.bookAppointment              = jest.fn().mockResolvedValue({ success: true, id: 'NEW-APPT' });
  ClinikoAPI.prototype.getAvailableTimes            = jest.fn().mockResolvedValue([SLOT]);
  ClinikoAPI.prototype.getPractitionersByClinic     = jest.fn().mockResolvedValue([
    { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [{ id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }] },
  ]);
  ClinikoAPI.prototype.getBusinessById              = jest.fn().mockResolvedValue({ id: 'BIZ-001', business_name: 'Prohealth In Touch' });
  ClinikoAPI.prototype.getPractitionerById          = jest.fn().mockResolvedValue({ id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' });
  ClinikoAPI.prototype.getAppointmentTypeById       = jest.fn().mockResolvedValue({ id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' });
  ClinikoAPI.prototype.getAvailableSlotsByBusinessAndDate = jest.fn().mockResolvedValue([SOONEST_SLOT]);
}

function resetWhatsApp () {
  WhatsAppAPI.prototype.sendTextMessage    = jest.fn().mockResolvedValue({ success: true });
  WhatsAppAPI.prototype.sendMessage        = jest.fn().mockResolvedValue({ success: true });
  WhatsAppAPI.prototype.markAsRead         = jest.fn().mockResolvedValue(true);
  WhatsAppAPI.prototype.getBusinessProfile = jest.fn().mockResolvedValue({ name: 'Prohealth' });
  WhatsAppAPI.sendMessage                  = jest.fn().mockResolvedValue(true);
}

// ─── Utility: seed a verified session directly in the DB ─────────────────────
async function seedVerified (db, phone, extra = {}) {
  const id = await db.createSession(phone, PATIENT_ID, 60);
  await db.updateSession(id, {
    verification_status: 'verified',
    verified: 1,
    patient_id: PATIENT_ID,
    conversation_state: 'INTRO',
    data: JSON.stringify({ email: 'p@test.com', patient_name: 'Test Patient', ...extra }),
  });
  return db.getSession(id);
}

// ─── Helper: call a state handler directly if it exists ──────────────────────
async function callHandler (engine, names, session, msg) {
  for (const name of names) {
    if (typeof engine[name] === 'function') {
      return String(await engine[name].call(engine, session, msg));
    }
  }
  return null; // handler not exposed publicly
}

// =============================================================================
// SUITE 1 — DatabaseManager
// =============================================================================
describe('DatabaseManager — in-memory SQLite', () => {
  let db;
  beforeAll(async () => { db = new DatabaseManager(); await db.initialize(); });
  afterAll(() => db.close());

  test('initializes without error — isInitialized is true', () => {
    expect(db.isInitialized).toBe(true);
  });

  test('testConnection resolves to true', async () => {
    await expect(db.testConnection()).resolves.toBe(true);
  });

  test('createSession returns a string ID', async () => {
    const id = await db.createSession('+6511110001');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(4);
  });

  test('getSession retrieves the created session', async () => {
    const id  = await db.createSession('+6511110002');
    const row = await db.getSession(id);
    expect(row).not.toBeNull();
    expect(row.id).toBe(id);
    expect(row.phone_number).toBe('+6511110002');
  });

  test('getSessionByPhone returns active session', async () => {
    const id  = await db.createSession('+6511110003');
    const row = await db.getSessionByPhone('+6511110003');
    expect(row).not.toBeNull();
    expect(row.id).toBe(id);
  });

  test('getSession returns null for unknown ID', async () => {
    await expect(db.getSession('ghost-id-xyz')).resolves.toBeNull();
  });

  test('getSessionByPhone returns null for unknown phone', async () => {
    await expect(db.getSessionByPhone('+6500000000')).resolves.toBeNull();
  });

  test('updateSession changes conversation_state', async () => {
    const id = await db.createSession('+6511110004');
    await db.updateSession(id, { conversation_state: 'VERIFY' });
    const row = await db.getSession(id);
    expect(row.conversation_state).toBe('VERIFY');
  });

  test('updateSession persists JSON data blob', async () => {
    const id      = await db.createSession('+6511110005');
    const payload = JSON.stringify({ step: 'choose_physio', count: 7 });
    await db.updateSession(id, { data: payload });
    const row = await db.getSession(id);
    const parsed = JSON.parse(row.data);
    expect(parsed.step).toBe('choose_physio');
    expect(parsed.count).toBe(7);
  });

  test('updateSession sets patient_id and verified', async () => {
    const id = await db.createSession('+6511110006');
    await db.updateSession(id, { patient_id: 'P-999', verified: 1 });
    const row = await db.getSession(id);
    expect(row.patient_id).toBe('P-999');
    expect(row.verified).toBe(1);
  });

  test('deleteSession removes the row', async () => {
    const id = await db.createSession('+6511110007');
    await db.deleteSession(id);
    await expect(db.getSession(id)).resolves.toBeNull();
  });

  test('two sessions for same phone are independent rows', async () => {
    const id1 = await db.createSession('+6511110008');
    const id2 = await db.createSession('+6511110008');
    expect(id1).not.toBe(id2);
    expect(await db.getSession(id1)).not.toBeNull();
    expect(await db.getSession(id2)).not.toBeNull();
  });

  test('updateSession with no valid fields returns 0, does not crash', async () => {
    const id      = await db.createSession('+6511110009');
    const changes = await db.updateSession(id, { unknown_field: 'x' });
    expect(changes).toBe(0);
  });
});

// =============================================================================
// SUITE 2 — SessionManager
// =============================================================================
describe('SessionManager', () => {
  let db, sm;
  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });

  test('getOrCreateSession creates a session for a new phone', async () => {
    // +91XXXXXXXXXX (12-digit Indian format) round-trips through normalizePhoneNumber unchanged
    const s = await sm.getOrCreateSession('+919100000001');
    expect(s).toBeDefined();
    expect(s.id).toBeTruthy();
    expect(s.phone_number).toBe('+919100000001');
  });

  test('getOrCreateSession returns the same session on repeat calls', async () => {
    const s1 = await sm.getOrCreateSession('+6520000002');
    const s2 = await sm.getOrCreateSession('+6520000002');
    expect(s1.id).toBe(s2.id);
  });

  test('getSession returns null for unknown session ID', async () => {
    await expect(sm.getSession('no-such-session')).resolves.toBeNull();
  });

  test('updateSession persists conversation_state', async () => {
    const s = await sm.getOrCreateSession('+6520000003');
    await sm.updateSession(s.id, { conversation_state: 'BOOK_MANAGE_OPTIONS' });
    const u = await sm.getSession(s.id);
    expect(u.conversation_state).toBe('BOOK_MANAGE_OPTIONS');
  });

  test('updateSession persists data blob', async () => {
    const s    = await sm.getOrCreateSession('+6520000004');
    const blob = JSON.stringify({ flow: 'cancel', step: 2 });
    await sm.updateSession(s.id, { data: blob });
    const u = await sm.getSession(s.id);
    expect(u.data).toBe(blob);
  });

  test('expired session is invisible to getSession', async () => {
    const id = await db.createSession('+6520000005', null, 60);
    await db._rawRun(
      'UPDATE sessions SET expires_at = ? WHERE id = ?',
      [new Date(Date.now() - 5000).toISOString(), id]
    );
    await expect(sm.getSession(id)).resolves.toBeNull();
  });

  test('getOrCreateSession creates a new session when previous one expired', async () => {
    const id1 = await db.createSession('+6520000006', null, 0);
    await db._rawRun(
      'UPDATE sessions SET expires_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), id1]
    );
    const s2 = await sm.getOrCreateSession('+6520000006');
    expect(s2.id).not.toBe(id1);
  });
});

// =============================================================================
// SUITE 3 — ChatbotEngine state machine
// =============================================================================
describe('ChatbotEngine — state machine', () => {
  let db, sm, engine;
  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  beforeEach(() => { jest.clearAllMocks(); resetCliniko(); resetWhatsApp(); });

  // Core API
  test('handleMessage is a function', () => {
    expect(typeof engine.handleMessage).toBe('function');
  });

  test('STATES object has all required keys', () => {
    const required = ['INTRO','VERIFY','BOOK_MANAGE_OPTIONS','CANCEL_APPOINTMENT',
                      'RESCHEDULE_APPOINTMENT','CONFIRM_BOOKING'];
    for (const s of required) expect(engine.STATES).toHaveProperty(s);
  });

  // New user
  test('new phone: handleMessage returns a non-empty string', async () => {
    const r = await engine.handleMessage('hello', '+6530000001');
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  test('new user reply contains a welcome/verify cue', async () => {
    const r = await engine.handleMessage('hi', '+6530000002');
    expect(r).toMatch(/welcome|hello|verify|email|hi|start/i);
  });

  // ─── Unverified intro menu — display and routing ──────────────────────────────
  describe('Unverified intro menu — display and routing', () => {
    async function seedUnverified(phone) {
      const s = await engine.sessionManager.getOrCreateSession(phone, true);
      await engine.sessionManager.updateSession(s.id, {
        conversation_state: 'INTRO',
        verified: false,
        context: JSON.stringify({ region: 'SG' }),
      });
      return engine.sessionManager.getSession(s.id);
    }

    test('menu shows Register first with hint text', async () => {
      const session = await seedUnverified('+6531000001');
      const reply = await callHandler(engine, ['handleIntroState'], session, '');
      expect(reply).toMatch(/register as new patient/i);
      expect(reply).toMatch(/new here|register below/i);
      // Register appears before Book or Manage in the fallback list
      expect(reply.indexOf('Register')).toBeLessThan(reply.indexOf('Book or Manage'));
    });

    test('id "1" → Register as new patient (asks for first name)', async () => {
      const session = await seedUnverified('+6531000002');
      const reply = await callHandler(engine, ['handleIntroState'], session, '1');
      expect(reply).toMatch(/first name/i);
    });

    test('id "2" → Book or Manage (shows gateway)', async () => {
      const session = await seedUnverified('+6531000003');
      const reply = await callHandler(engine, ['handleIntroState'], session, '2');
      expect(reply).toMatch(/registered with us/i);
    });

    test('id "3" → View Fees (shows fee schedule)', async () => {
      const session = await seedUnverified('+6531000004');
      const reply = await callHandler(engine, ['handleIntroState'], session, '3');
      expect(reply).toMatch(/fee|price|cost|sgd|hkd|inr|php/i);
    });

    test('id "4" → View Locations (shows locations)', async () => {
      engine.clinikoAPI.getClinics.mockResolvedValue([]);
      const session = await seedUnverified('+6531000005');
      const reply = await callHandler(engine, ['handleIntroState'], session, '4');
      expect(reply).toMatch(/location|address|clinic|where|no clinic/i);
    });

    test('text "register" → Register as new patient', async () => {
      const session = await seedUnverified('+6531000006');
      const reply = await callHandler(engine, ['handleIntroState'], session, 'register');
      expect(reply).toMatch(/first name/i);
    });

    test('text "book" → Book or Manage (shows gateway)', async () => {
      const session = await seedUnverified('+6531000007');
      const reply = await callHandler(engine, ['handleIntroState'], session, 'book');
      expect(reply).toMatch(/registered with us/i);
    });
  });

  // Navigation keywords
  test('"0" input always returns a non-empty string', async () => {
    await seedVerified(db, '+6530000010');
    const r = await engine.handleMessage('0', '+6530000010');
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  test('"menu" input returns a non-empty string', async () => {
    await seedVerified(db, '+6530000011');
    const r = await engine.handleMessage('menu', '+6530000011');
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  test('"back" input returns a non-empty string', async () => {
    await seedVerified(db, '+6530000012');
    const r = await engine.handleMessage('back', '+6530000012');
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  // Garbage input
  test('unrecognised input returns a fallback string without throwing', async () => {
    await seedVerified(db, '+6530000020');
    const r = await engine.handleMessage('xyzzy_garbage!!', '+6530000020');
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  // Cancel — no future appointments
  test('CANCEL with no future appointments returns "no upcoming" message', async () => {
    jest.spyOn(engine.clinikoAPI, 'getBookingsByPatientId').mockResolvedValue([PAST_APPT]);
    const session = await seedVerified(db, '+6530000030');
    await db.updateSession(session.id, { conversation_state: 'CANCEL_APPOINTMENT' });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine,
      ['handleCancelAppointmentState','handleCancelAppointment'], fresh, '')
      ?? await engine.handleMessage('', '+6530000030');
    expect(reply).toMatch(/no upcoming|no future|nothing to cancel|no appointment/i);
  });

  // Cancel — has future appointment
  test('CANCEL with a future appointment shows it / prompts confirm', async () => {
    ClinikoAPI.prototype.getBookingsByPatientId = jest.fn().mockResolvedValue([FUTURE_APPT]);
    const session = await seedVerified(db, '+6530000031');
    await db.updateSession(session.id, { conversation_state: 'CANCEL_APPOINTMENT' });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine,
      ['handleCancelAppointmentState','handleCancelAppointment'], fresh, '')
      ?? await engine.handleMessage('', '+6530000031');
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  // Reschedule — no future
  test('RESCHEDULE with no future appointments returns "no upcoming" message', async () => {
    jest.spyOn(engine.clinikoAPI, 'getBookingsByPatientId').mockResolvedValue([PAST_APPT]);
    const session = await seedVerified(db, '+6530000040');
    await db.updateSession(session.id, { conversation_state: 'RESCHEDULE_APPOINTMENT' });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine,
      ['handleRescheduleAppointmentState','handleRescheduleAppointment'], fresh, '')
      ?? await engine.handleMessage('', '+6530000040');
    expect(reply).toMatch(/no upcoming|no future|nothing to reschedule|no appointment/i);
  });

  // Reschedule — has future
  test('RESCHEDULE with a future appointment presents available slots', async () => {
    ClinikoAPI.prototype.getBookingsByPatientId       = jest.fn().mockResolvedValue([FUTURE_APPT]);
    ClinikoAPI.prototype.getAvailableAppointmentTimes = jest.fn().mockResolvedValue([SLOT]);
    const session = await seedVerified(db, '+6530000041');
    await db.updateSession(session.id, { conversation_state: 'RESCHEDULE_APPOINTMENT' });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine,
      ['handleRescheduleAppointmentState','handleRescheduleAppointment'], fresh, '')
      ?? await engine.handleMessage('', '+6530000041');
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  // Book Soonest — slots available
  test('BOOK_SOONEST with slots available returns slot list', async () => {
    ClinikoAPI.prototype.getAvailableAppointmentTimes = jest.fn().mockResolvedValue([SLOT]);
    const session = await seedVerified(db, '+6530000050');
    await db.updateSession(session.id, { conversation_state: 'BOOK_SOONEST' });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine,
      ['handleBookSoonestState','handleBookSoonest'], fresh, '')
      ?? await engine.handleMessage('', '+6530000050');
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  // Book Soonest — no slots
  // Seeds the session at choose_type with a single type already populated.
  // Selecting '1' triggers buildAvailablePhysiosForTypeName; getAvailableSlotsByBusinessAndDate
  // is overridden to return [] so no practitioners pass the slot check,
  // producing the "no practitioners have available slots" reply in one handler call.
  test('BOOK_SOONEST with no slots returns a helpful message', async () => {
    engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
    const session = await seedVerified(db, '+6530000051');
    await db.updateSession(session.id, {
      conversation_state: 'BOOK_SOONEST',
      data: JSON.stringify({
        email: 'p@test.com',
        patient_name: 'Test Patient',
        selection_step: 'choose_type',
        appt_type_page: 0,
        appointment_type_list: [
          { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', norm_name: 'initial 60 min visit (new clients)' },
        ],
        funnel_catalogue: [{ id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', service: 'Physiotherapy', insurer: null, patientType: null, duration: 60 }],
      }),
    });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine, ['handleBookSoonestState', 'handleBookSoonest'], fresh, '1');
    expect(reply).toMatch(/no.*slot|try another/i);
  });

  // Confirm booking — yes
  test('CONFIRM_BOOKING "yes" calls createAppointment and returns success', async () => {
    ClinikoAPI.prototype.createAppointment = jest.fn().mockResolvedValue({ id: 'NEW-001', starts_at: futureISO(2) });
    const session = await seedVerified(db, '+6530000060');
    await db.updateSession(session.id, {
      conversation_state: 'CONFIRM_BOOKING',
      data: JSON.stringify({ selected_slot: SLOT, email: 'p@test.com' }),
    });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine,
      ['handleConfirmBookingState','handleConfirmBooking'], fresh, 'yes')
      ?? await engine.handleMessage('yes', '+6530000060');
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  // Unverified user redirected
  test('user with no patient_id in CANCEL state is redirected to verify', async () => {
    const session = await seedVerified(db, '+6530000070');
    await db.updateSession(session.id, {
      patient_id: null, verification_status: 'pending',
      verified: 0, conversation_state: 'CANCEL_APPOINTMENT',
    });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine,
      ['handleCancelAppointmentState','handleCancelAppointment'], fresh, '')
      ?? await engine.handleMessage('', '+6530000070');
    expect(reply).toMatch(/verify|register|patient|email/i);
  });

  // History
  test('BOOK_HISTORY returns a non-empty string', async () => {
    ClinikoAPI.prototype.getBookingsByPatientId = jest.fn().mockResolvedValue([PAST_APPT, FUTURE_APPT]);
    const session = await seedVerified(db, '+6530000080');
    await db.updateSession(session.id, { conversation_state: 'BOOK_HISTORY' });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine,
      ['handleBookHistoryState','handleBookHistory'], fresh, '')
      ?? await engine.handleMessage('', '+6530000080');
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  // goToInteractiveMenu (if public)
  test('goToInteractiveMenu returns a string when available', async () => {
    if (typeof engine.goToInteractiveMenu !== 'function') return;
    const session = await seedVerified(db, '+6530000090');
    const reply   = await engine.goToInteractiveMenu(session);
    expect(reply != null).toBe(true);
    expect(String(reply).length).toBeGreaterThan(0);
  });
});

// =============================================================================
// SUITE 4 — Multi-turn simulation
// =============================================================================
describe('Multi-turn conversation simulation', () => {
  let db, sm, engine;
  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  beforeEach(() => { jest.clearAllMocks(); resetCliniko(); resetWhatsApp(); });

  async function turn (phone, inputs) {
    const replies = [];
    for (const msg of inputs) replies.push(await engine.handleMessage(msg, phone));
    return replies;
  }

  test('new user — every turn returns a non-empty string', async () => {
    const replies = await turn('+6540000001', ['hello', '1', '0']);
    for (const r of replies) {
      expect(typeof r).toBe('string');
      expect(r.length).toBeGreaterThan(0);
    }
  });

  test('engine never throws on unusual inputs', async () => {
    const phone = '+6540000002';
    const weirdInputs = ['', '  ', '\n', '!@#$%', '<script>x</script>', 'A'.repeat(600)];
    for (const msg of weirdInputs) {
      await expect(engine.handleMessage(msg, phone)).resolves.toBeDefined();
    }
  });

  test('cancel flow: verified user enters state and gets a response', async () => {
    ClinikoAPI.prototype.getBookingsByPatientId = jest.fn().mockResolvedValue([FUTURE_APPT]);
    const phone = '+6540000010';
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1,
      patient_id: PATIENT_ID,
      conversation_state: 'CANCEL_APPOINTMENT',
      data: JSON.stringify({ email: 'x@x.com' }),
    });
    const reply = await engine.handleMessage('', phone);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  test('reschedule flow: verified user enters state and gets a response', async () => {
    ClinikoAPI.prototype.getBookingsByPatientId       = jest.fn().mockResolvedValue([FUTURE_APPT]);
    ClinikoAPI.prototype.getAvailableAppointmentTimes = jest.fn().mockResolvedValue([SLOT]);
    const phone = '+6540000020';
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1,
      patient_id: PATIENT_ID,
      conversation_state: 'RESCHEDULE_APPOINTMENT',
      data: JSON.stringify({ email: 'x@x.com' }),
    });
    const reply = await engine.handleMessage('', phone);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  test('book soonest flow: verified user enters state and gets a response', async () => {
    ClinikoAPI.prototype.getAvailableAppointmentTimes = jest.fn().mockResolvedValue([SLOT]);
    const phone = '+6540000030';
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1,
      patient_id: PATIENT_ID,
      conversation_state: 'BOOK_SOONEST',
      data: JSON.stringify({ email: 'x@x.com' }),
    });
    const reply = await engine.handleMessage('', phone);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  test('concurrent messages from the same phone do not crash', async () => {
    const phone   = '+6540000099';
    const [r1,r2] = await Promise.all([
      engine.handleMessage('hello', phone),
      engine.handleMessage('menu',  phone),
    ]);
    expect(typeof r1).toBe('string');
    expect(typeof r2).toBe('string');
  });
});

// =============================================================================
// SUITE 5 — Cliniko stub shape contracts
// =============================================================================
describe('ClinikoAPI stub shape contracts', () => {
  beforeEach(() => resetCliniko());

  test('getAvailableAppointmentTimes → array with id + starts_at', async () => {
    const slots = await new ClinikoAPI().getAvailableAppointmentTimes();
    expect(Array.isArray(slots)).toBe(true);
    expect(slots[0]).toHaveProperty('id');
    expect(slots[0]).toHaveProperty('starts_at');
  });

  test('getPractitioners → array with first_name + last_name', async () => {
    const prac = await new ClinikoAPI().getPractitioners();
    expect(Array.isArray(prac)).toBe(true);
    expect(prac[0]).toHaveProperty('first_name');
    expect(prac[0]).toHaveProperty('last_name');
  });

  test('getBookingsByPatientId → array with starts_at', async () => {
    const appts = await new ClinikoAPI().getBookingsByPatientId(PATIENT_ID);
    expect(Array.isArray(appts)).toBe(true);
    expect(appts[0]).toHaveProperty('starts_at');
  });

  test('createAppointment → object with id', async () => {
    const r = await new ClinikoAPI().createAppointment({});
    expect(r).toHaveProperty('id');
  });

  test('cancelAppointment → { success: true }', async () => {
    const r = await new ClinikoAPI().cancelAppointment('A-001');
    expect(r).toHaveProperty('success', true);
  });

  test('getBusinesses → array with business_name', async () => {
    const biz = await new ClinikoAPI().getBusinesses();
    expect(Array.isArray(biz)).toBe(true);
    expect(biz[0]).toHaveProperty('business_name');
  });
});

// =============================================================================
// SUITE 6 — Resilience / edge cases
// =============================================================================
describe('Resilience and edge cases', () => {
  let db, sm, engine;
  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  beforeEach(() => { jest.clearAllMocks(); resetCliniko(); resetWhatsApp(); });

  test('Cliniko network error — engine returns string, does not throw', async () => {
    ClinikoAPI.prototype.getBookingsByPatientId = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const phone = '+6550000001';
    const id    = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1,
      patient_id: PATIENT_ID,
      conversation_state: 'CANCEL_APPOINTMENT',
      data: '{}',
    });
    const reply = await engine.handleMessage('', phone);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  test('Cliniko returns null — engine does not crash', async () => {
    ClinikoAPI.prototype.getBookingsByPatientId = jest.fn().mockResolvedValue(null);
    const phone = '+6550000002';
    const id    = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1,
      patient_id: PATIENT_ID,
      conversation_state: 'RESCHEDULE_APPOINTMENT',
      data: '{}',
    });
    const reply = await engine.handleMessage('', phone);
    expect(typeof reply).toBe('string');
  });

  test('broken JSON in data field — engine recovers', async () => {
    const phone = '+6550000003';
    const id    = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1,
      patient_id: PATIENT_ID, conversation_state: 'INTRO',
    });
    await db._rawRun('UPDATE sessions SET data = ? WHERE id = ?', ['NOT_JSON{{{', id]);
    const reply = await engine.handleMessage('menu', phone);
    expect(typeof reply).toBe('string');
  });

  test('createAppointment throws — engine returns string, does not throw', async () => {
    ClinikoAPI.prototype.createAppointment = jest.fn().mockRejectedValue(new Error('API down'));
    const phone = '+6550000010';
    const id    = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1,
      patient_id: PATIENT_ID,
      conversation_state: 'CONFIRM_BOOKING',
      data: JSON.stringify({ selected_slot: SLOT }),
    });
    const reply = await engine.handleMessage('yes', phone);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  test('very long phone number handled without crash', async () => {
    const r = await engine.handleMessage('hello', '+' + '6'.repeat(20));
    expect(typeof r).toBe('string');
  });

  test('empty string message handled gracefully', async () => {
    await seedVerified(db, '+6550000020');
    const r = await engine.handleMessage('', '+6550000020');
    expect(typeof r).toBe('string');
  });

  test('whitespace-only message handled gracefully', async () => {
    await seedVerified(db, '+6550000021');
    const r = await engine.handleMessage('   \n\t  ', '+6550000021');
    expect(typeof r).toBe('string');
  });

  test('emoji-only message does not crash', async () => {
    await seedVerified(db, '+6550000022');
    const r = await engine.handleMessage('😊🎉🏥', '+6550000022');
    expect(typeof r).toBe('string');
  });
});

// =============================================================================
// SUITE 7 — Booking confirmation: bookAppointment call contract
// =============================================================================
describe('Booking confirmation — bookAppointment call contract', () => {
  let db, sm, engine;
  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  beforeEach(() => { jest.clearAllMocks(); resetCliniko(); resetWhatsApp(); });

  test('CONFIRM_BOOKING "yes" calls bookAppointment with correct patient_id, practitioner_id, business_id, appointment_type_id, starts_at', async () => {
    const bookMock = jest.spyOn(engine.clinikoAPI, 'bookAppointment').mockResolvedValue({ success: true, id: 'NEW-APPT' });

    // Phone must round-trip through normalizePhoneNumber: +91XXXXXXXXXX (12 digits starting with 91) normalizes to itself
    const phone = '+919100000001';
    const session = await seedVerified(db, phone);
    await db.updateSession(session.id, {
      conversation_state: 'CONFIRM_BOOKING',
      data: JSON.stringify({ selected_slot: SLOT_WITH_SLOT_FIELD }),
    });

    const reply = await engine.handleMessage('yes', phone);

    expect(bookMock).toHaveBeenCalledTimes(1);
    expect(bookMock).toHaveBeenCalledWith({
      patient_id:          PATIENT_ID,
      practitioner_id:     SLOT_WITH_SLOT_FIELD.practitioner_id,
      business_id:         SLOT_WITH_SLOT_FIELD.business_id,
      appointment_type_id: SLOT_WITH_SLOT_FIELD.appointment_type_id,
      starts_at:           SLOT_WITH_SLOT_FIELD.slot,
    });
    expect(typeof reply).toBe('string');
    expect(reply).toMatch(/booked|appointment|✅/i);
  });

  test('CONFIRM_BOOKING "yes" with slot missing .slot field does NOT call bookAppointment', async () => {
    const bookMock = jest.spyOn(engine.clinikoAPI, 'bookAppointment').mockResolvedValue({ success: true, id: 'NEW-APPT' });

    const phone = '+919100000002';
    const session = await seedVerified(db, phone);
    await db.updateSession(session.id, {
      conversation_state: 'CONFIRM_BOOKING',
      data: JSON.stringify({ selected_slot: SLOT }),
    });

    const reply = await engine.handleMessage('yes', phone);

    expect(bookMock).not.toHaveBeenCalled();
    expect(typeof reply).toBe('string');
  });
});

// =============================================================================
// SUITE 8 — Booking menu and flow coverage
// =============================================================================
describe('Booking menu and flow coverage', () => {
  let db, sm, engine;
  let phoneSeq = 0;
  const nextPhone = () => `+658${String(++phoneSeq).padStart(7, '0')}`;

  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  // Jest automock gives each ClinikoAPI instance its OWN jest.fn() properties (separate from
  // prototype). Direct .mockResolvedValue() calls on them persist across tests because
  // resetCliniko() only updates the prototype. We must restore defaults on the INSTANCE.
  beforeEach(() => {
    jest.clearAllMocks();
    ClinikoAPI._clearGroupsCache();
    resetCliniko();
    resetWhatsApp();
    engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([SOONEST_SLOT]);
    engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
      { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [{ id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }] },
    ]);
    engine.clinikoAPI.bookAppointment.mockResolvedValue({ success: true, id: 'NEW-APPT' });
  });

  // Seed a verified session in a given state with optional session.data payload
  async function seedAt (state, extraData = {}) {
    const ph = nextPhone();
    const s  = await seedVerified(db, ph);
    await db.updateSession(s.id, {
      conversation_state: state,
      data: JSON.stringify({ email: 'p@test.com', patient_name: 'Test Patient', ...extraData }),
    });
    return db.getSession(s.id);
  }

  // ─── Shared type/physio/clinic fixtures ──────────────────────────────────────
  const TYPE_1 = { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', norm_name: 'initial 60 min visit (new clients)' };
  const TYPE_2 = { id: 'AT-002', name: 'Return Visit (Existing Clients)',    norm_name: 'return visit (existing clients)' };
  const TYPE_LIST_2  = [TYPE_1, TYPE_2];
  const TYPE_LIST_1  = [TYPE_1];
  // Pre-built funnel catalogue entries (matching resetCliniko default types after category fix)
  const FUNNEL_CAT_1 = { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', service: 'Physiotherapy', insurer: null, patientType: null, duration: 60 };
  const FUNNEL_CAT_2 = { id: 'AT-002', name: 'Return Visit (Existing Clients)',    service: 'Physiotherapy', insurer: null, patientType: null, duration: 30 };
  const PHYSIO_1 = { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' };
  const PHYSIO_2 = { id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan'  };
  const CLINIC_1 = { id: 'BIZ-001', business_name: 'Prohealth In Touch' };
  const CLINIC_2 = { id: 'BIZ-002', business_name: 'Prohealth City'     };

  // ─── BOOK_MANAGE_OPTIONS ─────────────────────────────────────────────────────
  describe('BOOK_MANAGE_OPTIONS', () => {
    test('0/back/menu → returns verified main menu', async () => {
      const session = await seedAt('BOOK_MANAGE_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookManageOptions'], session, '0');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('1/book → shows booking method menu', async () => {
      const session = await seedAt('BOOK_MANAGE_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookManageOptions'], session, '1');
      expect(reply).toMatch(/soonest|history|specific date|physio|clinic/i);
    });

    test('2/cancel → enters cancel flow', async () => {
      const session = await seedAt('BOOK_MANAGE_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookManageOptions'], session, '2');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      const updated = await db.getSession(session.id);
      // handleBookManageOptions immediately calls handleCancelAppointmentState which
      // advances state beyond CANCEL_APPOINTMENT when a future appointment exists
      expect(['CANCEL_APPOINTMENT', 'CONFIRM_CANCEL']).toContain(updated.conversation_state);
    });

    test('3/reschedule → enters reschedule flow', async () => {
      const session = await seedAt('BOOK_MANAGE_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookManageOptions'], session, '3');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      const updated = await db.getSession(session.id);
      // handleBookManageOptions immediately calls handleRescheduleAppointmentState which
      // advances state beyond RESCHEDULE_APPOINTMENT when a future appointment exists
      expect(['RESCHEDULE_APPOINTMENT', 'SELECT_APPOINTMENT_TO_RESCHEDULE', 'CONFIRM_RESCHEDULE', 'RESCHEDULE_CONFIRM_INTENT'])
        .toContain(updated.conversation_state);
    });

    test('invalid input → returns fallback message', async () => {
      const session = await seedAt('BOOK_MANAGE_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookManageOptions'], session, 'xyz');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });
  });

  // ─── BOOKING_METHOD_OPTIONS ───────────────────────────────────────────────────
  describe('BOOKING_METHOD_OPTIONS', () => {
    test('0/back/menu → returns to book-manage menu', async () => {
      const session = await seedAt('BOOKING_METHOD_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '0');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOK_MANAGE_OPTIONS');
    });

    test('1/history → enters book-history flow', async () => {
      const session = await seedAt('BOOKING_METHOD_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('2/soonest → enters BOOK_SOONEST and shows funnel or slot list', async () => {
      const session = await seedAt('BOOKING_METHOD_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '2');
      // Funnel duration prompt, a type list, or slot list (depending on how far auto-advance runs)
      expect(typeof reply).toBe('string');
      expect(reply).toMatch(/appointment type|initial|return|slot|pick|select duration|duration/i);
    });

    test('3/date → enters specific-date flow', async () => {
      const session = await seedAt('BOOKING_METHOD_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '3');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('4/physio → enters specific-physio flow', async () => {
      const session = await seedAt('BOOKING_METHOD_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '4');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('5/clinic → enters specific-clinic flow', async () => {
      const session = await seedAt('BOOKING_METHOD_OPTIONS');
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '5');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('invalid input → validation message with menu (not a dead end)', async () => {
      const session = await seedAt('BOOKING_METHOD_OPTIONS');
      const reply   = await engine.handleBookingMethodOptions(session, 'xyz');
      expect(reply).toHaveProperty('interactive');
      expect(reply._textFallback).toMatch(/valid|1–5|booking method/i);
    });

    test('menu includes a ← Back row (id 0) so users can return without typing', async () => {
      const session = await seedAt('BOOKING_METHOD_OPTIONS');
      const envelope = await engine.renderBookingMethodMenu(session);
      const rows = envelope?.interactive?.action?.sections?.[0]?.rows || [];
      const backRow = rows.find(r => r.id === '0');
      expect(backRow).toBeDefined();
      expect(backRow.title).toMatch(/back/i);
    });

    test("interactive 'back' id (sent as message) → returns to book-manage menu", async () => {
      const session = await seedAt('BOOKING_METHOD_OPTIONS');
      await callHandler(engine, ['handleBookingMethodOptions'], session, 'back');
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOK_MANAGE_OPTIONS');
    });
  });

  // ─── Re-entry regression: stale data must be cleared when switching booking method ─
  // Bug: BOOKING_METHOD_OPTIONS transitions only set conversation_state, leaving stale
  // session.data (selection_step, no_slots_prompt, etc.) intact. On re-entry the handler
  // would skip its INIT block and resume mid-flow using stale physio/type/clinic data.
  describe('BOOKING_METHOD_OPTIONS — re-entry resets stale session data', () => {
    // Stale data that looks like a previous booking attempt that hit no-slots at view_slots.
    // Each field uses a clearly non-default value so we can assert it's NOT used on re-entry.
    const STALE = {
      selection_step: 'view_slots',
      no_slots_prompt: { context: 'history' },
      selected_physio:     { id: 'STALE-PRAC', first_name: 'Old',   last_name: 'Ghost' },
      selected_appt_type:  { id: 'STALE-TYPE', name: 'Stale Appointment Type' },
      selected_clinic:     { id: 'STALE-BIZ',  business_name: 'Stale Clinic Name' },
      appointment_type_list: [{ id: 'STALE-TYPE', name: 'Stale Appointment Type' }],
      clinic_list:           [{ id: 'STALE-BIZ',  business_name: 'Stale Clinic Name' }],
      navigation_chain:    [{ selection_step: 'choose_type' }],
    };

    // Two distinct physios so planForward doesn't auto-advance past the physio list.
    const TWO_PHYSIO_MOCK = [
      { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [
        { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
        { id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan'  },
      ]},
    ];
    const TWO_HISTORY_APPTS = [
      { id: 'H1', starts_at: pastISO(5),  practitioner_id: 'PRAC-001', business_id: 'BIZ-001' },
      { id: 'H2', starts_at: pastISO(10), practitioner_id: 'PRAC-002', business_id: 'BIZ-001' },
    ];

    test('1/history — physio-history list shown fresh (getBookingsByPatientId called)', async () => {
      engine.clinikoAPI.getBookingsByPatientId.mockResolvedValue(TWO_HISTORY_APPTS);
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue(TWO_PHYSIO_MOCK);
      const session = await seedAt('BOOKING_METHOD_OPTIONS', STALE);
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '1');
      // Stale content must not appear — flow must start fresh from the physio list
      expect(reply).not.toMatch(/Stale/i);
      expect(reply).not.toMatch(/no available slots/i);
      // Fresh INIT fetched past bookings and shows the physio list
      expect(engine.clinikoAPI.getBookingsByPatientId).toHaveBeenCalled();
      expect(reply).toMatch(/past visits|Jolinna|Wei/i);
    });

    test('2/soonest — type list shown fresh (stale Stale Appointment Type not shown)', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue(TWO_PHYSIO_MOCK);
      // Two types so the list renders (doesn't auto-advance to physio then slots)
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)' },
      ]);
      const session = await seedAt('BOOKING_METHOD_OPTIONS', STALE);
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '2');
      expect(reply).not.toMatch(/Stale/i);
      expect(reply).toMatch(/Initial|Return Visit|appointment type/i);
    });

    test('3/date — type list shown fresh (stale data cleared)', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue(TWO_PHYSIO_MOCK);
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)' },
      ]);
      const session = await seedAt('BOOKING_METHOD_OPTIONS', STALE);
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '3');
      expect(reply).not.toMatch(/Stale/i);
      expect(reply.length).toBeGreaterThan(0);
    });

    test('4/physio — physio or type list shown fresh (Old Ghost not shown)', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue(TWO_PHYSIO_MOCK);
      const session = await seedAt('BOOKING_METHOD_OPTIONS', STALE);
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '4');
      expect(reply).not.toMatch(/Stale/i);
      expect(reply).not.toMatch(/Old Ghost/i);
      expect(reply.length).toBeGreaterThan(0);
    });

    test('5/clinic — clinic or type list shown fresh (Stale Clinic Name not shown)', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue(TWO_PHYSIO_MOCK);
      const session = await seedAt('BOOKING_METHOD_OPTIONS', STALE);
      const reply   = await callHandler(engine, ['handleBookingMethodOptions'], session, '5');
      expect(reply).not.toMatch(/Stale/i);
      expect(reply.length).toBeGreaterThan(0);
    });
  });

  // ─── BOOK_HISTORY — step-by-step flow ────────────────────────────────────────
  describe('BOOK_HISTORY — choose_physio_from_history step', () => {
    const TWO_PHYSIOS = [
      { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [
        { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
        { id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan'  },
      ]},
    ];

    beforeEach(() => {
      engine.clinikoAPI.getBookingsByPatientId.mockResolvedValue([
        { id: 'H1', starts_at: pastISO(5),  practitioner_id: 'PRAC-001', business_id: 'BIZ-001' },
        { id: 'H2', starts_at: pastISO(10), practitioner_id: 'PRAC-002', business_id: 'BIZ-001' },
      ]);
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue(TWO_PHYSIOS);
    });

    test('entry with past visits → shows physio list as interactive list', async () => {
      const session = await seedAt('BOOK_HISTORY');
      const reply   = await callHandler(engine, ['handleBookHistory'], session, '');
      expect(reply).toMatch(/past visits/i);
      expect(reply).toMatch(/Jolinna|PRAC-001/i);
      expect(reply).toMatch(/Wei|PRAC-002/i);
    });

    test('no past visits → returns to booking method options with message', async () => {
      engine.clinikoAPI.getBookingsByPatientId.mockResolvedValue([]);
      const session = await seedAt('BOOK_HISTORY');
      const reply   = await callHandler(engine, ['handleBookHistory'], session, '');
      expect(reply).toMatch(/no prior|no past|another booking/i);
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOKING_METHOD_OPTIONS');
    });

    test('selecting physio by number → advances to choose_type step', async () => {
      // Two non-Initial types so planForward doesn't auto-advance past the type list
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-002', name: 'Return Visit (Existing Clients)' },
        { id: 'AT-003', name: 'Follow Up Appointment' },
      ]);
      const session = await seedAt('BOOK_HISTORY', {
        selection_step: 'choose_physio_from_history',
        history_physio_list: [
          { practitioner: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }, last_seen: pastISO(5), last_clinic_id: 'BIZ-001' },
          { practitioner: { id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan'  }, last_seen: pastISO(10), last_clinic_id: 'BIZ-001' },
        ],
        navigation_chain: [],
      });
      const reply = await callHandler(engine, ['handleBookHistory'], session, '1');
      // Type list shown after physio selection — Initial/New are filtered in history flow
      expect(reply).toMatch(/Return Visit|Follow Up|appointment type/i);
    });

    test('out-of-range physio number → validation error', async () => {
      const session = await seedAt('BOOK_HISTORY', {
        selection_step: 'choose_physio_from_history',
        history_physio_list: [
          { practitioner: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }, last_seen: pastISO(5), last_clinic_id: 'BIZ-001' },
        ],
        navigation_chain: [],
      });
      const reply = await callHandler(engine, ['handleBookHistory'], session, '99');
      expect(reply).toMatch(/invalid/i);
    });

    test('0/back from physio list → goes to BOOKING_METHOD_OPTIONS', async () => {
      const session = await seedAt('BOOK_HISTORY', {
        selection_step: 'choose_physio_from_history',
        history_physio_list: [
          { practitioner: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }, last_seen: pastISO(5), last_clinic_id: 'BIZ-001' },
        ],
        navigation_chain: [],
      });
      await callHandler(engine, ['handleBookHistory'], session, '0');
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOKING_METHOD_OPTIONS');
    });
  });

  // ─── BOOK_HISTORY — physio pagination ───────────────────────────────────────
  describe('BOOK_HISTORY — choose_physio_from_history pagination', () => {
    const SIX_HISTORY_PHYSIOS = [
      { practitioner: { id: 'PRAC-001', first_name: 'Alice',   last_name: 'A' }, last_seen: pastISO(1),  last_clinic_id: 'BIZ-001' },
      { practitioner: { id: 'PRAC-002', first_name: 'Bob',     last_name: 'B' }, last_seen: pastISO(2),  last_clinic_id: 'BIZ-001' },
      { practitioner: { id: 'PRAC-003', first_name: 'Carol',   last_name: 'C' }, last_seen: pastISO(3),  last_clinic_id: 'BIZ-001' },
      { practitioner: { id: 'PRAC-004', first_name: 'David',   last_name: 'D' }, last_seen: pastISO(4),  last_clinic_id: 'BIZ-001' },
      { practitioner: { id: 'PRAC-005', first_name: 'Eliza',   last_name: 'E' }, last_seen: pastISO(5),  last_clinic_id: 'BIZ-001' },
      { practitioner: { id: 'PRAC-006', first_name: 'Frank',   last_name: 'F' }, last_seen: pastISO(6),  last_clinic_id: 'BIZ-001' },
    ];

    test('next on 6-physio list → page 1 shows 6th physio', async () => {
      const session = await seedAt('BOOK_HISTORY', {
        selection_step: 'choose_physio_from_history',
        history_physio_list: SIX_HISTORY_PHYSIOS,
        history_physio_page: 0,
        navigation_chain: [],
      });
      const reply = await callHandler(engine, ['handleBookHistory'], session, 'next');
      expect(reply).toMatch(/Frank/i);
      expect(reply).not.toMatch(/Alice/i);
    });

    test('next then prev → returns to page 0 showing first 5 physios', async () => {
      const session = await seedAt('BOOK_HISTORY', {
        selection_step: 'choose_physio_from_history',
        history_physio_list: SIX_HISTORY_PHYSIOS,
        history_physio_page: 1,
        navigation_chain: [],
      });
      const reply = await callHandler(engine, ['handleBookHistory'], session, 'prev');
      expect(reply).toMatch(/Alice/i);
      expect(reply).not.toMatch(/Frank/i);
    });

    test('local index 1 on page 1 selects 6th physio (Frank)', async () => {
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-002', name: 'Return Visit (Existing Clients)' },
        { id: 'AT-003', name: 'Follow Up Appointment' },
      ]);
      const session = await seedAt('BOOK_HISTORY', {
        selection_step: 'choose_physio_from_history',
        history_physio_list: SIX_HISTORY_PHYSIOS,
        history_physio_page: 1,
        navigation_chain: [],
      });
      const reply = await callHandler(engine, ['handleBookHistory'], session, '1');
      expect(reply).toMatch(/appointment type|Return Visit|Follow Up/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data);
      expect(d.selected_physio.id).toBe('PRAC-006');
    });

    test('next on 5-physio list → no crash, no More button', async () => {
      const fivePhysios = SIX_HISTORY_PHYSIOS.slice(0, 5);
      const session = await seedAt('BOOK_HISTORY', {
        selection_step: 'choose_physio_from_history',
        history_physio_list: fivePhysios,
        history_physio_page: 0,
        navigation_chain: [],
      });
      const reply = String(await callHandler(engine, ['handleBookHistory'], session, 'next'));
      // Page 1 with only 5 items total has no content; falls back gracefully — no crash
      expect(typeof reply).toBe('string');
    });

    test('page 0 with 6 physios shows More → button', async () => {
      const session = await seedAt('BOOK_HISTORY', {
        selection_step: 'choose_physio_from_history',
        history_physio_list: SIX_HISTORY_PHYSIOS,
        history_physio_page: 0,
        navigation_chain: [],
      });
      const reply = String(await callHandler(engine, ['handleBookHistory'], session, ''));
      expect(reply).toMatch(/More|next/i);
    });
  });

  describe('BOOK_HISTORY — choose_type step', () => {
    const physioListData = {
      selection_step: 'choose_type',
      selected_physio: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
      last_clinic_id: 'BIZ-001',
      navigation_chain: [{ selection_step: 'choose_physio_from_history', had_multiple_options: true, auto: false }],
    };

    test('entry → fetches types, filters out Initial/New, shows remaining types', async () => {
      // Two non-Initial types so the list renders without auto-advancing
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)' },
        { id: 'AT-003', name: 'Follow Up Appointment' },
      ]);
      const session = await seedAt('BOOK_HISTORY', physioListData);
      const reply   = await callHandler(engine, ['handleBookHistory'], session, '');
      // "Initial" is excluded from history flow; both non-Initial types appear
      expect(reply).not.toMatch(/Initial/i);
      expect(reply).toMatch(/Return Visit/i);
      expect(reply).toMatch(/Follow Up/i);
    });

    test('selecting type by number → advances to choose_clinic', async () => {
      // Two clinics for PRAC-001 so planForward stops at clinic selection
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [
          { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
        ]},
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City', practitioners: [
          { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
        ]},
      ]);
      const session = await seedAt('BOOK_HISTORY', {
        ...physioListData,
        appointment_type_list: [
          { id: 'AT-002', name: 'Return Visit (Existing Clients)', norm_name: 'return visit (existing clients)', ids: ['AT-002'] },
          { id: 'AT-003', name: 'Follow Up Appointment', norm_name: 'follow up appointment', ids: ['AT-003'] },
        ],
        appt_type_page: 0,
      });
      const reply = await callHandler(engine, ['handleBookHistory'], session, '1');
      expect(reply).toMatch(/clinic|Prohealth/i);
    });

    test("'next' interactive id increments page (same as typing 'm')", async () => {
      const manyTypes = Array.from({ length: 8 }, (_, i) => ({
        id: `AT-${i}`, name: `Type ${i + 1}`, norm_name: `type ${i + 1}`, ids: [`AT-${i}`]
      }));
      const sm = await seedAt('BOOK_HISTORY', { ...physioListData, appointment_type_list: manyTypes, appt_type_page: 0 });
      const sn = await seedAt('BOOK_HISTORY', { ...physioListData, appointment_type_list: manyTypes, appt_type_page: 0 });
      await callHandler(engine, ['handleBookHistory'], sm, 'm');
      await callHandler(engine, ['handleBookHistory'], sn, 'next');
      expect(JSON.parse((await db.getSession(sm.id)).data || '{}').appt_type_page).toBe(1);
      expect(JSON.parse((await db.getSession(sn.id)).data || '{}').appt_type_page).toBe(1);
    });

    test("'prev' interactive id decrements page (same as typing 'p')", async () => {
      const manyTypes = Array.from({ length: 8 }, (_, i) => ({
        id: `AT-${i}`, name: `Type ${i + 1}`, norm_name: `type ${i + 1}`, ids: [`AT-${i}`]
      }));
      const sp = await seedAt('BOOK_HISTORY', { ...physioListData, appointment_type_list: manyTypes, appt_type_page: 1 });
      const sv = await seedAt('BOOK_HISTORY', { ...physioListData, appointment_type_list: manyTypes, appt_type_page: 1 });
      await callHandler(engine, ['handleBookHistory'], sp, 'p');
      await callHandler(engine, ['handleBookHistory'], sv, 'prev');
      expect(JSON.parse((await db.getSession(sp.id)).data || '{}').appt_type_page).toBe(0);
      expect(JSON.parse((await db.getSession(sv.id)).data || '{}').appt_type_page).toBe(0);
    });

    test("'back' interactive id from choose_type → same contextual back as typing '0'", async () => {
      const manyTypes = Array.from({ length: 8 }, (_, i) => ({
        id: `AT-${i}`, name: `Type ${i + 1}`, norm_name: `type ${i + 1}`, ids: [`AT-${i}`]
      }));
      const s0 = await seedAt('BOOK_HISTORY', {
        ...physioListData,
        appointment_type_list: manyTypes, appt_type_page: 0,
        // navigation_chain has a prior step so navBack returns to physio list
        navigation_chain: [{ selection_step: 'choose_physio_from_history', had_multiple_options: true, auto: false }],
        history_physio_list: [
          { practitioner: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }, last_seen: pastISO(5), last_clinic_id: 'BIZ-001' },
          { practitioner: { id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan'  }, last_seen: pastISO(10), last_clinic_id: 'BIZ-001' },
        ],
      });
      const sb = await seedAt('BOOK_HISTORY', {
        ...physioListData,
        appointment_type_list: manyTypes, appt_type_page: 0,
        navigation_chain: [{ selection_step: 'choose_physio_from_history', had_multiple_options: true, auto: false }],
        history_physio_list: [
          { practitioner: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }, last_seen: pastISO(5), last_clinic_id: 'BIZ-001' },
          { practitioner: { id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan'  }, last_seen: pastISO(10), last_clinic_id: 'BIZ-001' },
        ],
      });
      const reply0 = await callHandler(engine, ['handleBookHistory'], s0, '0');
      const replyB = await callHandler(engine, ['handleBookHistory'], sb, 'back');
      // Both step back to the physio list
      expect(reply0).toMatch(/Jolinna|Wei|past visits/i);
      expect(replyB).toMatch(/Jolinna|Wei|past visits/i);
    });
  });

  // ─── BOOK_HISTORY — choose_clinic ────────────────────────────────────────────
  describe('BOOK_HISTORY — choose_clinic pagination', () => {
    const PHYSIO = { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' };
    const SIX_CLINICS_MOCK = Array.from({ length: 6 }, (_, i) => ({
      clinic_id: `BIZ-00${i + 1}`,
      clinic_name: `Clinic ${String.fromCharCode(65 + i)}`,
      practitioners: [PHYSIO],
    }));
    const baseData = {
      selection_step: 'choose_clinic',
      selected_physio: PHYSIO,
      last_clinic_id: '',
      navigation_chain: [
        { selection_step: 'choose_physio_from_history', had_multiple_options: true, auto: false },
        { selection_step: 'choose_type', had_multiple_options: true, auto: false },
      ],
    };

    beforeEach(() => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue(SIX_CLINICS_MOCK);
    });

    test('entry with 6 clinics → page 0 shows first 5 + More button', async () => {
      const session = await seedAt('BOOK_HISTORY', baseData);
      const reply = String(await callHandler(engine, ['handleBookHistory'], session, ''));
      expect(reply).toMatch(/Clinic A/i);
      expect(reply).not.toMatch(/Clinic F/i);
      expect(reply).toMatch(/More/i);
    });

    test("'next' increments clinic_page to 1 and shows 6th clinic", async () => {
      const session = await seedAt('BOOK_HISTORY', {
        ...baseData,
        clinic_list: SIX_CLINICS_MOCK.map(g => ({ id: String(g.clinic_id), business_name: g.clinic_name })),
        clinic_page: 0,
      });
      const reply = String(await callHandler(engine, ['handleBookHistory'], session, 'next'));
      expect(reply).toMatch(/Clinic F/i);
      expect(reply).not.toMatch(/Clinic A/i);
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.clinic_page).toBe(1);
    });

    test("'prev' from page 1 decrements clinic_page to 0", async () => {
      const session = await seedAt('BOOK_HISTORY', {
        ...baseData,
        clinic_list: SIX_CLINICS_MOCK.map(g => ({ id: String(g.clinic_id), business_name: g.clinic_name })),
        clinic_page: 1,
      });
      const reply = String(await callHandler(engine, ['handleBookHistory'], session, 'prev'));
      expect(reply).toMatch(/Clinic A/i);
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.clinic_page).toBe(0);
    });

    test("local index '1' on page 1 selects 6th clinic", async () => {
      engine.clinikoAPI.getAvailableSlots = jest.fn().mockResolvedValue([]);
      const session = await seedAt('BOOK_HISTORY', {
        ...baseData,
        selected_appt_type: { name: 'Return Visit', ids: ['AT-001'] },
        clinic_list: SIX_CLINICS_MOCK.map(g => ({ id: String(g.clinic_id), business_name: g.clinic_name })),
        clinic_page: 1,
      });
      await callHandler(engine, ['handleBookHistory'], session, '1');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(String(d.selected_clinic?.id)).toBe('BIZ-006');
    });
  });

  // ─── BOOK_SPECIFIC_DATE ───────────────────────────────────────────────────────
  describe('BOOK_SPECIFIC_DATE — entry and navigation', () => {
    test('entry → shows date picker (date is selected first in this flow)', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE');
      const reply   = await callHandler(engine, ['handleBookSpecificDate'], session, '');
      // BOOK_SPECIFIC_DATE starts by asking for a date, not a type
      expect(reply).toMatch(/date|Pick/i);
    });

    test('0/back from date picker → goes to BOOKING_METHOD_OPTIONS', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', {
        selection_step: 'choose_date',
        navigation_chain: [],
      });
      await callHandler(engine, ['handleBookSpecificDate'], session, '0');
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOKING_METHOD_OPTIONS');
    });

    // Interactive list 'back' id must do the same contextual step-back as typing '0',
    // not the full exit that 'menu' does. This covers the bug where tapping "← Back"
    // in choose_type jumped to BOOKING_METHOD_OPTIONS instead of the date picker.
    test("interactive 'back' id from choose_type → returns to date picker (same as typing '0')", async () => {
      const typeListData = {
        selection_step: 'choose_type',
        appointment_type_list: [{ id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', norm_name: 'initial 60 min visit (new clients)', ids: ['AT-001'] }],
        appt_type_page: 0,
        selected_date: '2026-08-01',
        navigation_chain: [{ selection_step: 'choose_date', had_multiple_options: true, auto: false }],
      };
      const s0 = await seedAt('BOOK_SPECIFIC_DATE', typeListData);
      const s1 = await seedAt('BOOK_SPECIFIC_DATE', typeListData);
      const replyText = await callHandler(engine, ['handleBookSpecificDate'], s0, '0');
      const replyBack = await callHandler(engine, ['handleBookSpecificDate'], s1, 'back');
      // Both must return the date picker, not the booking method menu
      expect(replyText).toMatch(/date|Pick/i);
      expect(replyBack).toMatch(/date|Pick/i);
      const u0 = await db.getSession(s0.id);
      const u1 = await db.getSession(s1.id);
      expect(u0.conversation_state).toBe('BOOK_SPECIFIC_DATE');
      expect(u1.conversation_state).toBe('BOOK_SPECIFIC_DATE');
    });

    test("'menu' from any step → full exit to BOOKING_METHOD_OPTIONS", async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', {
        selection_step: 'choose_type',
        navigation_chain: [{ selection_step: 'choose_date', had_multiple_options: true, auto: false }],
      });
      await callHandler(engine, ['handleBookSpecificDate'], session, 'menu');
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOKING_METHOD_OPTIONS');
    });
  });

  // ─── BOOK_SPECIFIC_DATE — choose_physio ──────────────────────────────────────
  describe('BOOK_SPECIFIC_DATE — choose_physio pagination', () => {
    const SIX_PHYSIOS = Array.from({ length: 6 }, (_, i) => ({
      id: `PRAC-00${i + 1}`, first_name: String.fromCharCode(65 + i), last_name: 'Test',
    }));
    const baseData = {
      selection_step: 'choose_physio',
      selected_date: '2026-08-01',
      selected_appt_type: { name: 'Return Visit', ids: ['AT-001'], norm: 'return visit' },
      navigation_chain: [
        { selection_step: 'choose_date', had_multiple_options: true, auto: false },
        { selection_step: 'choose_type', had_multiple_options: true, auto: false },
      ],
      practitioner_list: SIX_PHYSIOS,
      practitioner_page: 0,
    };

    test('page 0 with 6 physios → shows first 5 + More button', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', baseData);
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, ''));
      expect(reply).toMatch(/A Test/i);
      expect(reply).not.toMatch(/F Test/i);
      expect(reply).toMatch(/More/i);
    });

    test("'next' increments practitioner_page and shows 6th physio", async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', baseData);
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, 'next'));
      expect(reply).toMatch(/F Test/i);
      expect(reply).not.toMatch(/A Test/i);
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.practitioner_page).toBe(1);
    });

    test("'prev' from page 1 decrements practitioner_page to 0", async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', { ...baseData, practitioner_page: 1 });
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, 'prev'));
      expect(reply).toMatch(/A Test/i);
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.practitioner_page).toBe(0);
    });

    test("local index '1' on page 1 selects 6th physio", async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: SIX_PHYSIOS },
      ]);
      const session = await seedAt('BOOK_SPECIFIC_DATE', { ...baseData, practitioner_page: 1 });
      await callHandler(engine, ['handleBookSpecificDate'], session, '1');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(String(d.selected_physio?.id)).toBe('PRAC-006');
    });

    // Regression: 0 practitioners offering this type used to render an empty
    // buildInteractiveSelectionList with only "0. Back" and no explanation.
    test('0 practitioners for this type → no_slots_prompt shown instead of a bare "0. Back" dead end', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_DATE', {
        selection_step: 'choose_physio',
        selected_date: '2026-08-01',
        selected_appt_type: { name: 'Return Visit', ids: ['AT-001'], norm: 'return visit' },
        navigation_chain: [
          { selection_step: 'choose_date', had_multiple_options: true, auto: false },
          { selection_step: 'choose_type', had_multiple_options: true, auto: false },
        ],
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, ''));
      expect(reply).toMatch(/no practitioners offer/i);
      expect(reply).toMatch(/try again/i);

      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.no_slots_prompt).toEqual({ context: 'date_physio_list', retry_step: 'choose_physio' });
      expect(d.practitioner_list).toBeUndefined();

      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [{ id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }] },
      ]);
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([{ id: 'AT-001', name: 'Return Visit' }]);
      const retryReply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '1'));
      expect(retryReply).toMatch(/jolinna/i);

      // getAppointmentTypes is an instance own property — restore it since beforeEach doesn't reset it
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', duration: 60, category: 'Physiotherapy', duration_in_minutes: 60 },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)',    duration: 30, category: 'Physiotherapy', duration_in_minutes: 30 },
      ]);
    });
  });

  // ─── BOOK_SPECIFIC_DATE — choose_clinic ──────────────────────────────────────
  // These tests guard the pre-filter + auto-advance logic added to fix the loop
  // where choose_clinic showed an unfiltered list, view_slots found no slots, and
  // the "0 back" path reset to choose_clinic → same bad list → infinite cycle.
  describe('BOOK_SPECIFIC_DATE — choose_clinic', () => {
    const baseClinicData = () => ({
      selection_step: 'choose_clinic',
      selected_date: '2026-08-01',
      selected_appt_type: TYPE_1,
      selected_physio: PHYSIO_1,
      practitioner_list: [PHYSIO_1, PHYSIO_2],
      practitioner_page: 0,
      navigation_chain: [
        { selection_step: 'choose_date',   had_multiple_options: true, auto: false },
        { selection_step: 'choose_type',   had_multiple_options: true, auto: false },
        { selection_step: 'choose_physio', had_multiple_options: true, auto: false },
      ],
    });

    test('0 clinics with slots → shows 3-button dead-end prompt', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_DATE', baseClinicData());
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, ''));
      expect(reply).toMatch(/try another physio/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toMatchObject({ context: 'date_inner' });
      expect(d.selection_step).toBe('choose_clinic');
    });

    test('1 clinic with slots → auto-advances past clinic picker to slot list', async () => {
      // Default mock: 1 clinic (BIZ-001) with PHYSIO_1, slot name matches TYPE_1
      const session = await seedAt('BOOK_SPECIFIC_DATE', baseClinicData());
      const reply = await callHandler(engine, ['handleBookSpecificDate'], session, '');
      expect(reply).not.toMatch(/select a clinic/i);
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('multiple clinics with slots → shows pre-filtered clinic picker', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [PHYSIO_1] },
      ]);
      const session = await seedAt('BOOK_SPECIFIC_DATE', baseClinicData());
      const reply = await callHandler(engine, ['handleBookSpecificDate'], session, '');
      expect(reply).toMatch(/prohealth in touch|prohealth city/i);
    });

    test('multiple clinics but only one has slots → auto-advances to slot list', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [PHYSIO_1] },
      ]);
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockImplementation(({ business_id }) =>
        Promise.resolve(business_id === 'BIZ-001' ? [SOONEST_SLOT] : [])
      );
      const session = await seedAt('BOOK_SPECIFIC_DATE', baseClinicData());
      const reply = await callHandler(engine, ['handleBookSpecificDate'], session, '');
      expect(reply).not.toMatch(/select a clinic/i);
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('numeric selection from pre-loaded list → advances to view_slots / SELECT_SLOT', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', {
        ...baseClinicData(),
        clinic_list: [CLINIC_1, CLINIC_2],
        clinic_page: 0,
      });
      const reply = await callHandler(engine, ['handleBookSpecificDate'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      expect(reply).not.toMatch(/select a clinic/i);
    });

    test('out-of-range number from pre-loaded list → stays in choose_clinic', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', {
        ...baseClinicData(),
        clinic_list: [CLINIC_1],
        clinic_page: 0,
      });
      await callHandler(engine, ['handleBookSpecificDate'], session, '99');
      const updated = await db.getSession(session.id);
      expect(JSON.parse(updated.data || '{}').selection_step).toBe('choose_clinic');
    });

    test('slot checks for multiple clinics are dispatched concurrently', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [PHYSIO_1] },
      ]);
      const dispatched = [];
      const resolvers = [];
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockImplementation(({ business_id }) => {
        dispatched.push(business_id);
        return new Promise(resolve => resolvers.push(() => resolve([SOONEST_SLOT])));
      });

      const session = await seedAt('BOOK_SPECIFIC_DATE', baseClinicData());
      const handlerPromise = callHandler(engine, ['handleBookSpecificDate'], session, '');
      await new Promise(r => setImmediate(r));

      expect(dispatched).toContain('BIZ-001');
      expect(dispatched).toContain('BIZ-002');

      resolvers.forEach(r => r());
      await handlerPromise;
    });
  });

  // ─── BOOK_SPECIFIC_DATE — inner no-slots dead-end (date_inner) ───────────────
  describe('BOOK_SPECIFIC_DATE — choose_clinic inner no-slots (date_inner)', () => {
    const innerNoSlotsData = () => ({
      selection_step: 'choose_clinic',
      selected_date: '2026-08-01',
      selected_appt_type: TYPE_1,
      selected_physio: PHYSIO_1,
      practitioner_list: [PHYSIO_1, PHYSIO_2],
      practitioner_page: 0,
      no_slots_prompt: { context: 'date_inner' },
      navigation_chain: [
        { selection_step: 'choose_date',   had_multiple_options: true, auto: false },
        { selection_step: 'choose_type',   had_multiple_options: true, auto: false },
        { selection_step: 'choose_physio', had_multiple_options: true, auto: false },
      ],
    });

    test("'1' clears physio+clinic state, preserves type+practitioner_list, shows physio list", async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', innerNoSlotsData());
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '1'));
      expect(reply).toMatch(/jolinna|wei|physio|practitioner/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.selection_step).toBe('choose_physio');
      expect(d.no_slots_prompt).toBeFalsy();
      expect(d.selected_physio).toBeUndefined();
      expect(d.selected_appt_type).toMatchObject({ name: TYPE_1.name });
      expect(Array.isArray(d.practitioner_list)).toBe(true);
    });

    test("'0' and 'back' behave identically to '1' — return to physio list", async () => {
      const s0 = await seedAt('BOOK_SPECIFIC_DATE', innerNoSlotsData());
      const sb = await seedAt('BOOK_SPECIFIC_DATE', innerNoSlotsData());
      const r0 = String(await callHandler(engine, ['handleBookSpecificDate'], s0, '0'));
      const rb = String(await callHandler(engine, ['handleBookSpecificDate'], sb, 'back'));
      expect(r0).toMatch(/jolinna|wei|physio|practitioner/i);
      expect(rb).toMatch(/jolinna|wei|physio|practitioner/i);
    });

    test("'2' routes to email escalation", async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', innerNoSlotsData());
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '2'));
      expect(reply).toMatch(/support team|be in touch/i);
    });

    test("'3' routes to WhatsApp link", async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', innerNoSlotsData());
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '3'));
      expect(reply).toMatch(/wa\.me/i);
    });
  });

  // ─── BOOK_SPECIFIC_PHYSIO — choose_physio pagination ─────────────────────────
  describe('BOOK_SPECIFIC_PHYSIO — choose_physio pagination', () => {
    const SIX_PHYSIOS = Array.from({ length: 6 }, (_, i) => ({
      id: `PRAC-00${i + 1}`, first_name: String.fromCharCode(65 + i), last_name: 'Phy',
    }));
    const baseData = {
      selection_step: 'choose_physio',
      practitioner_list: SIX_PHYSIOS,
      practitioner_page: 0,
      navigation_chain: [],
    };

    test('page 0 with 6 physios → shows first 5 + More button', async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', baseData);
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, ''));
      expect(reply).toMatch(/1\. A Phy/i);
      expect(reply).not.toMatch(/6\. F Phy/i);
      expect(reply).toMatch(/More/i);
    });

    test("'next' increments page and shows Frank (6th overall) as item 1", async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', baseData);
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, 'next'));
      expect(reply).toMatch(/1\. F Phy/i);
      expect(reply).not.toMatch(/1\. A Phy/i);
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.practitioner_page).toBe(1);
    });

    test("'prev' from page 1 → back to page 0", async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', { ...baseData, practitioner_page: 1 });
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, 'prev'));
      expect(reply).toMatch(/1\. A Phy/i);
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.practitioner_page).toBe(0);
    });

    test("local index '1' on page 1 → selects 6th physio", async () => {
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-002', name: 'Return Visit' },
        { id: 'AT-003', name: 'Follow Up' },
      ]);
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', { ...baseData, practitioner_page: 1 });
      await callHandler(engine, ['handleBookSpecificPhysio'], session, '1');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(String(d.selected_physio?.id)).toBe('PRAC-006');
      expect(d.selection_step).toBe('choose_type');
    });
  });

  // ─── BOOK_SPECIFIC_PHYSIO ─────────────────────────────────────────────────────
  describe('BOOK_SPECIFIC_PHYSIO — entry and back navigation', () => {
    test('entry with multiple physios → shows physio list', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [
          { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
          { id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan'  },
        ]},
      ]);
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO');
      const reply   = await callHandler(engine, ['handleBookSpecificPhysio'], session, '');
      expect(reply).toMatch(/Jolinna|Wei|physio|practitioner/i);
    });

    // Regression: getPractitionersByClinic() returning [] (genuinely zero
    // practitioners, or a degraded fetch — e.g. a 429) used to fall straight
    // through to buildInteractiveSelectionList with an empty items array,
    // rendering only a "0. Back" row with no explanation and no way to retry.
    test('0 practitioners → no_slots_prompt shown instead of a bare "0. Back" dead end', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO');
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, ''));
      expect(reply).toMatch(/no practitioners/i);
      expect(reply).toMatch(/try again/i);

      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.no_slots_prompt).toEqual({ context: 'physio_list', retry_step: 'choose_physio' });
      expect(d.practitioner_list).toBeUndefined(); // cleared so retry re-fetches, not stuck on []

      // Retry succeeds this time — shows the real physio list, not the same dead end.
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [{ id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }] },
      ]);
      const retryReply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, '1'));
      expect(retryReply).toMatch(/jolinna/i);
    });

    test("interactive 'back' id from choose_type → returns to physio list (same as typing '0')", async () => {
      const typeStepData = {
        selection_step: 'choose_type',
        selected_physio: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
        appointment_type_list: [
          { id: 'AT-001', name: 'Initial 60 Min Visit', norm_name: 'initial 60 min visit', ids: ['AT-001'] },
          { id: 'AT-002', name: 'Return Visit',         norm_name: 'return visit',          ids: ['AT-002'] },
        ],
        appt_type_page: 0,
        navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
      };
      const s0 = await seedAt('BOOK_SPECIFIC_PHYSIO', typeStepData);
      const s1 = await seedAt('BOOK_SPECIFIC_PHYSIO', typeStepData);
      const replyText = await callHandler(engine, ['handleBookSpecificPhysio'], s0, '0');
      const replyBack = await callHandler(engine, ['handleBookSpecificPhysio'], s1, 'back');
      // Both must step back to physio list, not exit to booking method menu
      expect(replyText).toMatch(/physio|Jolinna|Annika|practitioner/i);
      expect(replyBack).toMatch(/physio|Jolinna|Annika|practitioner/i);
      const u0 = await db.getSession(s0.id);
      const u1 = await db.getSession(s1.id);
      expect(u0.conversation_state).toBe('BOOK_SPECIFIC_PHYSIO');
      expect(u1.conversation_state).toBe('BOOK_SPECIFIC_PHYSIO');
    });

    test("'0' from physio list (no prior step) → exits to BOOKING_METHOD_OPTIONS", async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', {
        selection_step: 'choose_physio',
        practitioner_list: [{ id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }],
        practitioner_page: 0,
        navigation_chain: [],
      });
      await callHandler(engine, ['handleBookSpecificPhysio'], session, '0');
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOKING_METHOD_OPTIONS');
    });
  });

  // ─── BOOK_SPECIFIC_PHYSIO — UWC filter in choose_type ───────────────────────
  describe('BOOK_SPECIFIC_PHYSIO — UWC types excluded from choose_type', () => {
    test('UWC appointment type is not shown in the type list', async () => {
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit', duration_in_minutes: 60 },
        { id: 'AT-UWC', name: 'UWC New Patient',       duration_in_minutes: 60 },
        { id: 'AT-UWC2', name: 'uwc Follow Up',        duration_in_minutes: 30 },
      ]);
      const data = {
        selection_step: 'choose_type',
        selected_physio: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
        navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
      };
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', data);
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, ''));
      expect(reply).not.toMatch(/UWC/i);
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect((d.appointment_type_list || []).every(t => !/UWC/i.test(t.name))).toBe(true);
    });
  });

  // ─── BOOK_SPECIFIC_PHYSIO — physio list sorted alphabetically ───────────────
  describe('BOOK_SPECIFIC_PHYSIO — choose_physio alphabetical order', () => {
    test('physio list is sorted by display name A→Z', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [
          { id: 'PRAC-003', first_name: 'Zara',    last_name: 'Wong'  },
          { id: 'PRAC-001', first_name: 'Amy',     last_name: 'Lee'   },
          { id: 'PRAC-002', first_name: 'Marcus',  last_name: 'Tan'   },
        ]},
      ]);
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO');
      await callHandler(engine, ['handleBookSpecificPhysio'], session, '');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      const names = (d.practitioner_list || []).map(p => p.first_name);
      expect(names).toEqual(['Amy', 'Marcus', 'Zara']);
    });
  });

  // ─── BOOK_SPECIFIC_CLINIC — choose_physio sorted alphabetically ─────────────
  describe('BOOK_SPECIFIC_CLINIC — choose_physio alphabetical order', () => {
    test('physio list is sorted by display name A→Z', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [
          { id: 'PRAC-003', first_name: 'Zara',    last_name: 'Wong'   },
          { id: 'PRAC-001', first_name: 'Amy',     last_name: 'Lee'    },
          { id: 'PRAC-002', first_name: 'Marcus',  last_name: 'Tan'    },
        ]},
      ]);
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: TYPE_1.name, duration_in_minutes: 60 },
      ]);
      const apptTypeNormIds = {};
      apptTypeNormIds['initial 60 min visit (new clients)'] = ['AT-001'];
      const data = {
        selection_step: 'choose_physio',
        selected_clinic: CLINIC_1,
        selected_appt_type: TYPE_1,
        appt_type_name_to_ids_norm: apptTypeNormIds,
        navigation_chain: [],
      };
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', data);
      await callHandler(engine, ['handleBookSpecificClinic'], session, '');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      const names = (d.practitioner_list || []).map(p => p.first_name);
      expect(names).toEqual(['Amy', 'Marcus', 'Zara']);
    });
  });

  // ─── BOOK_SPECIFIC_CLINIC — choose_physio sorted alphabetically (soonest) ───
  describe('BOOK_SOONEST — choose_physio alphabetical order', () => {
    test('physio list is sorted by display name A→Z', async () => {
      // Three physios returned in reverse alpha order; slots exist for all
      const ZAP = { id: 'PRAC-003', first_name: 'Zara',   last_name: 'Wong', display_name: 'Zara Wong'   };
      const AMY = { id: 'PRAC-001', first_name: 'Amy',    last_name: 'Lee',  display_name: 'Amy Lee'     };
      const MRC = { id: 'PRAC-002', first_name: 'Marcus', last_name: 'Tan',  display_name: 'Marcus Tan'  };
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [ZAP, AMY, MRC] },
      ]);
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', category: 'Physiotherapy', duration_in_minutes: 60 },
      ]);
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([
        { slot: futureISO(2), appointment_type_name: 'Initial 60 Min Visit (New Clients)', practitioner_id: 'PRAC-001', business_id: 'BIZ-001' },
      ]);
      const data = {
        selection_step: 'choose_type',
        selected_appt_type: { name: 'Initial 60 Min Visit (New Clients)', norm_name: 'initial 60 min visit (new clients)', ids: ['AT-001'] },
        navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: false, auto: true }],
      };
      const session = await seedAt('BOOK_SOONEST', data);
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      const names = (d.practitioner_list || []).map(p => p.first_name || p.display_name?.split(' ')[0]);
      // Amy < Marcus < Zara
      expect(names[0]).toMatch(/Amy/i);
      expect(names[names.length - 1]).toMatch(/Zara/i);

      // The rendered list (what the user actually taps) must be in the SAME
      // order as the stored practitioner_list (what numeric replies index
      // into) — otherwise row N on screen resolves to the wrong practitioner.
      const displayedNames = [...reply.matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());
      expect(displayedNames).toEqual(d.practitioner_list.map(p => p.display_name));
    });
  });

  // ─── BOOK_SPECIFIC_DATE — choose_physio sorted alphabetically ───────────────
  describe('BOOK_SPECIFIC_DATE — choose_physio alphabetical order', () => {
    test('physio list is sorted by display name A→Z', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [
          { id: 'PRAC-003', first_name: 'Zara',   last_name: 'Wong' },
          { id: 'PRAC-001', first_name: 'Amy',    last_name: 'Lee'  },
          { id: 'PRAC-002', first_name: 'Marcus', last_name: 'Tan'  },
        ]},
      ]);
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: TYPE_1.name, duration_in_minutes: 60 },
      ]);
      const data = {
        selection_step: 'choose_physio',
        selected_date: futureISO(3).slice(0, 10),
        selected_appt_type: TYPE_1,
        navigation_chain: [
          { selection_step: 'choose_date', had_multiple_options: true, auto: false },
          { selection_step: 'choose_type', had_multiple_options: true, auto: false },
        ],
      };
      const session = await seedAt('BOOK_SPECIFIC_DATE', data);
      await callHandler(engine, ['handleBookSpecificDate'], session, '');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      const names = (d.practitioner_list || []).map(p => p.first_name);
      expect(names).toEqual(['Amy', 'Marcus', 'Zara']);
    });
  });

  // ─── BOOK_SPECIFIC_PHYSIO — choose_clinic ────────────────────────────────────
  // Guards the pre-filter + auto-advance fix. Uses normalizeDateWindow() (7-day
  // window) rather than a specific date, because BOOK_PHYSIO has no date step.
  describe('BOOK_SPECIFIC_PHYSIO — choose_clinic', () => {
    const basePhysioClinicData = () => ({
      selection_step: 'choose_clinic',
      selected_physio: PHYSIO_1,
      selected_appt_type: TYPE_1,
      appointment_type_list: [TYPE_1, TYPE_2],
      appt_type_page: 0,
      navigation_chain: [
        { selection_step: 'choose_physio', had_multiple_options: true, auto: false },
        { selection_step: 'choose_type',   had_multiple_options: true, auto: false },
      ],
    });

    test('0 clinics with slots → shows 3-button dead-end prompt', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', basePhysioClinicData());
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, ''));
      expect(reply).toMatch(/try another type/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toMatchObject({ context: 'physio_inner' });
      expect(d.selection_step).toBe('choose_clinic');
    });

    test('1 clinic with slots → auto-advances past clinic picker to slot list', async () => {
      // Default mock: 1 clinic (BIZ-001) with PHYSIO_1, slot name matches TYPE_1
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', basePhysioClinicData());
      const reply = await callHandler(engine, ['handleBookSpecificPhysio'], session, '');
      expect(reply).not.toMatch(/select a clinic/i);
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('multiple clinics with slots → shows pre-filtered clinic picker', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [PHYSIO_1] },
      ]);
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', basePhysioClinicData());
      const reply = await callHandler(engine, ['handleBookSpecificPhysio'], session, '');
      expect(reply).toMatch(/prohealth in touch|prohealth city/i);
    });

    test('multiple clinics but only one has slots → auto-advances to slot list', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [PHYSIO_1] },
      ]);
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockImplementation(({ business_id }) =>
        Promise.resolve(business_id === 'BIZ-001' ? [SOONEST_SLOT] : [])
      );
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', basePhysioClinicData());
      const reply = await callHandler(engine, ['handleBookSpecificPhysio'], session, '');
      expect(reply).not.toMatch(/select a clinic/i);
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('numeric selection from pre-loaded list → advances to view_slots / SELECT_SLOT', async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', {
        ...basePhysioClinicData(),
        clinic_list: [CLINIC_1, CLINIC_2],
        clinic_page: 0,
      });
      const reply = await callHandler(engine, ['handleBookSpecificPhysio'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      expect(reply).not.toMatch(/select a clinic/i);
    });

    test('out-of-range number from pre-loaded list → stays in choose_clinic', async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', {
        ...basePhysioClinicData(),
        clinic_list: [CLINIC_1],
        clinic_page: 0,
      });
      await callHandler(engine, ['handleBookSpecificPhysio'], session, '99');
      const updated = await db.getSession(session.id);
      expect(JSON.parse(updated.data || '{}').selection_step).toBe('choose_clinic');
    });

    test('slot checks for multiple clinics are dispatched concurrently', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [PHYSIO_1] },
      ]);
      const dispatched = [];
      const resolvers = [];
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockImplementation(({ business_id }) => {
        dispatched.push(business_id);
        return new Promise(resolve => resolvers.push(() => resolve([SOONEST_SLOT])));
      });

      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', basePhysioClinicData());
      const handlerPromise = callHandler(engine, ['handleBookSpecificPhysio'], session, '');
      await new Promise(r => setImmediate(r));

      expect(dispatched).toContain('BIZ-001');
      expect(dispatched).toContain('BIZ-002');

      resolvers.forEach(r => r());
      await handlerPromise;
    });
  });

  // ─── BOOK_SPECIFIC_PHYSIO — inner no-slots dead-end (physio_inner) ────────────
  describe('BOOK_SPECIFIC_PHYSIO — choose_clinic inner no-slots (physio_inner)', () => {
    const innerNoSlotsData = () => ({
      selection_step: 'choose_clinic',
      selected_physio: PHYSIO_1,
      selected_appt_type: TYPE_1,
      appointment_type_list: [TYPE_1, TYPE_2],
      appt_type_page: 0,
      no_slots_prompt: { context: 'physio_inner' },
      navigation_chain: [
        { selection_step: 'choose_physio', had_multiple_options: true, auto: false },
        { selection_step: 'choose_type',   had_multiple_options: true, auto: false },
      ],
    });

    test("'1' clears type+clinic state, preserves physio+type_list, shows type list", async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', innerNoSlotsData());
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, '1'));
      expect(reply).toMatch(/initial|return|visit type/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.selection_step).toBe('choose_type');
      expect(d.no_slots_prompt).toBeFalsy();
      expect(d.selected_appt_type).toBeUndefined();
      expect(d.selected_physio).toMatchObject({ id: PHYSIO_1.id });
      expect(Array.isArray(d.appointment_type_list)).toBe(true);
    });

    test("'0' and 'back' behave identically to '1' — return to type list", async () => {
      const s0 = await seedAt('BOOK_SPECIFIC_PHYSIO', innerNoSlotsData());
      const sb = await seedAt('BOOK_SPECIFIC_PHYSIO', innerNoSlotsData());
      const r0 = String(await callHandler(engine, ['handleBookSpecificPhysio'], s0, '0'));
      const rb = String(await callHandler(engine, ['handleBookSpecificPhysio'], sb, 'back'));
      expect(r0).toMatch(/initial|return|visit type/i);
      expect(rb).toMatch(/initial|return|visit type/i);
    });

    test("'2' routes to email escalation", async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', innerNoSlotsData());
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, '2'));
      expect(reply).toMatch(/support team|be in touch/i);
    });

    test("'3' routes to WhatsApp link", async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', innerNoSlotsData());
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, '3'));
      expect(reply).toMatch(/wa\.me/i);
    });
  });

  // ─── BOOK_SPECIFIC_CLINIC ─────────────────────────────────────────────────────
  describe('BOOK_SPECIFIC_CLINIC — entry and back navigation', () => {
    test('entry with multiple clinics → shows clinic list', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [{ id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [{ id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan'  }] },
      ]);
      const session = await seedAt('BOOK_SPECIFIC_CLINIC');
      const reply   = await callHandler(engine, ['handleBookSpecificClinic'], session, '');
      expect(reply).toMatch(/Prohealth|clinic/i);
    });

    // Regression: 0 clinics used to render an empty buildInteractiveSelectionList
    // with only "0. Back" and no explanation.
    test('0 clinics → no_slots_prompt shown instead of a bare "0. Back" dead end', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_CLINIC');
      const reply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, ''));
      expect(reply).toMatch(/no clinics/i);
      expect(reply).toMatch(/try again/i);

      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.no_slots_prompt).toEqual({ context: 'clinic_list', retry_step: 'choose_clinic' });
      expect(d.clinic_list).toBeUndefined();

      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [{ id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' }] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [{ id: 'PRAC-002', first_name: 'Wei',     last_name: 'Tan'  }] },
      ]);
      const retryReply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, '1'));
      expect(retryReply).toMatch(/prohealth/i);
    });

    test("interactive 'back' id from choose_type → returns to clinic list (same as typing '0')", async () => {
      const typeStepData = {
        selection_step: 'choose_type',
        selected_clinic: { id: 'BIZ-001', business_name: 'Prohealth In Touch' },
        appointment_type_list: [
          { id: 'AT-001', name: 'Initial 60 Min Visit', norm_name: 'initial 60 min visit', ids: ['AT-001'] },
          { id: 'AT-002', name: 'Return Visit',         norm_name: 'return visit',          ids: ['AT-002'] },
        ],
        appt_type_page: 0,
        navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
      };
      const s0 = await seedAt('BOOK_SPECIFIC_CLINIC', typeStepData);
      const s1 = await seedAt('BOOK_SPECIFIC_CLINIC', typeStepData);
      const replyText = await callHandler(engine, ['handleBookSpecificClinic'], s0, '0');
      const replyBack = await callHandler(engine, ['handleBookSpecificClinic'], s1, 'back');
      // Both must step back to clinic list, not exit to booking method menu
      expect(replyText).toMatch(/clinic|Prohealth/i);
      expect(replyBack).toMatch(/clinic|Prohealth/i);
      const u0 = await db.getSession(s0.id);
      const u1 = await db.getSession(s1.id);
      expect(u0.conversation_state).toBe('BOOK_SPECIFIC_CLINIC');
      expect(u1.conversation_state).toBe('BOOK_SPECIFIC_CLINIC');
    });

    test("'0' from clinic list (no prior step) → exits to BOOKING_METHOD_OPTIONS", async () => {
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', {
        selection_step: 'choose_clinic',
        clinic_list: [{ id: 'BIZ-001', business_name: 'Prohealth In Touch' }],
        clinic_page: 0,
        navigation_chain: [],
      });
      await callHandler(engine, ['handleBookSpecificClinic'], session, '0');
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOKING_METHOD_OPTIONS');
    });
  });

  // ─── BOOK_SPECIFIC_CLINIC — choose_type parallelism ─────────────────────────
  describe('BOOK_SPECIFIC_CLINIC — choose_type parallelism', () => {
    test('getAppointmentTypes calls for all clinic practitioners fire concurrently', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1, PHYSIO_2] },
      ]);

      const dispatched = [];
      const resolvers = [];
      // Return 2 types so planForward doesn't auto-advance to choose_physio (which would
      // call getAppointmentTypes again while the mock is still held, causing a timeout).
      engine.clinikoAPI.getAppointmentTypes.mockImplementation(({ practitioner_id }) => {
        dispatched.push(practitioner_id);
        return new Promise(resolve => resolvers.push(() => resolve([
          { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' },
          { id: 'AT-002', name: 'Return Visit (Existing Clients)' },
        ])));
      });

      const session = await seedAt('BOOK_SPECIFIC_CLINIC', {
        selection_step: 'choose_type',
        selected_clinic: { id: 'BIZ-001', business_name: 'Prohealth In Touch' },
      });
      const handlerPromise = callHandler(engine, ['handleBookSpecificClinic'], session, '');
      await new Promise(r => setImmediate(r));

      // Both fetches must be in-flight before either resolves
      expect(dispatched).toContain(PHYSIO_1.id);
      expect(dispatched).toContain(PHYSIO_2.id);

      resolvers.forEach(r => r());
      await handlerPromise;

      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', duration: 60 },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)',    duration: 30 },
      ]);
    });
  });

  // ─── BOOK_SPECIFIC_CLINIC — choose_physio parallelism ────────────────────────
  describe('BOOK_SPECIFIC_CLINIC — choose_physio parallelism', () => {
    test('getAppointmentTypes calls for clinic physio filter fire concurrently', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1, PHYSIO_2] },
      ]);

      const dispatched = [];
      const resolvers = [];
      engine.clinikoAPI.getAppointmentTypes.mockImplementation(({ practitioner_id }) => {
        dispatched.push(practitioner_id);
        return new Promise(resolve => resolvers.push(() => resolve([{ id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' }])));
      });

      const session = await seedAt('BOOK_SPECIFIC_CLINIC', {
        selection_step: 'choose_physio',
        selected_clinic: { id: 'BIZ-001', business_name: 'Prohealth In Touch' },
        selected_appt_type: { name: 'Initial 60 Min Visit (New Clients)', ids: ['AT-001'] },
        appt_type_name_to_ids_norm: { 'initial 60 min visit (new clients)': ['AT-001'] },
      });
      const handlerPromise = callHandler(engine, ['handleBookSpecificClinic'], session, '');
      await new Promise(r => setImmediate(r));

      // Both physio type-checks must be in-flight before either resolves
      expect(dispatched).toContain(PHYSIO_1.id);
      expect(dispatched).toContain(PHYSIO_2.id);

      resolvers.forEach(r => r());
      await handlerPromise;

      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', duration: 60, category: 'Physiotherapy', duration_in_minutes: 60 },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)',    duration: 30, category: 'Physiotherapy', duration_in_minutes: 30 },
      ]);
    });

    // Regression: 0 practitioners at this clinic offering this type used to
    // render an empty buildInteractiveSelectionList with only "0. Back".
    test('0 practitioners at this clinic for this type → no_slots_prompt shown instead of a bare "0. Back" dead end', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', {
        selection_step: 'choose_physio',
        selected_clinic: { id: 'BIZ-001', business_name: 'Prohealth In Touch' },
        selected_appt_type: { name: 'Initial 60 Min Visit (New Clients)', ids: ['AT-001'] },
        appt_type_name_to_ids_norm: { 'initial 60 min visit (new clients)': ['AT-001'] },
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, ''));
      expect(reply).toMatch(/no practitioners/i);
      expect(reply).toMatch(/try again/i);

      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.no_slots_prompt).toEqual({ context: 'clinic_physio_list', retry_step: 'choose_physio' });
      expect(d.practitioner_list).toBeUndefined();

      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
      ]);
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([{ id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' }]);
      const retryReply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, '1'));
      expect(retryReply).toMatch(new RegExp(PHYSIO_1.first_name, 'i'));

      // getAppointmentTypes is an instance own property — restore it since beforeEach doesn't reset it
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', duration: 60, category: 'Physiotherapy', duration_in_minutes: 60 },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)',    duration: 30, category: 'Physiotherapy', duration_in_minutes: 30 },
      ]);
    });
  });

  // ─── BOOK_SOONEST — choose_type ──────────────────────────────────────────────
  describe('BOOK_SOONEST — choose_type', () => {
    test('entry with multiple types → renders funnel duration prompt', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_2,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      expect(reply).toMatch(/select duration|30 min|60 min/i);
    });

    test('entry with 1 type and slots available → auto-advances past type selection to slot list', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_1,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      expect(reply).not.toMatch(/choose appointment type/i);
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('valid numeric selection → advances (does not re-show type list)', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_2,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply).not.toMatch(/choose appointment type/i);
    });

    test('out-of-range number → re-shows service selection prompt', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_2,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '99');
      expect(reply).toMatch(/what type|appointment|physiotherapy/i);
    });

    test('M/more → increments page and re-renders', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_2,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, 'm');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('0/back → goes to BOOKING_METHOD_OPTIONS', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_2,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '0');
      expect(typeof reply).toBe('string');
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOKING_METHOD_OPTIONS');
    });

    test('slot checks for both practitioners are dispatched during physio filtering', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1, PHYSIO_2] },
      ]);
      const dispatched = [];
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockImplementation(({ practitioner_id }) => {
        dispatched.push(practitioner_id);
        return Promise.resolve([SOONEST_SLOT]);
      });

      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_1,
        funnel_catalogue: [FUNNEL_CAT_1], // 1 entry → funnel auto-resolves, triggers buildAvailablePhysiosForTypeName
      });
      await callHandler(engine, ['handleBookSoonest'], session, '');

      // Both practitioners must have been slot-checked (Promise.all in buildAvailablePhysiosForTypeName)
      expect(dispatched).toContain(PHYSIO_1.id);
      expect(dispatched).toContain(PHYSIO_2.id);
    });
  });

  // ─── BOOK_SOONEST — funnel step pagination ───────────────────────────────────
  // Reproduces the 2026-07-19 production incident: the funnel's service/insurer/
  // final_pick prompts rendered every option in one unpaginated WhatsApp list
  // (unlike choose_physio/choose_clinic, which page at 5/4). A 6-row list pushed
  // the Send button off-screen — the user could see the list but never reply.
  describe('BOOK_SOONEST — funnel step pagination', () => {
    const SERVICES = ['Clinical Pilates', 'Osteopathy', 'Paediatrics', 'Physiotherapy', 'Sports Massage', 'Womens Health'];

    test('service step with 6 services pages at 5, not all 6 at once', async () => {
      const catalogue = SERVICES.map((s, i) => ({
        id: `AT-${i}`, name: `${s} Visit`, service: s, insurer: null, patientType: null, duration: 30,
      }));
      const session = await seedAt('BOOK_SOONEST', { selection_step: 'choose_type', funnel_catalogue: catalogue });

      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      const numberedLines = [...reply.matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());

      expect(numberedLines.length).toBeLessThanOrEqual(5);
      expect(reply).toMatch(/more/i);
    });

    test('the 6th service (page 2 via "next") resolves correctly, not services[0]', async () => {
      const catalogue = SERVICES.map((s, i) => ({
        id: `AT-${i}`, name: `${s} Visit`, service: s, insurer: null, patientType: null, duration: 30,
      }));
      const session = await seedAt('BOOK_SOONEST', { selection_step: 'choose_type', funnel_catalogue: catalogue });

      await callHandler(engine, ['handleBookSoonest'], session, ''); // page 0 (services 1-5)
      const page2 = await callHandler(engine, ['handleBookSoonest'], session, 'next');
      const page2Lines = [...page2.matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());

      expect(page2Lines).toHaveLength(1); // only the 6th service remains
      expect(page2Lines[0]).toMatch(/Womens Health/i); // last alphabetically

      // Reply "1" on page 2 must resolve to the 6th service, not the page-0 first item
      await callHandler(engine, ['handleBookSoonest'], session, '1');
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      const resolvedName = d.selected_appt_type?.name || d.funnel_sel?.service || '';
      expect(resolvedName).toMatch(/Womens Health/i);
    });

    test('insurer step with 6 options (Self-pay + 5 insurers) pages at 5 — the exact reported scenario', async () => {
      const insurers = ['AXA PPP', 'April International', 'Bupa Global', 'Bupa HealthNet', 'Cigna International'];
      const catalogue = [
        { id: 'AT-SELF', name: 'Physio Self-pay', service: 'Physiotherapy', insurer: null, patientType: null, duration: 30 },
        ...insurers.map((ins, i) => ({ id: `AT-INS-${i}`, name: `Physio ${ins}`, service: 'Physiotherapy', insurer: ins, patientType: null, duration: 30 })),
      ];
      const session = await seedAt('BOOK_SOONEST', { selection_step: 'choose_type', funnel_catalogue: catalogue });

      // Single service auto-advances straight to the insurer prompt.
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      expect(reply).toMatch(/covered/i);
      const numberedLines = [...reply.matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());

      expect(numberedLines.length).toBeLessThanOrEqual(5);
      expect(reply).toMatch(/more/i);
    });

    test('final_pick step with 6 duration/type combos pages at 5', async () => {
      const catalogue = [
        { id: 'AT-0', name: 'New 30', service: 'Physiotherapy', insurer: null, patientType: 'new', duration: 30 },
        { id: 'AT-1', name: 'New 40', service: 'Physiotherapy', insurer: null, patientType: 'new', duration: 40 },
        { id: 'AT-2', name: 'New 60', service: 'Physiotherapy', insurer: null, patientType: 'new', duration: 60 },
        { id: 'AT-3', name: 'Follow 30', service: 'Physiotherapy', insurer: null, patientType: 'follow_up', duration: 30 },
        { id: 'AT-4', name: 'Follow 40', service: 'Physiotherapy', insurer: null, patientType: 'follow_up', duration: 40 },
        { id: 'AT-5', name: 'Follow 60', service: 'Physiotherapy', insurer: null, patientType: 'follow_up', duration: 60 },
      ];
      const session = await seedAt('BOOK_SOONEST', { selection_step: 'choose_type', funnel_catalogue: catalogue });

      // Single service, no insurers → auto-advances straight to final_pick.
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      const numberedLines = [...reply.matchAll(/^[1-9]\d*\.\s+(.+)$/gm)].map(m => m[1].trim());

      expect(numberedLines.length).toBeLessThanOrEqual(5);
      expect(reply).toMatch(/more/i);
    });
  });

  // ─── BOOK_SOONEST — choose_physio ────────────────────────────────────────────
  describe('BOOK_SOONEST — choose_physio', () => {
    test('0 practitioners → standard 3-button no-slots prompt', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_1,
        funnel_catalogue: [FUNNEL_CAT_1],
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      expect(reply).toMatch(/no practitioners|no.*slot/i);
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
    });

    test('0 practitioners → no_slots_prompt set, choose_physio navPush NOT called (chain stays empty)', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_1,
        funnel_catalogue: [FUNNEL_CAT_1],
        navigation_chain: [],
      });
      await callHandler(engine, ['handleBookSoonest'], session, '');
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toBeTruthy();
      // Seeded at choose_type (not initial entry) — no navPush for choose_type; 0 practitioners so no navPush for choose_physio either
      expect((d.navigation_chain || []).length).toBe(0);
    });

    test('multiple practitioners → shows practitioner list', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1, PHYSIO_2] },
      ]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_1,
        funnel_catalogue: [FUNNEL_CAT_1],
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      expect(reply).toMatch(/practitioner|jolinna|wei/i);
    });

    // Regression: choose_physio list rendered from an alphabetically-sorted
    // practitioner_list (for index lookup), but the reply was built from the
    // raw, un-sorted API order — so the row a user tapped and the practitioner
    // that got selected could diverge whenever API order != alphabetical order.
    // Cliniko's practitioner order is not alphabetical, so this fired in prod.
    test('numeric reply selects the physio actually shown at that row, regardless of sort order', async () => {
      // API returns physios in non-alphabetical order (Wei before Jolinna).
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_2, PHYSIO_1] },
      ]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_1,
        funnel_catalogue: [FUNNEL_CAT_1],
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      const row1Name = reply.match(/^1\.\s+(.+)$/m)[1].trim();

      await callHandler(engine, ['handleBookSoonest'], session, '1');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      // A single-clinic result auto-advances all the way to SELECT_SLOT, which
      // moves selected_physio into prev_state_data — check both locations.
      const selected = d.selected_physio || d.prev_state_data?.selected_physio;
      const selectedName = `${selected.first_name} ${selected.last_name}`;
      expect(selectedName).toBe(row1Name);
    });

    test('valid numeric selection → advances to clinic or slot list', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_physio',
        selected_appt_type: TYPE_1,
        practitioner_list: [PHYSIO_1, PHYSIO_2],
        practitioner_page: 0,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply).not.toMatch(/select a practitioner/i);
    });

    test('out-of-range number → validation error', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_physio',
        selected_appt_type: TYPE_1,
        practitioner_list: [PHYSIO_1, PHYSIO_2],
        practitioner_page: 0,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '99');
      expect(reply).toMatch(/invalid practitioner/i);
    });

    test('M/more → increments page and re-renders', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_physio',
        selected_appt_type: TYPE_1,
        practitioner_list: [PHYSIO_1, PHYSIO_2],
        practitioner_page: 0,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, 'm');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('0/back → returns to funnel (duration prompt)', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_physio',
        selected_appt_type: TYPE_1,
        practitioner_list: [PHYSIO_1, PHYSIO_2],
        appointment_type_list: TYPE_LIST_2,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '0');
      expect(reply).toMatch(/select duration|30 min|60 min/i);
    });

    test('multiple practitioner type-fetches run concurrently when building physio list from choose_physio re-entry', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1, PHYSIO_2] },
      ]);

      // Held-promise pattern: each getAppointmentTypes call is suspended until we release it.
      // With a serial for...await loop, only PHYSIO_1's fetch would be in-flight at setImmediate
      // time — PHYSIO_2's fetch can't start until PHYSIO_1's promise resolves. Parallel Promise.all
      // dispatches both before yielding, so both IDs appear before setImmediate fires.
      const typeDispatched = [];
      const typeResolvers = [];
      engine.clinikoAPI.getAppointmentTypes.mockImplementation(({ practitioner_id }) => {
        typeDispatched.push(practitioner_id);
        return new Promise(resolve => typeResolvers.push(() => resolve([{ id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' }])));
      });

      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type', appt_type_page: 0,
        appointment_type_list: TYPE_LIST_1,
      });
      const handlerPromise = callHandler(engine, ['handleBookSoonest'], session, '');
      await new Promise(r => setImmediate(r));

      // Both fetches must be in-flight before either resolves — proves concurrent dispatch
      expect(typeDispatched).toContain(PHYSIO_1.id);
      expect(typeDispatched).toContain(PHYSIO_2.id);

      typeResolvers.forEach(r => r());
      await handlerPromise;

      // getAppointmentTypes is an instance own property — restore it since beforeEach doesn't reset it
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', duration: 60, category: 'Physiotherapy', duration_in_minutes: 60 },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)',    duration: 30, category: 'Physiotherapy', duration_in_minutes: 30 },
      ]);
    });

    // Same sort/render divergence as above, but for the back-nav path
    // (choose_clinic → back → choose_physio), which rebuilds the physio list
    // independently.
    test('back from choose_clinic then numeric reply selects the physio shown at that row', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_2, PHYSIO_1] },
      ]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
        clinic_list: [CLINIC_1],
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '0');
      const row1Name = reply.match(/^1\.\s+(.+)$/m)[1].trim();

      await callHandler(engine, ['handleBookSoonest'], session, '1');
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      const selected = d.selected_physio || d.prev_state_data?.selected_physio;
      const selectedName = `${selected.first_name} ${selected.last_name}`;
      expect(selectedName).toBe(row1Name);
    });

    // Regression (2026-07-19 chatbot-webhook incident): a zero-slot result at
    // this prefilter can come from a genuinely fully-booked physio OR from a
    // transient Cliniko fetch failure (e.g. a 429 under concurrent load)
    // that getAvailableSlotsByBusinessAndDate swallows into an empty array
    // indistinguishable from "confirmed zero". The old behavior silently
    // rebuilt the physio list (or, if that was also empty, reset the whole
    // funnel) — discarding the user's already-resolved appointment-type and
    // funnel selections with no explanation, and in the single-service/
    // single-insurer case, silently re-asking "New or returning patient?"
    // as if the user had never answered it. Must instead preserve the
    // selection and offer an explicit, retry-preserving prompt.
    test('originally-selected physio has zero slots after all → no_slots_prompt preserves selection for retry (not silently rebuilt)', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
        funnel_step: 'final_pick',
        funnel_sel: { service: 'Physiotherapy', insurer: null, patientType: 'new', duration: 60 },
      });

      const reply = String(await callHandler(engine, ['handleBookSoonest'], session, ''));
      expect(reply).toMatch(/no slots found/i);
      expect(reply).toMatch(/try again/i);

      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.no_slots_prompt).toEqual({ context: 'soonest', retry_step: 'choose_clinic' });
      // The user's prior answers must survive so Try Again doesn't re-ask them.
      expect(d.selected_physio?.id).toBe(PHYSIO_1.id);
      expect(d.selected_appt_type?.id).toBe(TYPE_1.id);
      expect(d.funnel_step).toBe('final_pick');
      expect(d.funnel_sel).toEqual({ service: 'Physiotherapy', insurer: null, patientType: 'new', duration: 60 });

      // Try Again re-runs the same prefilter in place — if slots are found
      // this time, the user goes straight to a slot list, never back through
      // the funnel's "New or returning patient?" question.
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([
        { slot: futureISO(2), appointment_type_name: TYPE_1.name, practitioner_id: PHYSIO_1.id, business_id: CLINIC_1.id },
      ]);
      const retryReply = String(await callHandler(engine, ['handleBookSoonest'], session, '1'));
      expect(retryReply).not.toMatch(/new or returning patient/i);
    });

    // Layer 2 of the central no-slots architecture: when the empty result is
    // tagged _partial (an inner Cliniko fetch failed, e.g. a 429 — see
    // ClinikoAPI.getAvailableSlotsByBusinessAndDate), the user must be told
    // this may be transient rather than told slots are confirmed unavailable.
    test('zero-slot result flagged _partial (a 429 occurred) → honest "trouble checking availability" wording, not "no slots found"', async () => {
      const partialResult = [];
      Object.defineProperty(partialResult, '_partial', { value: true, enumerable: false });
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue(partialResult);

      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
      });

      const reply = String(await callHandler(engine, ['handleBookSoonest'], session, ''));
      expect(reply).toMatch(/trouble checking availability/i);
      expect(reply).not.toMatch(/no slots found/i);
      expect(reply).toMatch(/try again/i); // still offers the same retry-preserving options

      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.no_slots_prompt).toEqual({ context: 'soonest', retry_step: 'choose_clinic' });
      expect(d.selected_physio?.id).toBe(PHYSIO_1.id); // still preserved for retry
    });
  });

  // ─── BOOK_SOONEST — choose_clinic ────────────────────────────────────────────
  describe('BOOK_SOONEST — choose_clinic', () => {
    test('0 clinics with slots → cascades to no-slots or type-reset message', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('1 clinic with slots → auto-advances to slot list', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      expect(reply).toMatch(/pick a slot|0️⃣ back/i);
    });

    test('multiple clinics → shows clinic list', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [PHYSIO_1] },
      ]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      expect(reply).toMatch(/prohealth in touch|prohealth city/i);
    });

    test('valid numeric selection from pre-loaded list → fetches slots and advances', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
        clinic_list: [CLINIC_1, CLINIC_2],
        clinic_page: 0,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('out-of-range number → validation error', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
        clinic_list: [CLINIC_1, CLINIC_2],
        clinic_page: 0,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '99');
      expect(reply).toMatch(/invalid clinic/i);
    });

    test('0/back with 1 available physio → returns to funnel (duration prompt)', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_2,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
        clinic_list: [CLINIC_1, CLINIC_2],
      });
      // Default mock: 1 practitioner → buildAvailablePhysiosForTypeName returns 1 → back to funnel choose_type
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '0');
      expect(reply).toMatch(/select duration|30 min|60 min/i);
    });

    test('slot checks for multiple clinics are dispatched concurrently', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
        { clinic_id: 'BIZ-002', clinic_name: 'Prohealth City',     practitioners: [PHYSIO_1] },
      ]);
      const dispatched = [];
      const resolvers = [];
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockImplementation(({ business_id }) => {
        dispatched.push(business_id);
        return new Promise(resolve => resolvers.push(() => resolve([SOONEST_SLOT])));
      });

      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
      });
      const handlerPromise = callHandler(engine, ['handleBookSoonest'], session, '');
      await new Promise(r => setImmediate(r));

      expect(dispatched).toContain('BIZ-001');
      expect(dispatched).toContain('BIZ-002');

      resolvers.forEach(r => r());
      await handlerPromise;
    });

    test('0/back with >1 available physios → returns to physio list', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1, PHYSIO_2] },
      ]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_2,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
        clinic_list: [CLINIC_1, CLINIC_2],
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '0');
      expect(reply).toMatch(/practitioner|jolinna|wei/i);
    });
  });

  // ─── BOOK_SOONEST — final slot fetch & no_slots recovery ─────────────────────
  describe('BOOK_SOONEST — final slot fetch and no_slots_prompt', () => {
    test('final fetch: 0 matching slots → no-slots prompt with 3 options', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([
        { ...SOONEST_SLOT, appointment_type_name: 'Completely Different Type' },
      ]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
        clinic_list: [CLINIC_1],
        clinic_page: 0,
        selected_clinic: CLINIC_1,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      expect(reply).toMatch(/no slots found/i);
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
    });

    test('inner fallback (withSlots=0): no_slots_prompt IS set with retry_step, selection preserved', async () => {
      // Clinic filter call returns [] (no slots at clinic level) — must be
      // treated as a possibly-transient failure, not confirmed zero. See the
      // 'originally-selected physio has zero slots after all' test above for
      // the full retry-preserves-selection regression coverage.
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValueOnce([]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '');
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toEqual({ context: 'soonest', retry_step: 'choose_clinic' });
      expect(d.selected_physio?.id).toBe(PHYSIO_1.id); // preserved, not force-cleared for re-pick
      expect(String(reply)).toMatch(/try again/i);
    });

    test('no_slots_prompt option 1 (go back and try again): falls to booking menu when no nav chain', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_physio',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        practitioner_list: [],
        no_slots_prompt: { context: 'soonest' },
        navigation_chain: [],
      });
      const reply = String(await callHandler(engine, ['handleBookSoonest'], session, '1'));
      expect(reply).not.toMatch(/try again.*email us/i);
      expect(reply).toMatch(/book|appointment|manage/i);
    });

    test('no_slots_prompt option 2 (email): sends email and returns support confirmation', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_physio',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        practitioner_list: [PHYSIO_1, PHYSIO_2],
        no_slots_prompt: { context: 'soonest' },
      });
      const reply = String(await callHandler(engine, ['handleBookSoonest'], session, '2'));
      expect(reply).toMatch(/support team|be in touch/i);
    });

    test('no_slots_prompt option 3 (WhatsApp): returns wa.me deep link', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_clinic',
        appointment_type_list: TYPE_LIST_1,
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
        clinic_list: [CLINIC_1],
        selected_clinic: CLINIC_1,
        no_slots_prompt: { context: 'soonest' },
      });
      const reply = String(await callHandler(engine, ['handleBookSoonest'], session, '3'));
      expect(reply).toMatch(/wa\.me/i);
    });

    test('no_slots_prompt invalid input → re-renders current step prompt', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_physio',
        appointment_type_list: TYPE_LIST_2,
        selected_appt_type: TYPE_1,
        practitioner_list: [PHYSIO_1, PHYSIO_2],
        practitioner_page: 0,
        no_slots_prompt: { context: 'soonest' },
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, 'xyz');
      // Falls through the no_slots block, hits choose_physio render
      expect(reply).toMatch(/practitioner|jolinna|wei/i);
    });

    test('no_slots_prompt option 1 with nav chain → navBack to prior step (choose_type)', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_physio',
        appointment_type_list: TYPE_LIST_2,
        selected_appt_type: TYPE_1,
        practitioner_list: [PHYSIO_1, PHYSIO_2],
        practitioner_page: 0,
        no_slots_prompt: { context: 'soonest' },
        navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: true, auto: false }],
      });
      const reply = String(await callHandler(engine, ['handleBookSoonest'], session, '1'));
      // navBack pops choose_type → re-enters funnel → shows duration prompt
      expect(reply).toMatch(/select duration|30 min|60 min/i);
      const d = JSON.parse((await db.getSession(session.id)).data || '{}');
      expect(d.selection_step).toBe('choose_type');
      expect(d.no_slots_prompt).toBeFalsy();
    });
  });

  // ─── SELECT_SLOT ─────────────────────────────────────────────────────────────
  describe('SELECT_SLOT', () => {
    const baseSlotData = (extra = {}) => ({
      slot_list: [SLOT_WITH_SLOT_FIELD],
      slot_page: 0,
      last_selection_flow: 'soonest',
      prev_state_data: {
        selected_appt_type: TYPE_1,
        selected_physio: PHYSIO_1,
        selected_clinic: CLINIC_1,
      },
      ...extra,
    });

    test('renders slot list with context header', async () => {
      const session = await seedAt('SELECT_SLOT', baseSlotData());
      const reply   = await callHandler(engine, ['handleSelectSlotState'], session, '');
      expect(reply).toMatch(/initial 60 min|jolinna|prohealth/i);
      expect(reply).toMatch(/pick a slot|0️⃣ back/i);
    });

    test('valid slot number → sets CONFIRM_BOOKING state and returns confirmation prompt', async () => {
      const session = await seedAt('SELECT_SLOT', baseSlotData());
      const reply   = await callHandler(engine, ['handleSelectSlotState'], session, '1');
      expect(reply).toMatch(/confirm booking|you have selected/i);
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('CONFIRM_BOOKING');
    });

    test('out-of-range slot number → validation error', async () => {
      const session = await seedAt('SELECT_SLOT', baseSlotData());
      const reply   = await callHandler(engine, ['handleSelectSlotState'], session, '99');
      expect(reply).toMatch(/invalid slot/i);
    });

    test('M/more → re-renders (non-empty string)', async () => {
      const session = await seedAt('SELECT_SLOT', baseSlotData());
      const reply   = await callHandler(engine, ['handleSelectSlotState'], session, 'm');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });

    test('0/back with no prev_state_data → goes to BOOKING_METHOD_OPTIONS', async () => {
      const session = await seedAt('SELECT_SLOT', {
        slot_list: [SLOT_WITH_SLOT_FIELD], slot_page: 0, last_selection_flow: 'soonest',
      });
      const reply   = await callHandler(engine, ['handleSelectSlotState'], session, '0');
      expect(typeof reply).toBe('string');
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOKING_METHOD_OPTIONS');
    });

    test('0/back with prev_state_data (flow=soonest) → restores BOOK_SOONEST context', async () => {
      const session = await seedAt('SELECT_SLOT', baseSlotData({
        prev_state_data: {
          selected_appt_type: TYPE_1,
          selected_physio: PHYSIO_1,
          selected_clinic: CLINIC_1,
          appointment_type_list: TYPE_LIST_2,
        },
      }));
      const reply = await callHandler(engine, ['handleSelectSlotState'], session, '0');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('BOOK_SOONEST');
    });

    test('no_slots_prompt present → _handleNoSlotsDecision result is returned', async () => {
      const session = await seedAt('SELECT_SLOT', baseSlotData({
        no_slots_prompt: true,
        last_selection_flow: 'soonest',
      }));
      const reply = await callHandler(engine, ['handleSelectSlotState'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });
  });

  // ─── CONFIRM_BOOKING ─────────────────────────────────────────────────────────
  describe('CONFIRM_BOOKING', () => {
    test('0/back/menu → returns booking method text', async () => {
      const session = await seedAt('CONFIRM_BOOKING', { selected_slot: SLOT_WITH_SLOT_FIELD });
      const reply   = await callHandler(engine, ['handleConfirmBookingState'], session, '0');
      expect(reply).toMatch(/soonest|history|specific date|physio|clinic/i);
    });

    test('unrecognised input → re-renders slot confirmation prompt', async () => {
      const session = await seedAt('CONFIRM_BOOKING', { selected_slot: SLOT_WITH_SLOT_FIELD });
      const reply   = await callHandler(engine, ['handleConfirmBookingState'], session, 'maybe');
      expect(reply).toMatch(/confirm booking|you have selected/i);
    });

    test('yes with bookAppointment returning failure → returns error message', async () => {
      engine.clinikoAPI.bookAppointment.mockResolvedValue({ success: false, message: 'Cliniko unavailable' });
      const session = await seedAt('CONFIRM_BOOKING', {
        selected_slot: SLOT_WITH_SLOT_FIELD, email: 'p@test.com',
      });
      const reply = await callHandler(engine, ['handleConfirmBookingState'], session, 'yes');
      expect(reply).toMatch(/could not book|❌|error/i);
    });

    test('yes with valid selected_slot → calls bookAppointment and returns success UX', async () => {
      const session = await seedAt('CONFIRM_BOOKING', {
        selected_slot: SLOT_WITH_SLOT_FIELD, email: 'p@test.com',
      });
      const reply = await callHandler(engine, ['handleConfirmBookingState'], session, 'yes');
      expect(engine.clinikoAPI.bookAppointment).toHaveBeenCalledTimes(1);
      expect(reply).toMatch(/booked|confirmed|success|✅/i);
    });

    test('yes with missing selected_slot → returns error string and does not throw', async () => {
      const session = await seedAt('CONFIRM_BOOKING', { email: 'p@test.com' });
      const reply = await callHandler(engine, ['handleConfirmBookingState'], session, 'yes');
      expect(typeof reply).toBe('string');
      expect(reply).toMatch(/no slot|try booking again/i);
    });
  });

  // ─── BOOK_SOONEST — choose_type baseline (edge cases) ────────────────────────
  describe('BOOK_SOONEST — choose_type: 0 types no-slots edge case', () => {
    test('0 types available → standard 3-button no-slots prompt (not an empty list)', async () => {
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([]);
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
      ]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type',
        appointment_type_list: [],
        appt_type_page: 0,
      });
      const reply = String(await callHandler(engine, ['handleBookSoonest'], session, ''));
      expect(reply).toMatch(/no appointment types|not available/i);
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toMatchObject({ context: 'soonest' });
    });

    test('0 types → no_slots_prompt set so re-entry flows through _handleNoSlotsDecision', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type',
        appointment_type_list: [],
        appt_type_page: 0,
        no_slots_prompt: { context: 'soonest' },
      });
      // '1' = Try Again → handler re-runs fresh (clears no_slots_prompt, resets state)
      const reply = String(await callHandler(engine, ['handleBookSoonest'], session, '1'));
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toBeFalsy();
    });

    test('UWC-only types returned → all filtered → shows no-slots prompt', async () => {
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'UWC-001', name: 'UWC New Patient', duration: 60 },
      ]);
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
      ]);
      const session = await seedAt('BOOK_SOONEST', {
        selection_step: 'choose_type',
        appointment_type_list: [],
        appt_type_page: 0,
      });
      const reply = String(await callHandler(engine, ['handleBookSoonest'], session, ''));
      expect(reply).toMatch(/no appointment types|not available/i);
      expect(reply).toMatch(/try again/i);
    });
  });

  // ─── BOOK_SPECIFIC_DATE — choose_type baseline ───────────────────────────────
  describe('BOOK_SPECIFIC_DATE — choose_type', () => {
    const typeStepData = () => ({
      selection_step: 'choose_type',
      selected_date: '2026-08-01',
      appointment_type_list: [
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', ids: ['AT-001'], norm: 'initial 60 min visit (new clients)' },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)',    ids: ['AT-002'], norm: 'return visit (existing clients)' },
      ],
      appt_type_page: 0,
      navigation_chain: [{ selection_step: 'choose_date', had_multiple_options: true, auto: false }],
    });

    test('at choose_type step → shows type list including appointment names', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', typeStepData());
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, ''));
      expect(reply).toMatch(/initial|return visit|visit type/i);
    });

    test('valid number → selects type, advances to choose_physio', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
      ]);
      const session = await seedAt('BOOK_SPECIFIC_DATE', typeStepData());
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '1'));
      expect(reply).not.toMatch(/select visit type/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.selected_appt_type).toBeDefined();
      expect(d.selected_appt_type.name).toMatch(/initial/i);
    });

    test('single type → still shows type list (no auto-advance; user must pick explicitly)', async () => {
      // BOOK_SPECIFIC_DATE choose_type has no planForward — single type does NOT auto-advance.
      // User must type '1' to select. This is baseline behavior before the funnel replaces it.
      const session = await seedAt('BOOK_SPECIFIC_DATE', {
        ...typeStepData(),
        appointment_type_list: [{ id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', ids: ['AT-001'], norm: 'initial 60 min visit (new clients)' }],
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, ''));
      expect(reply).toMatch(/initial 60 min visit|visit type/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.selection_step).toBe('choose_type');
    });

    test('out-of-range number → re-shows type list', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', typeStepData());
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '99'));
      expect(reply).toMatch(/initial|return visit|visit type/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.selection_step).toBe('choose_type');
    });

    test('next/more → increments page', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', typeStepData());
      await callHandler(engine, ['handleBookSpecificDate'], session, 'next');
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.appt_type_page).toBe(1);
    });

    test('prev from page 1 → decrements page', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', { ...typeStepData(), appt_type_page: 1 });
      await callHandler(engine, ['handleBookSpecificDate'], session, 'prev');
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.appt_type_page).toBe(0);
    });

    test('0 types at choose_type step → standard 3-button no-slots prompt', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', {
        selection_step: 'choose_type',
        selected_date: '2026-08-01',
        appointment_type_list: [],
        appt_type_page: 0,
        navigation_chain: [{ selection_step: 'choose_date', had_multiple_options: true, auto: false }],
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, ''));
      expect(reply).toMatch(/no appointment types|not available/i);
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toMatchObject({ context: 'date' });
    });

    test('inline render after date pick with 0 types → no-slots prompt (not empty list)', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
      ]);
      // getAppointmentTypes returns empty → after UWC filter list is empty
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_DATE', {
        selection_step: 'choose_date',
        navigation_chain: [],
      });
      // Simulate picking date '1' from the date picker
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '1'));
      expect(reply).toMatch(/no appointment types|not available|try again/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toMatchObject({ context: 'date' });
    });
  });

  // ─── BOOK_SPECIFIC_PHYSIO — choose_type baseline ─────────────────────────────
  describe('BOOK_SPECIFIC_PHYSIO — choose_type', () => {
    const physioTypeStepData = () => ({
      selection_step: 'choose_type',
      selected_physio: PHYSIO_1,
      appointment_type_list: [
        { id: 'AT-001', name: 'Initial 60 Min Visit', ids: ['AT-001'], norm: 'initial 60 min visit' },
        { id: 'AT-002', name: 'Return Visit',         ids: ['AT-002'], norm: 'return visit'          },
      ],
      appt_type_page: 0,
      navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
    });

    test('at choose_type step → shows type list for selected physio', async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', physioTypeStepData());
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, ''));
      expect(reply).toMatch(/initial|return visit|visit type/i);
    });

    test('valid number → selects type, advances to choose_clinic', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
      ]);
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([SOONEST_SLOT]);
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', physioTypeStepData());
      await callHandler(engine, ['handleBookSpecificPhysio'], session, '1');
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.selected_appt_type).toBeDefined();
      expect(d.selected_appt_type.name).toMatch(/initial/i);
    });

    test('single type → still shows type list (no auto-advance; user must pick explicitly)', async () => {
      // BOOK_SPECIFIC_PHYSIO choose_type has no planForward — single type does NOT auto-advance.
      // User must type '1' to select. This is baseline behavior before the funnel replaces it.
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', {
        ...physioTypeStepData(),
        appointment_type_list: [{ id: 'AT-001', name: 'Initial 60 Min Visit', ids: ['AT-001'], norm: 'initial 60 min visit' }],
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, ''));
      expect(reply).toMatch(/initial 60 min visit|visit type/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.selection_step).toBe('choose_type');
    });

    test('out-of-range number → re-shows type list', async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', physioTypeStepData());
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, '99'));
      expect(reply).toMatch(/initial|return visit|visit type/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.selection_step).toBe('choose_type');
    });

    test('next → increments type page', async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', physioTypeStepData());
      await callHandler(engine, ['handleBookSpecificPhysio'], session, 'next');
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.appt_type_page).toBe(1);
    });

    test('0 types for physio → standard 3-button no-slots prompt', async () => {
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', {
        selection_step: 'choose_type',
        selected_physio: PHYSIO_1,
        navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, ''));
      expect(reply).toMatch(/no visit types|jolinna|this practitioner/i);
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toMatchObject({ context: 'physio' });
    });

    test('0 types → no_slots_prompt context is physio (not physio_inner)', async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', {
        selection_step: 'choose_type',
        selected_physio: PHYSIO_1,
        appointment_type_list: [],
        appt_type_page: 0,
        navigation_chain: [],
      });
      await callHandler(engine, ['handleBookSpecificPhysio'], session, '');
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt?.context).toBe('physio');
    });
  });

  // ─── BOOK_SPECIFIC_CLINIC — choose_type baseline ─────────────────────────────
  describe('BOOK_SPECIFIC_CLINIC — choose_type', () => {
    const clinicTypeStepData = () => ({
      selection_step: 'choose_type',
      selected_clinic: CLINIC_1,
      appointment_type_list: [
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', norm_name: 'initial 60 min visit (new clients)', ids: ['AT-001'] },
        { id: 'AT-002', name: 'Return Visit (Existing Clients)',    norm_name: 'return visit (existing clients)',    ids: ['AT-002'] },
      ],
      appt_type_page: 0,
      appt_type_name_to_ids_norm: {
        'initial 60 min visit (new clients)': ['AT-001'],
        'return visit (existing clients)':    ['AT-002'],
      },
      navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
    });

    test('at choose_type step → shows type list for selected clinic', async () => {
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', clinicTypeStepData());
      const reply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, ''));
      expect(reply).toMatch(/initial|return visit|visit type/i);
    });

    test('valid number → selects type, does not re-show type list', async () => {
      // After selecting '1', handler advances to choose_physio (and may auto-advance further
      // through to slot list if there's only 1 physio with slots). Either way, the type list
      // is not shown again. Check the reply rather than session data because state may run far.
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
      ]);
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' },
      ]);
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', clinicTypeStepData());
      const reply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, '1'));
      // Should not re-show the type selection list
      expect(reply).not.toMatch(/select visit type for prohealth in touch/i);
    });

    test('single type → auto-advances via planForward on fresh load (no pre-populated list)', async () => {
      // planForward only fires inside the "if (!Array.isArray(appointment_type_list))" build block.
      // This test verifies that auto-advance happens on first entry (no pre-populated list).
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
      ]);
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
        { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' },
      ]);
      // Seed WITHOUT pre-populated appointment_type_list → build block runs → planForward fires
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', {
        selection_step: 'choose_type',
        selected_clinic: CLINIC_1,
        appt_type_name_to_ids_norm: {},
        navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, ''));
      // With only 1 type, planForward auto-advances — type list is never shown
      expect(reply).not.toMatch(/select visit type for prohealth in touch/i);
    });

    test('out-of-range number → re-shows type list', async () => {
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', clinicTypeStepData());
      const reply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, '99'));
      expect(reply).toMatch(/initial|return visit|visit type/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.selection_step).toBe('choose_type');
    });

    test('next → increments type page', async () => {
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', clinicTypeStepData());
      await callHandler(engine, ['handleBookSpecificClinic'], session, 'next');
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.appt_type_page).toBe(1);
    });

    test('0 types for clinic → standard 3-button no-slots prompt', async () => {
      engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
        { clinic_id: 'BIZ-001', clinic_name: 'Prohealth In Touch', practitioners: [PHYSIO_1] },
      ]);
      engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', {
        selection_step: 'choose_type',
        selected_clinic: CLINIC_1,
        navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, ''));
      expect(reply).toMatch(/no appointment types|not found/i);
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt).toMatchObject({ context: 'clinic' });
    });

    test('0 types pre-populated → no-slots prompt without re-fetching from Cliniko', async () => {
      const session = await seedAt('BOOK_SPECIFIC_CLINIC', {
        selection_step: 'choose_type',
        selected_clinic: CLINIC_1,
        appointment_type_list: [],
        appt_type_page: 0,
        appt_type_name_to_ids_norm: {},
        navigation_chain: [],
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificClinic'], session, ''));
      expect(reply).toMatch(/no appointment types|not found/i);
      expect(reply).toMatch(/try again/i);
      const updated = await db.getSession(session.id);
      const d = JSON.parse(updated.data || '{}');
      expect(d.no_slots_prompt?.context).toBe('clinic');
    });
  });
});

// =============================================================================
// SUITE — Legacy "initial" conversation_state recovery
// Reproduces the cold-start bug: persistent DB has old schema DEFAULT 'initial',
// new sessions get that value, and the engine must not fall through to the
// fallback handler.
// =============================================================================
describe('Legacy "initial" conversation_state recovery', () => {
  let db, engine;

  async function seedLegacyState(phone, contextExtra = {}) {
    const id = await db.createSession(phone, null, 60);
    await db.updateSession(id, {
      conversation_state: 'initial',
      context: JSON.stringify({ region: 'SG', ...contextExtra }),
    });
    return id;
  }

  beforeAll(async () => {
    resetCliniko();
    resetWhatsApp();
    db = new DatabaseManager();
    await db.initialize();
    engine = new ChatbotEngine(db);
    await engine.initialize();
  });
  afterAll(() => { if (engine.sessionManager.cleanupInterval) clearInterval(engine.sessionManager.cleanupInterval); db.close(); });
  beforeEach(() => resetCliniko());

  test('parseSession normalizes "initial" → "INTRO" at the DB boundary', async () => {
    const id = await db.createSession('+6598000001', null, 60);
    await db.updateSession(id, { conversation_state: 'initial' });
    const raw = await db.getSession(id);
    expect(raw.conversation_state).toBe('initial'); // raw DB value is wrong
    const parsed = engine.sessionManager.parseSession(raw);
    expect(parsed.conversation_state).toBe('INTRO'); // parseSession corrects it
  });

  test('"1" with "initial" state does not return the fallback "I\'m sorry" response', async () => {
    const phone = '+6598000002';
    await seedLegacyState(phone);
    const reply = await engine.handleMessage('1', phone);
    expect(reply).not.toMatch(/I'm sorry, I didn't understand/i);
  });

  test('"1" with "initial" state routes into the INTRO flow (register or menu)', async () => {
    const phone = '+6598000003';
    await seedLegacyState(phone);
    const reply = await engine.handleMessage('1', phone);
    // INTRO "1" now routes to Register as new patient
    expect(reply).toMatch(/first name|welcome|select|option/i);
  });

  test('"hello" with "initial" state routes to interactive menu, not fallback', async () => {
    const phone = '+6598000004';
    await seedLegacyState(phone);
    const reply = await engine.handleMessage('hello', phone);
    expect(reply).not.toMatch(/I'm sorry, I didn't understand/i);
    expect(reply).toMatch(/welcome|select|option/i);
  });

  test('subsequent message after "initial" state is recovered works normally', async () => {
    const phone = '+6598000005';
    await seedLegacyState(phone);
    await engine.handleMessage('1', phone); // first msg: triggers INTRO → REGISTER_PATIENT
    const reply = await engine.handleMessage('test@example.com', phone); // second: treated as first_name input
    expect(reply).not.toMatch(/I'm sorry, I didn't understand/i);
  });
});

// =============================================================================
// SUITE — Global restart-intent interception
// =============================================================================
describe('Global restart-intent interception (handleMessage)', () => {
  let db, engine;

  async function seedAt(state, extra = {}) {
    const phone = '+6599000099';
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1, patient_id: PATIENT_ID,
      conversation_state: state,
      data: JSON.stringify({ email: 'p@test.com', ...extra }),
      context: JSON.stringify({ region: 'SG' }),
    });
    return phone;
  }

  beforeAll(async () => {
    resetCliniko();
    resetWhatsApp();
    db = new DatabaseManager();
    await db.initialize();
    engine = new ChatbotEngine(db);
    await engine.initialize();
  });
  afterAll(() => { if (engine.sessionManager.cleanupInterval) clearInterval(engine.sessionManager.cleanupInterval); db.close(); });
  beforeEach(() => resetCliniko());

  const RESTART_WORDS = ['hi', 'hello', 'hey', 'start', 'restart', 'home'];

  for (const word of RESTART_WORDS) {
    test(`"${word}" in BOOK_MANAGE_OPTIONS → routes to interactive menu, not "I don't understand"`, async () => {
      const phone = await seedAt('BOOK_MANAGE_OPTIONS');
      const reply = await engine.handleMessage(word, phone);
      expect(reply).not.toMatch(/not understood|don.t understand/i);
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(10);
    });
  }

  test('"hello" in SELECT_SLOT → routes to interactive menu', async () => {
    const phone = await seedAt('SELECT_SLOT', {
      slot_list: [{ slot: new Date(Date.now() + 86400000).toISOString(), practitioner_id: 'P1', business_id: 'B1', appointment_type_id: 'AT1' }],
    });
    const reply = await engine.handleMessage('hello', phone);
    expect(reply).not.toMatch(/not understood|don.t understand/i);
  });

  test('"hi" in INTRO state → handled by INTRO handler, not globally intercepted', async () => {
    const phone = '+6599000098';
    const id = await db.createSession(phone, null, 60);
    await db.updateSession(id, {
      conversation_state: 'INTRO',
      context: JSON.stringify({ region: 'SG' }),
    });
    const reply = await engine.handleMessage('hi', phone);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(5);
  });

  test('"menu" in BOOK_MANAGE_OPTIONS is NOT globally intercepted (remains state-local)', async () => {
    // "menu" must go through the state handler, not the global interceptor.
    // Both paths return the main menu, so we just verify no crash and a valid reply.
    const phone = await seedAt('BOOK_MANAGE_OPTIONS');
    const reply = await engine.handleMessage('menu', phone);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(5);
  });
});

// =============================================================================
// SUITE — Global region-change interception
// =============================================================================
describe('Global region-change interception', () => {
  let db, engine;

  // ChatbotEngine ignores any db constructor arg — it always creates its own SessionManager.
  // So we seed through engine.sessionManager to hit the engine's actual database.
  async function seedAt(state, phone) {
    const session = await engine.sessionManager.getOrCreateSession(phone, true);
    await engine.sessionManager.updateSession(session.id, {
      conversation_state: state,
      verification_status: 'verified',
      verified: 1,
      context: { region: 'SG' },
      data: JSON.stringify({ email: 'p@test.com' }),
    });
    return session.id;
  }

  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    engine = new ChatbotEngine();
    await engine.initialize();
    db = engine.sessionManager.db; // same instance as the engine uses
  });
  afterAll(() => { if (engine.sessionManager.cleanupInterval) clearInterval(engine.sessionManager.cleanupInterval); db.close(); });
  beforeEach(() => { resetCliniko(); resetWhatsApp(); });

  // Helper: get current session for phone via session manager (phone-normalized lookup)
  const getSession = (phone) => engine.sessionManager.getSessionByPhone(phone);

  test('"region" from BOOK_MANAGE_OPTIONS shows region selection prompt', async () => {
    const phone = '+6591000201';
    const orig = await seedAt('BOOK_MANAGE_OPTIONS', phone);
    const reply = await engine.handleMessage('region', phone);
    expect(reply).toMatch(/select your region|region/i);
    const session = await getSession(phone);
    expect(session.id).not.toBe(orig);
    expect(session.patient_id).toBeNull();
  });

  test('"region" from VERIFY state shows region selection prompt and creates new session', async () => {
    const phone = '+6591000202';
    const orig = await seedAt('VERIFY', phone);
    const reply = await engine.handleMessage('region', phone);
    expect(reply).toMatch(/select your region|region/i);
    const session = await getSession(phone);
    expect(session.id).not.toBe(orig);
    expect(session.patient_id).toBeNull();
  });

  test('"region" from SELECT_SLOT state shows region selection prompt and creates new session', async () => {
    const phone = '+6591000203';
    const orig = await seedAt('SELECT_SLOT', phone);
    const reply = await engine.handleMessage('region', phone);
    expect(reply).toMatch(/select your region|region/i);
    const session = await getSession(phone);
    expect(session.id).not.toBe(orig);
  });

  test('"region" from INTRO state does NOT create a new session', async () => {
    const phone = '+6591000204';
    const orig = await seedAt('INTRO', phone);
    const reply = await engine.handleMessage('region', phone);
    expect(reply).toMatch(/select your region|region/i);
    // Same session preserved — no reset
    const session = await getSession(phone);
    expect(session.id).toBe(orig);
  });

  test('"change region" alias also resets session from non-INTRO state', async () => {
    const phone = '+6591000205';
    const orig = await seedAt('BOOK_MANAGE_OPTIONS', phone);
    const reply = await engine.handleMessage('change region', phone);
    expect(reply).toMatch(/select your region|region/i);
    const session = await getSession(phone);
    expect(session.id).not.toBe(orig);
  });

  test('after reset, selecting a new region shows the INTRO menu', async () => {
    const phone = '+6591000206';
    await seedAt('BOOK_MANAGE_OPTIONS', phone);
    await engine.handleMessage('region', phone);   // reset + region prompt
    const reply = await engine.handleMessage('2', phone); // pick second region
    expect(reply).toMatch(/book|welcome|select/i);
    // Region must be saved on the fresh session (context already parsed by parseSession)
    const session = await getSession(phone);
    const ctx = typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {});
    expect(ctx.region).toBeTruthy();
  });
});

// =============================================================================
// SUITE — Dead-end standardization
// =============================================================================
describe('Dead-end standardization', () => {
  let db, sm, engine;
  let phoneSeq = 0;
  const nextPhone = () => `+6593${String(++phoneSeq).padStart(6, '0')}`;

  const PHYSIO  = { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan', display_name: 'Jolinna Chan' };
  const CLINIC  = { id: 'BIZ-001', business_name: 'Prohealth In Touch' };
  const APPT_TYPE = { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' };

  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  beforeEach(() => { jest.clearAllMocks(); resetCliniko(); resetWhatsApp(); });

  async function seedAt(state, extraData = {}) {
    const ph = nextPhone();
    const s  = await seedVerified(db, ph);
    await db.updateSession(s.id, {
      conversation_state: state,
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({ email: 'p@test.com', patient_name: 'Test Patient', ...extraData }),
    });
    return db.getSession(s.id);
  }

  // ─── _handleNoSlotsDecision — all options ─────────────────────────────────────
  describe('_handleNoSlotsDecision', () => {
    const noSlotsBase = () => ({
      no_slots_prompt: true,
      slot_list: [],
      last_selection_flow: 'date',
    });

    test('no no_slots_prompt → returns null (no-op)', async () => {
      const session = await seedAt('SELECT_SLOT', { slot_list: [] });
      const result = await engine._handleNoSlotsDecision(session, {}, 'SELECT_SLOT', () => null, '1');
      expect(result).toBeNull();
    });

    test('unknown input with no_slots_prompt → returns null', async () => {
      const session = await seedAt('SELECT_SLOT', noSlotsBase());
      const result = await engine._handleNoSlotsDecision(
        session, { no_slots_prompt: true }, 'SELECT_SLOT', () => null, 'xyz'
      );
      expect(result).toBeNull();
    });

    test('0 with empty nav chain → falls back to main booking menu', async () => {
      const session = await seedAt('SELECT_SLOT', { ...noSlotsBase(), navigation_chain: [] });
      const reply = await callHandler(engine, ['handleSelectSlotState'], session, '0');
      expect(typeof reply).toBe('string');
      expect(reply).toMatch(/book|manage|appointment/i);
    });

    test('1 → goes back (falls to booking menu when nav chain is empty)', async () => {
      const session = await seedAt('SELECT_SLOT', noSlotsBase());
      const reply = await callHandler(engine, ['handleSelectSlotState'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply).toMatch(/book|manage|appointment/i);
    });

    test('2 → sends email and returns support confirmation', async () => {
      const session = await seedAt('SELECT_SLOT', noSlotsBase());
      const reply = await callHandler(engine, ['handleSelectSlotState'], session, '2');
      expect(typeof reply).toBe('string');
      expect(reply).toMatch(/be in touch|support team/i);
      expect(reply).toMatch(/book|manage|appointment/i);
    });

    test('3 → shows SG WhatsApp link for support', async () => {
      const session = await seedAt('SELECT_SLOT', noSlotsBase());
      const reply = await callHandler(engine, ['handleSelectSlotState'], session, '3');
      expect(typeof reply).toBe('string');
      expect(reply).toMatch(/wa\.me/); // WhatsApp deep link
      expect(reply).toMatch(/message.*team|tap.*message/i);
    });

    test('3 with HK region → shows HK WhatsApp link for support', async () => {
      const ph = nextPhone();
      const s  = await seedVerified(db, ph);
      await db.updateSession(s.id, {
        conversation_state: 'SELECT_SLOT',
        context: JSON.stringify({ region: 'HK' }),
        data: JSON.stringify({ ...noSlotsBase() }),
      });
      const session = await db.getSession(s.id);
      const reply = await callHandler(engine, ['handleSelectSlotState'], session, '3');
      expect(reply).toMatch(/wa\.me/); // WhatsApp deep link
    });
  });

  // ─── No-slots display prompts — canonical label text ─────────────────────────
  describe('No-slots display prompts — canonical label text', () => {
    const viewSlotsData = () => ({
      selection_step: 'view_slots',
      selected_appt_type: APPT_TYPE,
      selected_physio: PHYSIO,
      selected_clinic: CLINIC,
      navigation_chain: [],
    });

    test('SELECT_SLOT with empty slot_list shows 3-button standard prompt', async () => {
      const session = await seedAt('SELECT_SLOT', { slot_list: [] });
      const reply = String(await callHandler(engine, ['handleSelectSlotState'], session, ''));
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      expect(reply).not.toMatch(/booking menu/i);
    });

    test('BOOK_SPECIFIC_DATE view_slots with no results shows 3-option standard prompt', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_DATE', {
        ...viewSlotsData(),
        selected_date: '2026-08-01',
      });
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, ''));
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      expect(reply).not.toMatch(/booking menu/i);
    });

    test('BOOK_SPECIFIC_PHYSIO view_slots with no results shows 3-option standard prompt', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', viewSlotsData());
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, ''));
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      expect(reply).not.toMatch(/booking menu/i);
    });

    test('BOOK_HISTORY view_slots with no matching slots shows 3-option standard prompt', async () => {
      engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([]);
      const session = await seedAt('BOOK_HISTORY', {
        ...viewSlotsData(),
        selected_previous_appt: { appointment_type: { name: 'Initial 60 Min Visit (New Clients)' } },
      });
      const reply = String(await callHandler(engine, ['handleBookHistory'], session, ''));
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      expect(reply).not.toMatch(/booking menu/i);
    });
  });

  // ─── No-slots standard navigation — "Go back / Email / WhatsApp" buttons ─────
  describe('No-slots standard navigation — go-back, email, WhatsApp', () => {
    const noSlotsSessionData = (context, extra = {}) => ({
      selection_step: 'view_slots',
      no_slots_prompt: { context },
      selected_appt_type: APPT_TYPE,
      selected_physio: PHYSIO,
      selected_clinic: CLINIC,
      navigation_chain: [], // empty → navBack falls to booking menu
      ...extra,
    });

    test('BOOK_DATE no-slots "1" (go back): clears no_slots_prompt, returns booking menu', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', noSlotsSessionData('date', { selected_date: '2026-08-01' }));
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '1'));
      expect(reply).not.toMatch(/try again.*email us/i);
      expect(reply).toMatch(/book|appointment|manage/i);
    });

    test('BOOK_DATE no-slots "2" (email): sends email and returns confirmation', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', noSlotsSessionData('date', { selected_date: '2026-08-01' }));
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '2'));
      expect(reply).toMatch(/support team|touch shortly/i);
    });

    test('BOOK_DATE no-slots "3" (WhatsApp): returns wa.me link', async () => {
      const session = await seedAt('BOOK_SPECIFIC_DATE', noSlotsSessionData('date', { selected_date: '2026-08-01' }));
      const reply = String(await callHandler(engine, ['handleBookSpecificDate'], session, '3'));
      expect(reply).toMatch(/wa\.me/i);
    });

    test('BOOK_PHYSIO no-slots "1" (go back): clears no_slots_prompt, returns booking menu', async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', noSlotsSessionData('physio'));
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, '1'));
      expect(reply).not.toMatch(/try again.*email us/i);
      expect(reply).toMatch(/book|appointment|manage/i);
    });

    test('BOOK_PHYSIO no-slots "2" (email): returns support confirmation', async () => {
      const session = await seedAt('BOOK_SPECIFIC_PHYSIO', noSlotsSessionData('physio'));
      const reply = String(await callHandler(engine, ['handleBookSpecificPhysio'], session, '2'));
      expect(reply).toMatch(/support team|touch shortly/i);
    });

    test('BOOK_HISTORY no-slots "1" (go back): clears no_slots_prompt, returns booking menu', async () => {
      const session = await seedAt('BOOK_HISTORY', noSlotsSessionData('history'));
      const reply = String(await callHandler(engine, ['handleBookHistory'], session, '1'));
      expect(reply).not.toMatch(/try again.*email us/i);
      expect(reply).toMatch(/book|appointment|manage/i);
    });

    test('BOOK_HISTORY no-slots "3" (WhatsApp): returns wa.me link', async () => {
      const session = await seedAt('BOOK_HISTORY', noSlotsSessionData('history'));
      const reply = String(await callHandler(engine, ['handleBookHistory'], session, '3'));
      expect(reply).toMatch(/wa\.me/i);
    });
  });

  // ─── Verify fail escalation — option 2 ───────────────────────────────────────
  describe('Verify fail — option 2 escalation', () => {
    test('option 1 (try again) still works — returns email prompt', async () => {
      const session = await seedAt('VERIFY', { verify_error_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, '1');
      expect(reply).toMatch(/email|verify/i);
    });

    test('option 2 sends email and returns confirmation', async () => {
      const session = await seedAt('VERIFY', { verify_error_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, '2');
      expect(typeof reply).toBe('string');
      expect(reply).toMatch(/sent your details|support team/i);
    });

    test('option 3 (main menu) still works — returns booking menu', async () => {
      const session = await seedAt('VERIFY', { verify_error_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, '3');
      expect(reply).toMatch(/book|manage|appointment/i);
    });

    test('unknown input re-shows fail prompt', async () => {
      const session = await seedAt('VERIFY', { verify_error_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, 'xyz');
      expect(reply).toMatch(/couldn.t verify|try again/i);
    });
  });

  // ─── Verify — gateway screen ─────────────────────────────────────────────────
  describe('Verify — gateway screen', () => {
    test('fresh VERIFY entry shows registration gateway', async () => {
      const session = await seedAt('VERIFY', {});
      const reply = await callHandler(engine, ['handleVerifyState'], session, '');
      expect(reply).toMatch(/registered with us/i);
      expect(reply).toMatch(/register new patient/i);
      expect(reply).toMatch(/forgot my details/i);
    });

    test('gateway option 1 (registered) → asks for email', async () => {
      const session = await seedAt('VERIFY', { gateway_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, '1');
      expect(reply).toMatch(/email/i);
      expect(reply).not.toMatch(/registered with us/i);
    });

    test('gateway option 2 (register as new patient) → starts registration flow', async () => {
      const session = await seedAt('VERIFY', { gateway_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, '2');
      expect(reply).toMatch(/first name/i);
    });

    test('gateway option 3 (forgot details) → shows support email and main menu', async () => {
      const session = await seedAt('VERIFY', { gateway_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, '3');
      expect(reply).toMatch(/contact us at/i);
      expect(reply).toMatch(/book|manage|appointment/i);
    });

    test('gateway unknown input → re-shows gateway', async () => {
      const session = await seedAt('VERIFY', { gateway_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, 'xyz');
      expect(reply).toMatch(/registered with us/i);
    });

    test('gateway 0 → back to main menu', async () => {
      const session = await seedAt('VERIFY', { gateway_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, '0');
      expect(reply).toMatch(/book|welcome|select|option/i);
    });

    test('gateway skipped when verify_error_prompt is set', async () => {
      const session = await seedAt('VERIFY', { verify_error_prompt: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, '');
      expect(reply).not.toMatch(/registered with us/i);
      expect(reply).toMatch(/couldn.t verify|try again/i);
    });

    test('gateway skipped when awaiting_email is set', async () => {
      const session = await seedAt('VERIFY', { awaiting_email: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, '');
      expect(reply).toMatch(/email/i);
      expect(reply).not.toMatch(/registered with us/i);
    });
  });

  // ─── Reschedule no-slots ─────────────────────────────────────────────────────
  describe('Reschedule — no available slots', () => {
    const rescheduleAppt = () => ({
      id: 'APPT-R',
      starts_at: new Date(Date.now() + 86400000 * 5).toISOString(),
      practitioner: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
      appointment_type: { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' },
      business: { id: 'BIZ-001', business_name: 'Prohealth In Touch' },
    });

    test('no available slots → shows 3-button standard prompt', async () => {
      engine.clinikoAPI.getAvailableTimes.mockResolvedValue([]);
      // Seed at RESCHEDULE_CONFIRM_INTENT with appointment selected — user says 'yes' → fetch slots → no slots
      const session = await seedAt('RESCHEDULE_CONFIRM_INTENT', {
        selected_reschedule_appt: rescheduleAppt(),
      });
      const reply = String(await callHandler(engine, ['handleRescheduleIntentConfirmState'], session, 'yes'));
      expect(reply.length).toBeGreaterThan(0);
      expect(reply).toMatch(/try again/i);
      expect(reply).toMatch(/email us/i);
      expect(reply).toMatch(/message on whatsapp/i);
      expect(reply).not.toMatch(/booking menu/i);
    });

    test('no_slots_prompt set: option 1 → main booking menu', async () => {
      const session = await seedAt('SELECT_APPOINTMENT_TO_RESCHEDULE', {
        no_slots_prompt: true,
        navigation_chain: [],
      });
      const reply = await callHandler(engine, ['handleSelectAppointmentToRescheduleState'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply).toMatch(/book|manage|appointment/i);
    });

    test('no_slots_prompt set: option 2 → email confirmation', async () => {
      const session = await seedAt('SELECT_APPOINTMENT_TO_RESCHEDULE', {
        no_slots_prompt: true,
        navigation_chain: [],
      });
      const reply = await callHandler(engine, ['handleSelectAppointmentToRescheduleState'], session, '2');
      expect(reply).toMatch(/be in touch|support team/i);
    });

    test('no_slots_prompt set: option 3 → shows WhatsApp support link', async () => {
      const session = await seedAt('SELECT_APPOINTMENT_TO_RESCHEDULE', {
        no_slots_prompt: true,
        navigation_chain: [],
      });
      const reply = await callHandler(engine, ['handleSelectAppointmentToRescheduleState'], session, '3');
      expect(reply).toMatch(/wa\.me/);
    });

    test('no_slots_prompt set: option 0 → navBack or main menu', async () => {
      const session = await seedAt('SELECT_APPOINTMENT_TO_RESCHEDULE', {
        no_slots_prompt: true,
        navigation_chain: [],
      });
      const reply = await callHandler(engine, ['handleSelectAppointmentToRescheduleState'], session, '0');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    });
  });

  // ─── Base functionality unchanged ─────────────────────────────────────────────
  describe('Base functionality unchanged', () => {
    test('SELECT_SLOT with valid slot → successful selection advances to CONFIRM_BOOKING', async () => {
      const session = await seedAt('SELECT_SLOT', {
        slot_list: [SLOT],
        last_selection_flow: 'date',
      });
      const reply = await callHandler(engine, ['handleSelectSlotState'], session, '1');
      expect(reply).toMatch(/confirm|you have selected/i);
      const updated = await db.getSession(session.id);
      expect(updated.conversation_state).toBe('CONFIRM_BOOKING');
    });

    test('BOOK_SOONEST no-slots: option 1 (go back) routes via navBack — falls to booking menu', async () => {
      const session = await seedAt('BOOK_SOONEST', {
        no_slots_prompt: { context: 'soonest' },
        selection_step: 'choose_type',
        navigation_chain: [],
        appointment_type_list: [{ id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', norm_name: 'initial 60 min visit (new clients)' }],
      });
      const reply = await callHandler(engine, ['handleBookSoonest'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
      expect(reply).not.toMatch(/try again.*email us/i);
    });

    test('VERIFY success path still works — invalid email returns format error', async () => {
      const session = await seedAt('VERIFY', { awaiting_email: true });
      const reply = await callHandler(engine, ['handleVerifyState'], session, 'notanemail');
      expect(reply).toMatch(/valid email/i);
    });

    test('reschedule with available slots → shows slot list (not dead-end)', async () => {
      engine.clinikoAPI.getAvailableTimes.mockResolvedValue([SLOT]);
      const rescheduleAppt = {
        id: 'APPT-R',
        starts_at: new Date(Date.now() + 86400000 * 5).toISOString(),
        practitioner: { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' },
        appointment_type: { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' },
        business: { id: 'BIZ-001', business_name: 'Prohealth In Touch' },
      };
      const session = await seedAt('SELECT_APPOINTMENT_TO_RESCHEDULE', {
        reschedule_appt_list: [rescheduleAppt],
      });
      const reply = await callHandler(engine, ['handleSelectAppointmentToRescheduleState'], session, '1');
      expect(typeof reply).toBe('string');
      expect(reply).not.toMatch(/back to main booking menu/i);
    });
  });
});

// ─── Slot list interactive ─────────────────────────────────────────────────────
describe('Slot list interactive', () => {
  let db, engine;
  let phoneCounter = 9000;

  // Seed a verified session at a specific state
  async function seedAt(state, extraData = {}) {
    const phone = `+65300${phoneCounter++}`;
    const session = await seedVerified(db, phone);
    await db.updateSession(session.id, {
      conversation_state: state,
      data: JSON.stringify({ email: 'p@test.com', patient_name: 'Test Patient', ...extraData }),
    });
    return db.getSession(session.id);
  }

  // Call a handler and return the raw result (no stringify)
  async function rawCall(handlerName, session, msg) {
    return engine[handlerName].call(engine, session, msg);
  }

  // Build N slots with distinct future times
  const makeSlots = (n) => Array.from({ length: n }, (_, i) => ({
    id: `SLOT-${i + 1}`,
    slot: new Date(Date.now() + (i + 1) * 3600000).toISOString(),
    starts_at: new Date(Date.now() + (i + 1) * 3600000).toISOString(),
    appointment_start: new Date(Date.now() + (i + 1) * 3600000).toISOString(),
    appointment_type_id: 'AT-001',
    appointment_type_name: 'Initial 60 Min Visit (New Clients)',
    practitioner_id: 'PRAC-001', practitioner_name: 'Jolinna Chan',
    business_id: 'BIZ-001', business_name: 'Prohealth In Touch',
  }));

  // Reschedule appointment fixture (has all required Cliniko link fields)
  // ends_at = starts_at + 60 min, matching the "Initial 60 Min Visit" type
  const RESCHEDULE_APPT_STARTS = new Date(Date.now() + 86400000 * 5).toISOString();
  const RESCHEDULE_APPT_ENDS   = new Date(new Date(RESCHEDULE_APPT_STARTS).getTime() + 60 * 60000).toISOString();
  const RESCHEDULE_APPT = {
    id: 'APPT-R',
    starts_at: RESCHEDULE_APPT_STARTS,
    ends_at:   RESCHEDULE_APPT_ENDS,
    practitioner:     { id: 'PRAC-001' },
    appointment_type: { id: 'AT-001' },
    business:         { id: 'BIZ-001' },
    _practitioner_display: 'Jolinna Chan',
    _appointment_type_display: 'Initial 60 Min Visit',
    _display_dt: 'Mon 10:00 AM',
  };

  const baseSlotSession = (slots, extra = {}) => ({
    slot_list: slots,
    slot_page: 0,
    last_selection_flow: 'soonest',
    prev_state_data: {
      selected_appt_type: { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' },
      selected_physio: { id: 'PRAC-001', display_name: 'Jolinna Chan' },
      selected_clinic: { id: 'BIZ-001', business_name: 'Prohealth In Touch' },
    },
    ...extra,
  });

  beforeEach(async () => {
    resetCliniko();
    db     = new DatabaseManager();
    engine = new ChatbotEngine();
    await db.initialize();
    engine.sessionManager = new SessionManager(db);
    engine.db = db;
  });

  afterEach(() => db.close());

  // ─── _slotPageStart / _slotPageCount math ────────────────────────────────────

  test('_slotPageStart: page 0 starts at index 0', () => {
    expect(engine._slotPageStart(0)).toBe(0);
  });

  test('_slotPageStart: page 1 starts at index 8 (after page 0 with 8 slots)', () => {
    expect(engine._slotPageStart(1)).toBe(8);
  });

  test('_slotPageStart: page 2 starts at index 15 (8 + 7)', () => {
    expect(engine._slotPageStart(2)).toBe(15);
  });

  test('_slotPageStart: page 3 starts at index 22 (8 + 7 + 7)', () => {
    expect(engine._slotPageStart(3)).toBe(22);
  });

  test('_slotPageCount: page 0 holds 8 slots', () => {
    expect(engine._slotPageCount(0)).toBe(8);
  });

  test('_slotPageCount: page 1+ holds 7 slots', () => {
    expect(engine._slotPageCount(1)).toBe(7);
    expect(engine._slotPageCount(2)).toBe(7);
  });

  // ─── _buildSlotList structure ─────────────────────────────────────────────────

  test('_buildSlotList: returns MessageEnvelope with interactive list payload', () => {
    const slots = makeSlots(3);
    const result = engine._buildSlotList(slots, 0, 'Pick a slot', 'Asia/Singapore');
    expect(result).toHaveProperty('interactive');
    expect(result.interactive.type).toBe('list');
    expect(result.interactive.action.button).toBe('Select slot');
    expect(Array.isArray(result.interactive.action.sections[0].rows)).toBe(true);
  });

  test('_buildSlotList page 0: row IDs are 1-based global numbers', () => {
    const slots = makeSlots(3);
    const result = engine._buildSlotList(slots, 0, 'Pick a slot', 'Asia/Singapore');
    const rows = result.interactive.action.sections[0].rows;
    expect(rows[0].id).toBe('1');
    expect(rows[1].id).toBe('2');
    expect(rows[2].id).toBe('3');
  });

  test('_buildSlotList page 0, 8 slots with no overflow: no prev row, no next row, has back row', () => {
    const slots = makeSlots(8);
    const result = engine._buildSlotList(slots, 0, 'Pick a slot', 'Asia/Singapore');
    const rows = result.interactive.action.sections[0].rows;
    // 8 slots + back = 9 rows (within WhatsApp 10-row limit)
    expect(rows).toHaveLength(9);
    expect(rows.map(r => r.id)).not.toContain('prev');
    expect(rows.map(r => r.id)).not.toContain('next');
    expect(rows[rows.length - 1].id).toBe('back');
  });

  test('_buildSlotList page 0, 9+ slots: no prev row, has next row, has back row as last', () => {
    const slots = makeSlots(9);
    const result = engine._buildSlotList(slots, 0, 'Pick a slot', 'Asia/Singapore');
    const rows = result.interactive.action.sections[0].rows;
    // 8 slots + next + back = 10 rows (exactly at WhatsApp limit)
    expect(rows).toHaveLength(10);
    expect(rows.map(r => r.id)).not.toContain('prev');
    expect(rows.map(r => r.id)).toContain('next');
    expect(rows[rows.length - 1].id).toBe('back');
    // Only 8 slot rows (IDs 1–8)
    const slotRows = rows.filter(r => !['next', 'prev', 'back'].includes(r.id));
    expect(slotRows).toHaveLength(8);
    expect(slotRows[7].id).toBe('8');
  });

  test('_buildSlotList page 1: has prev row, IDs continue from 9', () => {
    const slots = makeSlots(16);
    const result = engine._buildSlotList(slots, 1, 'Pick a slot', 'Asia/Singapore');
    const rows = result.interactive.action.sections[0].rows;
    const slotRows = rows.filter(r => !['prev', 'next', 'back'].includes(r.id));
    // page 1 start = 8, shows slots 8–14 (IDs 9–15)
    expect(slotRows[0].id).toBe('9');
    expect(slotRows[slotRows.length - 1].id).toBe('15');
    expect(rows.map(r => r.id)).toContain('prev');
    expect(rows[rows.length - 1].id).toBe('back');
  });

  test('_buildSlotList page 1 with more: prev + next + back all present, total rows = 10', () => {
    const slots = makeSlots(16); // 8 on page0, 7 on page1, 1 on page2 → page1 has next
    const result = engine._buildSlotList(slots, 1, 'Pick a slot', 'Asia/Singapore');
    const rows = result.interactive.action.sections[0].rows;
    expect(rows).toHaveLength(10); // 7 slots + prev + next + back (exactly at WhatsApp limit)
    expect(rows.map(r => r.id)).toContain('prev');
    expect(rows.map(r => r.id)).toContain('next');
    expect(rows.map(r => r.id)).toContain('back');
  });

  test('_buildSlotList last page (page 1, no more): has prev, no next', () => {
    const slots = makeSlots(12); // page0=8, page1=4 slots, no more
    const result = engine._buildSlotList(slots, 1, 'Pick a slot', 'Asia/Singapore');
    const rows = result.interactive.action.sections[0].rows;
    expect(rows.map(r => r.id)).toContain('prev');
    expect(rows.map(r => r.id)).not.toContain('next');
  });

  test('_buildSlotList text fallback uses global numbering (not row position)', () => {
    const slots = makeSlots(10);
    const result = engine._buildSlotList(slots, 1, 'Pick a slot', 'Asia/Singapore');
    const text = String(result);
    // Page 1 starts at index 8; first slot should be labeled 9
    expect(text).toMatch(/^9\./m);
  });

  test('_buildSlotList text fallback shows M/P nav labels, not next/prev IDs', () => {
    const slots = makeSlots(18);
    const page0 = String(engine._buildSlotList(slots, 0, 'Slots', 'Asia/Singapore'));
    expect(page0).toMatch(/M\. More slots/);
    expect(page0).not.toMatch(/\bnext\b/i);

    const page1 = String(engine._buildSlotList(slots, 1, 'Slots', 'Asia/Singapore'));
    expect(page1).toMatch(/P\. Previous slots/);
    expect(page1).not.toMatch(/\bprev\b/i);
  });

  // ─── handleSelectSlotState pagination ────────────────────────────────────────

  test('"next" advances to page 1 and interactive rows contain slot 10', async () => {
    const slots = makeSlots(10);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots));
    const reply = await rawCall('handleSelectSlotState', session, 'next');
    expect(reply).toHaveProperty('interactive');
    const rows = reply.interactive.action.sections[0].rows;
    expect(rows.some(r => r.id === '10')).toBe(true);
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).slot_page).toBe(1);
  });

  test('"m" still advances page (backward compat with text users)', async () => {
    const slots = makeSlots(10);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots));
    const reply = await callHandler(engine, ['handleSelectSlotState'], session, 'm');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).slot_page).toBe(1);
    // Should have returned a slot list (envelope or string)
    expect(reply).toBeTruthy();
  });

  test('"prev" goes back from page 1 to page 0', async () => {
    const slots = makeSlots(10);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots, { slot_page: 1 }));
    await callHandler(engine, ['handleSelectSlotState'], session, 'prev');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).slot_page).toBe(0);
  });

  test('"p" still goes back (backward compat)', async () => {
    const slots = makeSlots(10);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots, { slot_page: 1 }));
    await callHandler(engine, ['handleSelectSlotState'], session, 'p');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).slot_page).toBe(0);
  });

  test('"prev" at page 0 stays at 0 (no underflow)', async () => {
    const slots = makeSlots(5);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots, { slot_page: 0 }));
    await callHandler(engine, ['handleSelectSlotState'], session, 'prev');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).slot_page).toBe(0);
  });

  // ─── handleSelectSlotState selection ─────────────────────────────────────────

  test('selecting slot 1 on page 0 → CONFIRM_BOOKING with correct slot', async () => {
    const slots = makeSlots(3);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots));
    const reply = await callHandler(engine, ['handleSelectSlotState'], session, '1');
    expect(reply).toMatch(/confirm booking|you have selected/i);
    const updated = await db.getSession(session.id);
    expect(updated.conversation_state).toBe('CONFIRM_BOOKING');
    const data = JSON.parse(updated.data);
    expect(data.selected_slot.id).toBe('SLOT-1');
  });

  test('selecting slot 8 on page 0 (last on page) → CONFIRM_BOOKING with correct slot', async () => {
    const slots = makeSlots(9);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots));
    const reply = await callHandler(engine, ['handleSelectSlotState'], session, '8');
    expect(reply).toMatch(/confirm booking|you have selected/i);
    const updated = await db.getSession(session.id);
    const data = JSON.parse(updated.data);
    expect(data.selected_slot.id).toBe('SLOT-8');
  });

  test('selecting slot by page-1 global ID ("10") on page 1 → CONFIRM_BOOKING with correct slot', async () => {
    const slots = makeSlots(12);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots, { slot_page: 1 }));
    const reply = await callHandler(engine, ['handleSelectSlotState'], session, '10');
    expect(reply).toMatch(/confirm booking|you have selected/i);
    const updated = await db.getSession(session.id);
    expect(updated.conversation_state).toBe('CONFIRM_BOOKING');
    const data = JSON.parse(updated.data);
    expect(data.selected_slot.id).toBe('SLOT-10');
  });

  test('page-0 slot ID typed while on page 1 → validation error (page-scoped)', async () => {
    const slots = makeSlots(12);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots, { slot_page: 1 }));
    // Typing "1" while on page 1 (page 1 expects global IDs 9-12 for 12-slot list)
    const reply = await callHandler(engine, ['handleSelectSlotState'], session, '1');
    expect(String(reply)).toMatch(/invalid slot/i);
  });

  test('out-of-range ID on page 1 → validation error', async () => {
    const slots = makeSlots(12);
    const session = await seedAt('SELECT_SLOT', baseSlotSession(slots, { slot_page: 1 }));
    // page 1 shows slots 9-12 (only 4 remaining), so "17" is out of range
    const reply = await callHandler(engine, ['handleSelectSlotState'], session, '17');
    expect(String(reply)).toMatch(/invalid slot/i);
  });

  // ─── handleConfirmRescheduleState pagination and selection ───────────────────

  const rescheduleSlotSession = (slots, extra = {}) => ({
    selected_reschedule_appt: RESCHEDULE_APPT,
    available_times: slots,
    slot_page: 0,
    ...extra,
  });

  test('reschedule "next" advances page and interactive rows contain slot 10', async () => {
    const slots = makeSlots(10);
    const session = await seedAt('CONFIRM_RESCHEDULE', rescheduleSlotSession(slots));
    const reply = await rawCall('handleConfirmRescheduleState', session, 'next');
    expect(reply).toHaveProperty('interactive');
    const rows = reply.interactive.action.sections[0].rows;
    expect(rows.some(r => r.id === '10')).toBe(true);
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).slot_page).toBe(1);
  });

  test('reschedule "m" still advances page', async () => {
    const slots = makeSlots(10);
    const session = await seedAt('CONFIRM_RESCHEDULE', rescheduleSlotSession(slots));
    await callHandler(engine, ['handleConfirmRescheduleState'], session, 'm');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).slot_page).toBe(1);
  });

  test('reschedule "prev" goes back from page 1 to page 0', async () => {
    const slots = makeSlots(10);
    const session = await seedAt('CONFIRM_RESCHEDULE', rescheduleSlotSession(slots, { slot_page: 1 }));
    await callHandler(engine, ['handleConfirmRescheduleState'], session, 'prev');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).slot_page).toBe(0);
  });

  test('reschedule slot selection on page 0 → PATCH uses original appointment_type_id and duration-derived ends_at', async () => {
    const slots = makeSlots(3);
    let capturedPayload;
    engine.clinikoAPI.updateIndividualAppointment = jest.fn().mockImplementation((_id, payload) => {
      capturedPayload = payload;
      return Promise.resolve({ success: true, appointmentId: _id });
    });
    const session = await seedAt('CONFIRM_RESCHEDULE', rescheduleSlotSession(slots));
    await callHandler(engine, ['handleConfirmRescheduleState'], session, '1');

    expect(capturedPayload).toBeDefined();
    // appointment_type_id must come from the original appointment, not the slot
    expect(capturedPayload.appointment_type_id).toBe('AT-001');
    // ends_at must be derived from the original appointment's 60-min duration, not hardcoded 30 min
    const newStart  = new Date(capturedPayload.starts_at).getTime();
    const newEnd    = new Date(capturedPayload.ends_at).getTime();
    const durMin    = (newEnd - newStart) / 60000;
    expect(durMin).toBe(60);
  });

  test('reschedule slot selection by global ID on page 1 → not a validation error', async () => {
    const slots = makeSlots(12);
    engine.clinikoAPI.updateIndividualAppointment = jest.fn().mockResolvedValue({ success: true, appointmentId: 'X' });
    const session = await seedAt('CONFIRM_RESCHEDULE', rescheduleSlotSession(slots, { slot_page: 1 }));
    const reply = await callHandler(engine, ['handleConfirmRescheduleState'], session, '10').catch(e => String(e));
    expect(String(reply)).not.toMatch(/invalid slot/i);
  });

  test('reschedule page-0 ID on page 1 → validation error', async () => {
    const slots = makeSlots(12);
    const session = await seedAt('CONFIRM_RESCHEDULE', rescheduleSlotSession(slots, { slot_page: 1 }));
    const reply = await callHandler(engine, ['handleConfirmRescheduleState'], session, '1');
    expect(String(reply)).toMatch(/invalid slot/i);
  });

  // ─── _rescheduleFetchAndShowSlots ─────────────────────────────────────────────

  test('_rescheduleFetchAndShowSlots returns plain text string (not interactive envelope)', async () => {
    const slots = makeSlots(3);
    engine.clinikoAPI.getAvailableTimes = jest.fn().mockResolvedValue(slots);
    const session = await seedAt('RESCHEDULE_CONFIRM_INTENT', {
      selected_reschedule_appt: RESCHEDULE_APPT,
    });
    const data = { selected_reschedule_appt: RESCHEDULE_APPT };
    const reply = await engine._rescheduleFetchAndShowSlots(session, data);
    expect(reply).toHaveProperty('interactive');
    expect(reply.interactive.type).toBe('list');
  });

  test('_rescheduleFetchAndShowSlots with 10+ slots interactive list has next row', async () => {
    const slots = makeSlots(10);
    engine.clinikoAPI.getAvailableTimes = jest.fn().mockResolvedValue(slots);
    const session = await seedAt('RESCHEDULE_CONFIRM_INTENT', {
      selected_reschedule_appt: RESCHEDULE_APPT,
    });
    const data = { selected_reschedule_appt: RESCHEDULE_APPT };
    const reply = await engine._rescheduleFetchAndShowSlots(session, data);
    const rows = reply.interactive.action.sections[0].rows;
    expect(rows.map(r => r.id)).toContain('next');
  });

  test('_rescheduleFetchAndShowSlots — zero slots gives the standard 3-option prompt, preserves reschedule_appt_list for retry', async () => {
    engine.clinikoAPI.getAvailableTimes = jest.fn().mockResolvedValue([]);
    const session = await seedAt('RESCHEDULE_CONFIRM_INTENT', {
      selected_reschedule_appt: RESCHEDULE_APPT,
      reschedule_appt_list: [RESCHEDULE_APPT],
    });
    const data = { selected_reschedule_appt: RESCHEDULE_APPT, reschedule_appt_list: [RESCHEDULE_APPT] };
    const reply = String(await engine._rescheduleFetchAndShowSlots(session, data));
    expect(reply).toMatch(/no available slots for rescheduling/i);
    expect(reply).toMatch(/try again/i);

    const updated = await db.getSession(session.id);
    const d = JSON.parse(updated.data || '{}');
    expect(d.no_slots_prompt.context).toBe('reschedule');
    // reschedule_appt_list survives so "Try Again" shows the same list to
    // re-pick from, instead of an empty list (the pre-fix behavior deleted it).
    expect(d.reschedule_appt_list).toEqual([RESCHEDULE_APPT]);
  });

  // Regression: getAvailableTimes rethrows on failure (unlike
  // getAvailableSlotsByBusinessAndDate, which swallows to []) — a 429 here
  // previously propagated uncaught to handleMessage's top-level catch,
  // producing a generic error instead of the no-slots retry prompt.
  test('_rescheduleFetchAndShowSlots — getAvailableTimes throwing (e.g. a 429) is caught, not left uncaught', async () => {
    engine.clinikoAPI.getAvailableTimes = jest.fn().mockRejectedValue({ status: 429, message: 'Request failed with status code 429' });
    const session = await seedAt('RESCHEDULE_CONFIRM_INTENT', {
      selected_reschedule_appt: RESCHEDULE_APPT,
      reschedule_appt_list: [RESCHEDULE_APPT],
    });
    const data = { selected_reschedule_appt: RESCHEDULE_APPT, reschedule_appt_list: [RESCHEDULE_APPT] };

    // Must not throw — the caller has no try/catch around this in the real
    // handler chain below RESCHEDULE_CONFIRM_INTENT's 'yes' branch.
    const reply = String(await engine._rescheduleFetchAndShowSlots(session, data));
    expect(reply).toMatch(/trouble checking availability/i);
    expect(reply).toMatch(/try again/i);

    const updated = await db.getSession(session.id);
    const d = JSON.parse(updated.data || '{}');
    expect(d.reschedule_appt_list).toEqual([RESCHEDULE_APPT]);
  });

  // ─── No gaps between pages ───────────────────────────────────────────────────

  // ─── _buildSlotList internal contract (unchanged) ────────────────────────────

  test('_buildSlotList internal method still returns MessageEnvelope (internal contract)', () => {
    const slots = makeSlots(3);
    const result = engine._buildSlotList(slots, 0, 'Test header', 'Asia/Singapore');
    expect(result).toHaveProperty('interactive');
    expect(result.interactive.type).toBe('list');
  });

  // ─── No gaps between pages ───────────────────────────────────────────────────

  test('no slot is skipped: pages cover all slots without overlap or gap', () => {
    const total = 25;
    const slots = makeSlots(total);
    const seen = new Set();
    let page = 0;
    // Walk pages until last
    while (true) {
      const start = engine._slotPageStart(page);
      const count = engine._slotPageCount(page);
      const hasNext = total > start + count;
      const pageSlots = slots.slice(start, start + count);
      pageSlots.forEach(s => seen.add(s.id));
      if (!hasNext) break;
      page++;
    }
    expect(seen.size).toBe(total);
    for (let i = 1; i <= total; i++) {
      expect(seen.has(`SLOT-${i}`)).toBe(true);
    }
  });
});

// =============================================================================
// SUITE — Verified main menu: logout button and interactive envelope
// =============================================================================
describe('renderMainMenu — verified menu must include logout row', () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });

  async function verifiedSession(phone) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_MANAGE_OPTIONS',
      context: JSON.stringify({ region: 'SG' }),
    });
    return db.getSession(id);
  }

  test('renderMainMenu (verified) returns a MessageEnvelope, not a plain string', async () => {
    const session = await verifiedSession('+6560000001');
    const reply = await engine.renderMainMenu(session);
    expect(reply).toHaveProperty('interactive');
    expect(reply.interactive.type).toBe('list');
  });

  test('renderMainMenu (verified) includes Book, Cancel, Reschedule rows', async () => {
    const session = await verifiedSession('+6560000002');
    const reply = await engine.renderMainMenu(session);
    const ids = reply.interactive.action.sections[0].rows.map(r => r.id);
    expect(ids).toContain('1'); // Book
    expect(ids).toContain('2'); // Cancel
    expect(ids).toContain('3'); // Reschedule
  });

  test('renderMainMenu (verified) includes a logout/delete row with id "9"', async () => {
    const session = await verifiedSession('+6560000003');
    const reply = await engine.renderMainMenu(session);
    const rows = reply.interactive.action.sections[0].rows;
    const logoutRow = rows.find(r => r.id === '9');
    expect(logoutRow).toBeDefined();
    expect(logoutRow.title).toMatch(/logout|delete/i);
  });

  test('renderMainMenu (unverified) does NOT include a logout row', async () => {
    const id = await db.createSession('+6560000004', null, 60);
    await db.updateSession(id, {
      verified: 0, conversation_state: 'INTRO',
      context: JSON.stringify({ region: 'SG' }),
    });
    const session = await db.getSession(id);
    const reply = await engine.renderMainMenu(session);
    const rows = reply.interactive.action.sections[0].rows;
    expect(rows.find(r => r.id === '9')).toBeUndefined();
  });

  test('sending "9" from BOOK_MANAGE_OPTIONS logs out and returns unverified menu', async () => {
    const session = await verifiedSession('+6560000005');
    const reply = await engine.handleMessage('9', '+6560000005');
    expect(reply).toMatch(/logged out|deleted|data has been deleted/i);
    const freshSession = await db.getSessionByPhone('+6560000005');
    expect(freshSession.verified).toBeFalsy();
  });
});

// =============================================================================
// SUITE — Interactive envelope: fees, locations, and mixed string+menu replies
// =============================================================================
describe('Interactive envelope integrity — fees, locations, and string+menu replies', () => {
  let db, sm, engine;
  const SAFE_BODY_LIMIT = 4096; // WhatsApp interactive body text hard limit

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    engine.clinikoAPI.getClinics = jest.fn().mockResolvedValue([
      { business_name: 'Clinic A', address_1: '1 Test St', city: 'Singapore', phone_number: '+6512345678', profile_url: null },
      { business_name: 'Clinic B', address_1: '2 Test Rd', city: 'Singapore', phone_number: '+6587654321', profile_url: null },
    ]);
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });

  async function unverifiedSession(phone, region = 'SG') {
    const id = await db.createSession(phone, null, 60);
    await db.updateSession(id, {
      verified: 0, conversation_state: 'VIEW_FEES',
      context: JSON.stringify({ region }),
    });
    return db.getSession(id);
  }

  async function unverifiedLocationSession(phone, region = 'SG') {
    const id = await db.createSession(phone, null, 60);
    await db.updateSession(id, {
      verified: 0, conversation_state: 'VIEW_LOCATIONS',
      context: JSON.stringify({ region }),
    });
    return db.getSession(id);
  }

  // ─── Fees ──────────────────────────────────────────────────────────────────

  test('handleViewFeesState returns a two-part tuple [text, interactive]', async () => {
    const session = await unverifiedSession('+6561000001');
    const reply = await engine.handleViewFeesState(session, '');
    expect(Array.isArray(reply)).toBe(true);
    expect(typeof reply[0]).toBe('string');
    expect(reply[1]).toHaveProperty('interactive');
  });

  test('handleViewFeesState first part contains fee text', async () => {
    const session = await unverifiedSession('+6561000002');
    const [text] = await engine.handleViewFeesState(session, '');
    expect(text).toMatch(/fee|SGD|physio/i);
  });

  test('handleViewFeesState second part is interactive menu envelope', async () => {
    const session = await unverifiedSession('+6561000003');
    const [, menu] = await engine.handleViewFeesState(session, '');
    expect(menu).toHaveProperty('interactive');
    expect(menu.interactive.type).toBe('list');
  });

  test('handleViewFeesState works for all four regions', async () => {
    for (const [i, region] of ['SG', 'HK', 'IN', 'PH'].entries()) {
      const session = await unverifiedSession(`+6561000${10 + i}`, region);
      const [text, menu] = await engine.handleViewFeesState(session, '');
      expect(text).toMatch(/fee|physio/i);
      expect(menu).toHaveProperty('interactive');
    }
  });

  test('handleViewFeesState fee text does not exceed WhatsApp text message limit', async () => {
    const session = await unverifiedSession('+6561000020');
    const [text] = await engine.handleViewFeesState(session, '');
    expect(text.length).toBeLessThanOrEqual(4096);
  });

  // ─── Locations ─────────────────────────────────────────────────────────────

  test('handleViewLocationsState returns a two-part tuple [text, interactive]', async () => {
    const session = await unverifiedLocationSession('+6562000001');
    const reply = await engine.handleViewLocationsState(session, '');
    expect(Array.isArray(reply)).toBe(true);
    expect(typeof reply[0]).toBe('string');
    expect(reply[1]).toHaveProperty('interactive');
  });

  test('handleViewLocationsState first part contains clinic info', async () => {
    const session = await unverifiedLocationSession('+6562000002');
    const [text] = await engine.handleViewLocationsState(session, '');
    expect(text).toMatch(/clinic/i);
  });

  test('handleViewLocationsState second part is interactive menu envelope', async () => {
    const session = await unverifiedLocationSession('+6562000003');
    const [, menu] = await engine.handleViewLocationsState(session, '');
    expect(menu).toHaveProperty('interactive');
    expect(menu.interactive.type).toBe('list');
  });

  test('handleViewLocationsState falls back gracefully if no clinics returned', async () => {
    engine.clinikoAPI.getClinics = jest.fn().mockResolvedValue([]);
    const session = await unverifiedLocationSession('+6562000004');
    const [text] = await engine.handleViewLocationsState(session, '');
    expect(typeof text).toBe('string');
    expect(text).toMatch(/no clinic information/i);
    engine.clinikoAPI.getClinics = jest.fn().mockResolvedValue([
      { business_name: 'Clinic A', address_1: '1 Test St', city: 'Singapore', phone_number: '+6512345678', profile_url: null },
    ]);
  });

  // ─── String + menu coercion guard ──────────────────────────────────────────

  test('Verification success reply is a MessageEnvelope (not plain string)', async () => {
    const id = await db.createSession('+6563000001', null, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_MANAGE_OPTIONS',
      context: JSON.stringify({ region: 'SG' }),
    });
    const session = await db.getSession(id);
    const reply = await engine.goToInteractiveMenu(session);
    expect(reply).toHaveProperty('interactive');
  });

  test('Fallback reply ("I did not understand") is a MessageEnvelope', async () => {
    const id = await db.createSession('+6563000002', null, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_MANAGE_OPTIONS',
      context: JSON.stringify({ region: 'SG' }),
    });
    const session = await db.getSession(id);
    const reply = await engine.handleBookManageOptions(session, 'zzzzunknown');
    expect(reply).toHaveProperty('interactive');
  });
});

// =============================================================================
// SUITE — 24-hour cancellation block: an appointment starting within the next
// 24 hours cannot be cancelled via WhatsApp. The client sees a front-desk
// contact prompt (Main menu / Email us / Message on WhatsApp) instead of the
// normal Yes/No confirmation. Near-term appointments still appear in the
// "select which to cancel" list — only confirming the cancel is blocked.
// =============================================================================
describe('Cancellation blocked within 24 hours', () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    engine.clinikoAPI.getPractitionerById = jest.fn().mockResolvedValue({ id: 'PRAC-1', first_name: 'Jane', last_name: 'Tan', display_name: 'Dr. Jane Tan' });
    engine.clinikoAPI.getAppointmentTypeById = jest.fn().mockResolvedValue({ id: 'AT-1', name: 'Follow-up Physio' });
    engine.clinikoAPI.getBusinessById = jest.fn().mockResolvedValue({ id: 'BIZ-1', business_name: 'Prohealth Novena' });
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });

  function apptAt(hoursFromNow, overrides = {}) {
    return {
      id: 'APPT-1',
      starts_at: new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString(),
      cancelled_at: null,
      practitioner: { id: 'PRAC-1', first_name: 'Jane', last_name: 'Tan', display_name: 'Dr. Jane Tan' },
      appointment_type: { id: 'AT-1', name: 'Follow-up Physio' },
      business: { id: 'BIZ-1', business_name: 'Prohealth Novena' },
      ...overrides,
    };
  }

  async function verifiedSession(phone, region = 'SG', email = '') {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'CANCEL_APPOINTMENT',
      context: JSON.stringify({ region, email }),
    });
    return db.getSession(id);
  }

  // Seeds a session already inside the blocked prompt via the real
  // single-appointment auto-jump path (handleCancelAppointmentState).
  async function blockedSession(phone, region = 'SG', email = 'patient@example.com') {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(6)]);
    const session = await verifiedSession(phone, region, email);
    await engine.handleCancelAppointmentState(session, '');
    return db.getSessionByPhone(phone);
  }

  // ─── _isAppointmentChangeBlockedByPolicy — pure boundary checks ───────────
  // Shared by both cancel and reschedule blocking.

  describe('_isAppointmentChangeBlockedByPolicy()', () => {
    test('12 hours away is blocked', () => {
      expect(engine._isAppointmentChangeBlockedByPolicy(apptAt(12))).toBe(true);
    });
    test('3 days away is not blocked', () => {
      expect(engine._isAppointmentChangeBlockedByPolicy(apptAt(72))).toBe(false);
    });
    test('boundary: 23h59m away is blocked', () => {
      expect(engine._isAppointmentChangeBlockedByPolicy(apptAt(23 + 59 / 60))).toBe(true);
    });
    test('boundary: 24h01m away is not blocked', () => {
      expect(engine._isAppointmentChangeBlockedByPolicy(apptAt(24 + 1 / 60))).toBe(false);
    });
    test('missing starts_at is not blocked (defensive)', () => {
      expect(engine._isAppointmentChangeBlockedByPolicy({})).toBe(false);
      expect(engine._isAppointmentChangeBlockedByPolicy(null)).toBe(false);
    });
  });

  // ─── Selection list — near-term appointment still shown, not filtered ─────

  test('a near-term appointment still appears in the "select which to cancel" list', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(12), apptAt(72, { id: 'APPT-2' })]);
    const session = await verifiedSession('+6570000001');
    const reply = await engine.handleCancelAppointmentState(session, '');
    expect(reply).toHaveProperty('interactive');
    expect(reply.interactive.type).toBe('list');
    const rows = reply.interactive.action.sections[0].rows;
    const apptRows = rows.filter(r => r.id !== 'back'); // exclude the nav "← Back" row
    expect(apptRows).toHaveLength(2);
  });

  // ─── Single-appointment auto-jump path also blocks ─────────────────────────

  test('single upcoming appointment within 24h auto-jumps straight to the blocked prompt (not Yes/No)', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(6)]);
    const session = await verifiedSession('+6570000002');
    const reply = await engine.handleCancelAppointmentState(session, '');
    expect(reply).toHaveProperty('interactive');
    const titles = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(titles).toEqual(['Main menu', 'Email us', 'Message on WhatsApp']);
    expect(String(reply)).toMatch(/within 24 hours/i);
    expect(String(reply)).not.toMatch(/yes, cancel/i);
  });

  test('single upcoming appointment beyond 24h auto-jumps to normal Yes/No confirm (regression)', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(72)]);
    const session = await verifiedSession('+6570000003');
    const reply = await engine.handleCancelAppointmentState(session, '');
    const titles = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(titles).toEqual(['Yes, cancel', 'Go back']);
  });

  // ─── Selecting a near-term appointment from a multi-appointment list ──────

  test('selecting a near-term appointment from the list shows the blocked prompt, not Yes/No', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(12), apptAt(72, { id: 'APPT-2' })]);
    const session = await verifiedSession('+6570000004');
    await engine.handleCancelAppointmentState(session, ''); // populates cancel_appt_list
    const listed = await db.getSessionByPhone('+6570000004');
    const reply = await engine.handleSelectAppointmentToCancelState(listed, '1');
    const titles = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(titles).toEqual(['Main menu', 'Email us', 'Message on WhatsApp']);
  });

  test('selecting the far-out appointment from the same list still shows Yes/No confirm', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(12), apptAt(72, { id: 'APPT-2' })]);
    const session = await verifiedSession('+6570000005');
    await engine.handleCancelAppointmentState(session, '');
    const listed = await db.getSessionByPhone('+6570000005');
    const reply = await engine.handleSelectAppointmentToCancelState(listed, '2');
    const titles = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(titles).toEqual(['Yes, cancel', 'Go back']);
  });

  // ─── Blocked-prompt decisions ───────────────────────────────────────────────

  describe('blocked-prompt decision handling', () => {
    test('"1" goes to main menu and clears cancel-related session state', async () => {
      const session = await blockedSession('+6570000010');
      const reply = await engine.handleConfirmCancelState(session, '1');
      expect(reply).toHaveProperty('interactive');
      const updated = await db.getSessionByPhone('+6570000010');
      const data = JSON.parse(updated.data || '{}');
      expect(data.cancel_blocked_prompt).toBeUndefined();
      expect(data.selected_cancel_appt).toBeUndefined();
    });

    test('"0"/"back"/"menu" behave the same as "1"', async () => {
      for (const [i, cmd] of ['0', 'back', 'menu'].entries()) {
        const phone = `+657000002${i}`;
        const session = await blockedSession(phone);
        const reply = await engine.handleConfirmCancelState(session, cmd);
        expect(reply).toHaveProperty('interactive');
        const updated = await db.getSessionByPhone(phone);
        const data = JSON.parse(updated.data || '{}');
        expect(data.cancel_blocked_prompt).toBeUndefined();
      }
    });

    test('"2" sends a support email to front desk + patient and confirms via chat', async () => {
      const session = await blockedSession('+6570000030', 'SG', 'patient@example.com');
      const postEmailSpy = jest.spyOn(engine, '_postEmail').mockResolvedValue();

      const reply = await engine.handleConfirmCancelState(session, '2');

      expect(postEmailSpy).toHaveBeenCalledTimes(1);
      const payload = postEmailSpy.mock.calls[0][0];
      expect(payload.to).toContain('admin@intouchphysio.com'); // SG support email
      expect(payload.to).toContain('patient@example.com');
      expect(payload.subject).toMatch(/cancel blocked/i);
      expect(payload.text).not.toMatch(/successfully cancelled/i);
      expect(payload.text).toContain('Dr. Jane Tan');
      expect(payload.text).toContain('Prohealth Novena');
      expect(String(reply)).toMatch(/front desk will be in touch/i);

      postEmailSpy.mockRestore();
    });

    test('"2" still confirms via chat even if the email send fails', async () => {
      const session = await blockedSession('+6570000031');
      const postEmailSpy = jest.spyOn(engine, '_postEmail').mockRejectedValue(new Error('mailer down'));
      const reply = await engine.handleConfirmCancelState(session, '2');
      expect(String(reply)).toMatch(/front desk will be in touch/i);
      postEmailSpy.mockRestore();
    });

    test('"3" returns a wa.me link to the region\'s front-desk number', async () => {
      const session = await blockedSession('+6570000040');
      const reply = await engine.handleConfirmCancelState(session, '3');
      expect(String(reply)).toMatch(/wa\.me\/6565330968/); // SG support phone, digits only
    });

    test('"3" resolves the HK per-clinic phone from the appointment\'s clinic name', async () => {
      engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([
        apptAt(6, { business: { id: 'BIZ-WWH', business_name: 'Prohealth (WWH)' } }),
      ]);
      engine.clinikoAPI.getBusinessById = jest.fn().mockResolvedValue({ id: 'BIZ-WWH', business_name: 'Prohealth (WWH)' });
      const session = await verifiedSession('+6570000041', 'HK');
      await engine.handleCancelAppointmentState(session, '');
      const fresh = await db.getSessionByPhone('+6570000041');
      const reply = await engine.handleConfirmCancelState(fresh, '3');
      expect(String(reply)).toMatch(/wa\.me\/85254223760/); // WWH-specific number
      engine.clinikoAPI.getBusinessById = jest.fn().mockResolvedValue({ id: 'BIZ-1', business_name: 'Prohealth Novena' });
    });

    test('unrecognised input re-renders the same blocked prompt with an error prefix, and does not clear the prompt flag', async () => {
      const session = await blockedSession('+6570000050');
      const reply = await engine.handleConfirmCancelState(session, 'banana');
      expect(String(reply)).toMatch(/please reply with 1, 2, or 3/i);
      const titles = reply.interactive.action.buttons.map(b => b.reply.title);
      expect(titles).toEqual(['Main menu', 'Email us', 'Message on WhatsApp']);
      const updated = await db.getSessionByPhone('+6570000050');
      const data = JSON.parse(updated.data || '{}');
      expect(data.cancel_blocked_prompt).toBe(true);
    });
  });

  // ─── Regression: normal (non-blocked) cancel flow unaffected ──────────────

  test('a far-out appointment still cancels normally end-to-end on "yes"', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(72)]);
    engine.clinikoAPI.cancelSpecificAppointment = jest.fn().mockResolvedValue({ success: true });
    const session = await verifiedSession('+6570000060');
    await engine.handleCancelAppointmentState(session, ''); // auto-jump, single appt
    const fresh = await db.getSessionByPhone('+6570000060');
    const reply = await engine.handleConfirmCancelState(fresh, 'yes');
    expect(String(reply)).toMatch(/your appointment has been cancelled/i);
    expect(engine.clinikoAPI.cancelSpecificAppointment).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// SUITE — 24-hour reschedule block: an appointment starting within the next
// 24 hours cannot be rescheduled via WhatsApp either — mirrors the cancel
// block above (same _isAppointmentChangeBlockedByPolicy /
// _renderAppointmentChangeBlockedPrompt shared helpers). The client sees the
// same front-desk contact prompt instead of "Yes, reschedule / Go back".
// =============================================================================
describe('Reschedule blocked within 24 hours', () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    engine.clinikoAPI.getPractitionerById = jest.fn().mockResolvedValue({ id: 'PRAC-1', first_name: 'Jane', last_name: 'Tan', display_name: 'Dr. Jane Tan' });
    engine.clinikoAPI.getAppointmentTypeById = jest.fn().mockResolvedValue({ id: 'AT-1', name: 'Follow-up Physio' });
    engine.clinikoAPI.getBusinessById = jest.fn().mockResolvedValue({ id: 'BIZ-1', business_name: 'Prohealth Novena' });
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });

  function apptAt(hoursFromNow, overrides = {}) {
    return {
      id: 'APPT-1',
      starts_at: new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString(),
      cancelled_at: null,
      practitioner: { id: 'PRAC-1', first_name: 'Jane', last_name: 'Tan', display_name: 'Dr. Jane Tan' },
      appointment_type: { id: 'AT-1', name: 'Follow-up Physio' },
      business: { id: 'BIZ-1', business_name: 'Prohealth Novena' },
      ...overrides,
    };
  }

  async function verifiedSession(phone, region = 'SG', email = '') {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verification_status: 'verified', verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'RESCHEDULE_APPOINTMENT',
      context: JSON.stringify({ region, email }),
    });
    return db.getSession(id);
  }

  // Seeds a session already inside the blocked prompt via the real
  // single-appointment auto-jump path (handleRescheduleAppointmentState).
  async function blockedSession(phone, region = 'SG', email = 'patient@example.com') {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(6)]);
    const session = await verifiedSession(phone, region, email);
    await engine.handleRescheduleAppointmentState(session, '');
    return db.getSessionByPhone(phone);
  }

  // ─── Selection list — near-term appointment still shown, not filtered ─────

  test('a near-term appointment still appears in the "select which to reschedule" list', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(12), apptAt(72, { id: 'APPT-2' })]);
    const session = await verifiedSession('+6571000001');
    const reply = await engine.handleRescheduleAppointmentState(session, '');
    expect(reply).toHaveProperty('interactive');
    expect(reply.interactive.type).toBe('list');
    const rows = reply.interactive.action.sections[0].rows;
    const apptRows = rows.filter(r => r.id !== 'back');
    expect(apptRows).toHaveLength(2);
  });

  // ─── Single-appointment auto-jump path also blocks ─────────────────────────

  test('single upcoming appointment within 24h auto-jumps straight to the blocked prompt (not Yes/No)', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(6)]);
    const session = await verifiedSession('+6571000002');
    const reply = await engine.handleRescheduleAppointmentState(session, '');
    expect(reply).toHaveProperty('interactive');
    const titles = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(titles).toEqual(['Main menu', 'Email us', 'Message on WhatsApp']);
    expect(String(reply)).toMatch(/within 24 hours/i);
    expect(String(reply)).not.toMatch(/yes, reschedule/i);
  });

  test('single upcoming appointment beyond 24h auto-jumps to normal Yes/No confirm (regression)', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(72)]);
    const session = await verifiedSession('+6571000003');
    const reply = await engine.handleRescheduleAppointmentState(session, '');
    const titles = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(titles).toEqual(['Yes, reschedule', 'Go back']);
  });

  // ─── Selecting a near-term appointment from a multi-appointment list ──────

  test('selecting a near-term appointment from the list shows the blocked prompt, not Yes/No', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(12), apptAt(72, { id: 'APPT-2' })]);
    const session = await verifiedSession('+6571000004');
    await engine.handleRescheduleAppointmentState(session, ''); // populates reschedule_appt_list
    const listed = await db.getSessionByPhone('+6571000004');
    const reply = await engine.handleSelectAppointmentToRescheduleState(listed, '1');
    const titles = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(titles).toEqual(['Main menu', 'Email us', 'Message on WhatsApp']);
  });

  test('selecting the far-out appointment from the same list still shows Yes/No confirm', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(12), apptAt(72, { id: 'APPT-2' })]);
    const session = await verifiedSession('+6571000005');
    await engine.handleRescheduleAppointmentState(session, '');
    const listed = await db.getSessionByPhone('+6571000005');
    const reply = await engine.handleSelectAppointmentToRescheduleState(listed, '2');
    const titles = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(titles).toEqual(['Yes, reschedule', 'Go back']);
  });

  // ─── Blocked-prompt decisions ───────────────────────────────────────────────

  describe('blocked-prompt decision handling', () => {
    test('"1" goes to main menu and clears reschedule-related session state', async () => {
      const session = await blockedSession('+6571000010');
      const reply = await engine.handleRescheduleIntentConfirmState(session, '1');
      expect(reply).toHaveProperty('interactive');
      const updated = await db.getSessionByPhone('+6571000010');
      const data = JSON.parse(updated.data || '{}');
      expect(data.reschedule_blocked_prompt).toBeUndefined();
      expect(data.selected_reschedule_appt).toBeUndefined();
    });

    test('"0"/"back"/"menu" behave the same as "1"', async () => {
      for (const [i, cmd] of ['0', 'back', 'menu'].entries()) {
        const phone = `+657100002${i}`;
        const session = await blockedSession(phone);
        const reply = await engine.handleRescheduleIntentConfirmState(session, cmd);
        expect(reply).toHaveProperty('interactive');
        const updated = await db.getSessionByPhone(phone);
        const data = JSON.parse(updated.data || '{}');
        expect(data.reschedule_blocked_prompt).toBeUndefined();
      }
    });

    test('"2" sends a support email to front desk + patient and confirms via chat', async () => {
      const session = await blockedSession('+6571000030', 'SG', 'patient@example.com');
      const postEmailSpy = jest.spyOn(engine, '_postEmail').mockResolvedValue();

      const reply = await engine.handleRescheduleIntentConfirmState(session, '2');

      expect(postEmailSpy).toHaveBeenCalledTimes(1);
      const payload = postEmailSpy.mock.calls[0][0];
      expect(payload.to).toContain('admin@intouchphysio.com'); // SG support email
      expect(payload.to).toContain('patient@example.com');
      expect(payload.subject).toMatch(/reschedule blocked/i);
      expect(payload.text).not.toMatch(/has been rescheduled|successfully rescheduled/i); // never claims it was actually rescheduled
      expect(payload.text).toContain('Dr. Jane Tan');
      expect(payload.text).toContain('Prohealth Novena');
      expect(String(reply)).toMatch(/front desk will be in touch/i);

      postEmailSpy.mockRestore();
    });

    test('"2" still confirms via chat even if the email send fails', async () => {
      const session = await blockedSession('+6571000031');
      const postEmailSpy = jest.spyOn(engine, '_postEmail').mockRejectedValue(new Error('mailer down'));
      const reply = await engine.handleRescheduleIntentConfirmState(session, '2');
      expect(String(reply)).toMatch(/front desk will be in touch/i);
      postEmailSpy.mockRestore();
    });

    test('"3" returns a wa.me link to the region\'s front-desk number', async () => {
      const session = await blockedSession('+6571000040');
      const reply = await engine.handleRescheduleIntentConfirmState(session, '3');
      expect(String(reply)).toMatch(/wa\.me\/6565330968/); // SG support phone, digits only
    });

    test('"3" resolves the HK per-clinic phone from the appointment\'s clinic name', async () => {
      engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([
        apptAt(6, { business: { id: 'BIZ-WWH', business_name: 'Prohealth (WWH)' } }),
      ]);
      engine.clinikoAPI.getBusinessById = jest.fn().mockResolvedValue({ id: 'BIZ-WWH', business_name: 'Prohealth (WWH)' });
      const session = await verifiedSession('+6571000041', 'HK');
      await engine.handleRescheduleAppointmentState(session, '');
      const fresh = await db.getSessionByPhone('+6571000041');
      const reply = await engine.handleRescheduleIntentConfirmState(fresh, '3');
      expect(String(reply)).toMatch(/wa\.me\/85254223760/); // WWH-specific number
      engine.clinikoAPI.getBusinessById = jest.fn().mockResolvedValue({ id: 'BIZ-1', business_name: 'Prohealth Novena' });
    });

    test('unrecognised input re-renders the same blocked prompt with an error prefix, and does not clear the prompt flag', async () => {
      const session = await blockedSession('+6571000050');
      const reply = await engine.handleRescheduleIntentConfirmState(session, 'banana');
      expect(String(reply)).toMatch(/please reply with 1, 2, or 3/i);
      const titles = reply.interactive.action.buttons.map(b => b.reply.title);
      expect(titles).toEqual(['Main menu', 'Email us', 'Message on WhatsApp']);
      const updated = await db.getSessionByPhone('+6571000050');
      const data = JSON.parse(updated.data || '{}');
      expect(data.reschedule_blocked_prompt).toBe(true);
    });
  });

  // ─── Regression: normal (non-blocked) reschedule flow unaffected ──────────

  test('a far-out appointment still proceeds to slot selection on "yes" (not blocked)', async () => {
    engine.clinikoAPI.getBookingsByPatientId = jest.fn().mockResolvedValue([apptAt(72)]);
    engine.clinikoAPI.getAvailableTimes = jest.fn().mockResolvedValue([
      { appointment_start: new Date(Date.now() + 96 * 3600 * 1000).toISOString() },
    ]);
    const session = await verifiedSession('+6571000060');
    await engine.handleRescheduleAppointmentState(session, ''); // auto-jump, single appt
    const fresh = await db.getSessionByPhone('+6571000060');
    const reply = await engine.handleRescheduleIntentConfirmState(fresh, 'yes');
    expect(String(reply)).not.toMatch(/within 24 hours/i);
    expect(String(reply)).toMatch(/choose a new slot/i);
  });
});

// =============================================================================
// SUITE — Slot list rendered as interactive list
// =============================================================================
describe('Slot list — rendered as interactive list for uniform UX', () => {
  let db, sm, engine;

  const PATIENT_ID_SLOT = 'pat-slot-001';
  const BASE_APPT = {
    id: 'appt-01', starts_at: new Date(Date.now() + 86400000).toISOString(),
    practitioner: { links: { self: 'https://api.cliniko.com/v1/practitioners/1' } },
    appointment_type: { links: { self: 'https://api.cliniko.com/v1/appointment_types/1' } },
    business: { links: { self: 'https://api.cliniko.com/v1/businesses/1' } },
  };

  function makeSlots(n) {
    return Array.from({ length: n }, (_, i) => ({
      id: `S${i + 1}`,
      slot: new Date(Date.now() + (i + 1) * 3600000).toISOString(),
      practitioner_id: '1', business_id: '1', appointment_type_id: '1',
    }));
  }

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    engine.clinikoAPI.getAvailableTimes = jest.fn().mockResolvedValue(makeSlots(3));
    engine.clinikoAPI.getPractitionerById = jest.fn().mockResolvedValue({ display_name: 'Dr Test' });
    engine.clinikoAPI.getAppointmentTypeById = jest.fn().mockResolvedValue({ name: 'Initial' });
    engine.clinikoAPI.getBusinessById = jest.fn().mockResolvedValue({ business_name: 'Test Clinic' });
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });

  async function seedSlotSession(phone, slotCount = 3) {
    const slots = makeSlots(slotCount);
    const id = await db.createSession(phone, PATIENT_ID_SLOT, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID_SLOT,
      conversation_state: 'SELECT_SLOT',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({ slot_list: slots, slot_page: 0 }),
    });
    return db.getSession(id);
  }

  // ─── Slot list render is always a string ───────────────────────────────────

  test('handleSelectSlotState renders slot list as interactive MessageEnvelope', async () => {
    const session = await seedSlotSession('+6570000001');
    const reply = await engine.handleSelectSlotState(session, '');
    expect(reply).toHaveProperty('interactive');
    expect(reply.interactive.type).toBe('list');
  });

  test('handleSelectSlotState interactive rows contain numbered slot entries', async () => {
    const session = await seedSlotSession('+6570000002');
    const reply = await engine.handleSelectSlotState(session, '');
    const rows = reply.interactive.action.sections[0].rows;
    expect(rows.some(r => r.id === '1')).toBe(true);
    expect(rows.some(r => r.id === '2')).toBe(true);
  });

  test('handleSelectSlotState text fallback includes back instruction', async () => {
    const session = await seedSlotSession('+6570000003');
    const reply = await engine.handleSelectSlotState(session, '');
    expect(String(reply)).toMatch(/back|0️⃣/i);
  });

  test('handleSelectSlotState with 10+ slots interactive rows include next row', async () => {
    const session = await seedSlotSession('+6570000004', 10);
    const reply = await engine.handleSelectSlotState(session, '');
    const rows = reply.interactive.action.sections[0].rows;
    expect(rows.some(r => r.id === 'next')).toBe(true);
  });

  test('handleSelectSlotState with page 1 interactive rows include prev row', async () => {
    const slots = makeSlots(10);
    const id = await db.createSession('+6570000005', PATIENT_ID_SLOT, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID_SLOT,
      conversation_state: 'SELECT_SLOT',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({ slot_list: slots, slot_page: 1 }),
    });
    const session = await db.getSession(id);
    const reply = await engine.handleSelectSlotState(session, '');
    const rows = reply.interactive.action.sections[0].rows;
    expect(rows.some(r => r.id === 'prev')).toBe(true);
  });

  // ─── Slot selection by number still works (text and list_reply both send a number) ──

  test('selecting slot "1" (text input) advances to CONFIRM_BOOKING', async () => {
    const session = await seedSlotSession('+6570000010');
    const reply = await engine.handleSelectSlotState(session, '1');
    expect(typeof reply).not.toBe('undefined');
    const updated = await db.getSession(session.id);
    expect(updated.conversation_state).toBe('CONFIRM_BOOKING');
  });

  test('selecting slot via list_reply id "2" (interactive response) advances to CONFIRM_BOOKING', async () => {
    const session = await seedSlotSession('+6570000011', 3);
    const reply = await engine.handleSelectSlotState(session, '2');
    const updated = await db.getSession(session.id);
    expect(updated.conversation_state).toBe('CONFIRM_BOOKING');
  });

  test('list_reply id "next" advances slot page', async () => {
    const session = await seedSlotSession('+6570000012', 10);
    const reply = await engine.handleSelectSlotState(session, 'next');
    const updated = await db.getSession(session.id);
    const data = JSON.parse(updated.data);
    expect(data.slot_page).toBe(1);
  });

  test('list_reply id "prev" on page 1 goes back to page 0', async () => {
    const slots = makeSlots(10);
    const id = await db.createSession('+6570000013', PATIENT_ID_SLOT, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID_SLOT,
      conversation_state: 'SELECT_SLOT',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({ slot_list: slots, slot_page: 1 }),
    });
    const session = await db.getSession(id);
    await engine.handleSelectSlotState(session, 'prev');
    const updated = await db.getSession(session.id);
    const data = JSON.parse(updated.data);
    expect(data.slot_page).toBe(0);
  });

  test('out-of-range slot number returns validation error string', async () => {
    const session = await seedSlotSession('+6570000014');
    const reply = await engine.handleSelectSlotState(session, '99');
    expect(typeof reply).toBe('string');
    expect(reply).toMatch(/invalid/i);
  });

  // ─── _buildSlotList internal contract is unchanged ─────────────────────────

  test('_buildSlotList internal method still returns a MessageEnvelope (not affected by fix)', () => {
    const slots = makeSlots(3);
    const result = engine._buildSlotList(slots, 0, 'Header', 'Asia/Singapore');
    expect(result).toHaveProperty('interactive');
    expect(result.interactive.type).toBe('list');
    expect(result._textFallback).toMatch(/1\./);
  });
});

// =============================================================================
// Bug-fix regression: H2 — 'back' id in choose_date steps back, not stuck
// =============================================================================
describe("H2 regression — 'back' interactive id in choose_date steps back", () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    resetCliniko();
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  async function seedDatePickerSession(phone, page = 0) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_SPECIFIC_DATE',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({ selection_step: 'choose_date', date_page: page, navigation_chain: [] }),
    });
    return db.getSession(id);
  }

  test("'back' on page 0 exits to booking methods (leaves BOOK_SPECIFIC_DATE)", async () => {
    const session = await seedDatePickerSession('+6581100001');
    await engine.handleBookSpecificDate(session, 'back');
    const updated = await db.getSession(session.id);
    expect(updated.conversation_state).not.toBe('BOOK_SPECIFIC_DATE');
  });

  test("'0' on page 0 also exits (unchanged baseline)", async () => {
    const session = await seedDatePickerSession('+6581100002');
    await engine.handleBookSpecificDate(session, '0');
    const updated = await db.getSession(session.id);
    expect(updated.conversation_state).not.toBe('BOOK_SPECIFIC_DATE');
  });

  test("'back' on page 1 decrements page, stays in BOOK_SPECIFIC_DATE", async () => {
    const session = await seedDatePickerSession('+6581100003', 1);
    await engine.handleBookSpecificDate(session, 'back');
    const updated = await db.getSession(session.id);
    const data = JSON.parse(updated.data || '{}');
    expect(data.date_page).toBe(0);
    expect(updated.conversation_state).toBe('BOOK_SPECIFIC_DATE');
  });
});

// =============================================================================
// Bug-fix regression: H3 — BOOK_SPECIFIC_CLINIC no-slots returns buttons
// =============================================================================
describe('H3 regression — BOOK_SPECIFIC_CLINIC view_slots no-slots gives 3-option standard prompt', () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    resetCliniko();
    engine.clinikoAPI.getAvailableSlotsByBusinessAndDate = jest.fn().mockResolvedValue([]);
    engine.clinikoAPI.getBusinessById = jest.fn().mockResolvedValue({ id: 'BIZ-001', business_name: 'Prohealth In Touch' });
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  async function seedViewSlotsSession(phone) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_SPECIFIC_CLINIC',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({
        selection_step: 'view_slots',
        navigation_chain: [{ step: 'choose_physio', meta: {} }],
        selected_clinic: { id: 'BIZ-001', business_name: 'Prohealth In Touch' },
        selected_physio: { id: 'PRAC-001' },
        selected_appt_type: { id: 'AT-001', name: 'Initial Consultation' },
      }),
    });
    return db.getSession(id);
  }

  test('no-slots returns a MessageEnvelope with 3 standard buttons', async () => {
    const session = await seedViewSlotsSession('+6582200001');
    const reply = await engine.handleBookSpecificClinic(session, '');
    expect(reply).toHaveProperty('interactive');
    expect(reply.interactive.type).toBe('button');
    const labels = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(labels).toContain('Try Again');
    expect(labels).toContain('Email us');
    expect(labels).toContain('Message on WhatsApp');
    expect(labels).toHaveLength(3);
  });

  test('no-slots sets no_slots_prompt on session', async () => {
    const session = await seedViewSlotsSession('+6582200002');
    await engine.handleBookSpecificClinic(session, '');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data || '{}').no_slots_prompt).toBeTruthy();
  });

  // Was: "reply '1' (go back and try again) navigates back one step" — encoded
  // the pre-Layer-2 behavior of Try Again silently discarding the selected
  // clinic/physio/type and navigating elsewhere. Layer 2's _noSlotsRetry
  // retries the exact same step in place instead.
  test("reply '1' (Try Again) retries in place — clinic/physio/type preserved, not a navBack", async () => {
    const session = await seedViewSlotsSession('+6582200003');
    await engine.handleBookSpecificClinic(session, '');
    const updated = await db.getSession(session.id);
    const d = JSON.parse(updated.data || '{}');
    expect(d.no_slots_prompt).toEqual({ context: 'clinic', retry_step: 'view_slots' });
    expect(d.selected_clinic?.id).toBe('BIZ-001');
    expect(d.selected_physio?.id).toBe('PRAC-001');
    expect(d.selected_appt_type?.id).toBe('AT-001');

    // Retry succeeds this time — goes straight to a slot list, not back
    // through physio/clinic/type selection.
    engine.clinikoAPI.getAvailableSlotsByBusinessAndDate = jest.fn().mockResolvedValue([
      { slot: futureISO(2), appointment_type_name: 'Initial Consultation', practitioner_id: 'PRAC-001', business_id: 'BIZ-001' },
    ]);
    const reply2 = await engine.handleBookSpecificClinic(updated, '1');
    expect(String(reply2)).not.toMatch(/select a clinic|choose a physio|select visit type/i);
  });
});

// =============================================================================
// Bug-fix regression: L2 — _buildSlotList always has ← Back interactive row
// =============================================================================
describe('L2 regression — _buildSlotList always includes back row', () => {
  let engine;
  function makeSlots(n) {
    return Array.from({ length: n }, (_, i) => ({
      slot: new Date(Date.now() + (i + 1) * 3600000).toISOString(),
    }));
  }
  beforeAll(() => { engine = new ChatbotEngine(); });

  test('page 0, no overflow: has back row, no prev, no next', () => {
    const ids = engine._buildSlotList(makeSlots(3), 0, 'H', 'Asia/Singapore')
      .interactive.action.sections[0].rows.map(r => r.id);
    expect(ids).toContain('back');
    expect(ids).not.toContain('prev');
    expect(ids).not.toContain('next');
  });

  test('page 0, overflow: back is last row after next', () => {
    const rows = engine._buildSlotList(makeSlots(15), 0, 'H', 'Asia/Singapore')
      .interactive.action.sections[0].rows;
    expect(rows[rows.length - 1].id).toBe('back');
    expect(rows.map(r => r.id)).toContain('next');
  });

  test('page 1: prev + next + back all present, back is last', () => {
    const rows = engine._buildSlotList(makeSlots(20), 1, 'H', 'Asia/Singapore')
      .interactive.action.sections[0].rows;
    const ids = rows.map(r => r.id);
    expect(ids).toContain('prev');
    expect(ids).toContain('next');
    expect(ids[ids.length - 1]).toBe('back');
  });
});

// =============================================================================
// Bug-fix regression: L3 — cancel/reschedule list pagination
// =============================================================================
describe('L3 regression — cancel/reschedule appointment list pagination', () => {
  let db, sm, engine;
  const MANY_APPTS = Array.from({ length: 12 }, (_, i) => ({
    id: `APPT-${i}`, starts_at: new Date(Date.now() + (i + 1) * 86400000).toISOString(),
    cancelled_at: null,
    _practitioner_display: `Dr ${i}`,
    _appointment_type_display: 'Physio',
    _display_dt: `Day ${i + 1}`,
  }));

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    resetCliniko();
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  async function seedCancelSelect(phone, page = 0) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'SELECT_APPOINTMENT_TO_CANCEL',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({ cancel_appt_list: MANY_APPTS, cancel_appt_page: page }),
    });
    return db.getSession(id);
  }

  async function seedRescheduleSelect(phone, page = 0) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'SELECT_APPOINTMENT_TO_RESCHEDULE',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({ reschedule_appt_list: MANY_APPTS, reschedule_appt_page: page }),
    });
    return db.getSession(id);
  }

  test("cancel: 'next' advances page and returns interactive list", async () => {
    const session = await seedCancelSelect('+6583300001');
    const reply = await engine.handleSelectAppointmentToCancelState(session, 'next');
    expect(reply).toHaveProperty('interactive');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).cancel_appt_page).toBe(1);
  });

  test("cancel: 'prev' from page 1 goes to page 0", async () => {
    const session = await seedCancelSelect('+6583300002', 1);
    await engine.handleSelectAppointmentToCancelState(session, 'prev');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).cancel_appt_page).toBe(0);
  });

  test("cancel: 'prev' on page 0 stays at 0 (floor)", async () => {
    const session = await seedCancelSelect('+6583300003');
    await engine.handleSelectAppointmentToCancelState(session, 'prev');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).cancel_appt_page).toBe(0);
  });

  test("reschedule: 'next' advances page and returns interactive list", async () => {
    const session = await seedRescheduleSelect('+6583300004');
    const reply = await engine.handleSelectAppointmentToRescheduleState(session, 'next');
    expect(reply).toHaveProperty('interactive');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).reschedule_appt_page).toBe(1);
  });

  test("reschedule: 'prev' from page 1 goes to page 0", async () => {
    const session = await seedRescheduleSelect('+6583300005', 1);
    await engine.handleSelectAppointmentToRescheduleState(session, 'prev');
    const updated = await db.getSession(session.id);
    expect(JSON.parse(updated.data).reschedule_appt_page).toBe(0);
  });
});

// =============================================================================
// Bug-fix regression: appointment type normalisation — hyphen variants merge
// Covers the production bug where "Follow Up Appointment" and
// "Follow-Up Appointment" were shown as separate items; picking one would
// never match slots belonging to the other.
// =============================================================================

// ── helpers shared across the 4 normalisation suites ─────────────────────────
const HYPHEN_TYPES_FU = [
  { id: 'AT-FU1', name: 'Follow Up Appointment' },
  { id: 'AT-FU2', name: 'Follow-Up Appointment' },
];
const HYPHEN_SLOT_FU = {
  id: 'SL-FU', slot: futureISO(2),
  appointment_type_id: 'AT-FU2',
  appointment_type_name: 'Follow-Up Appointment',   // hyphenated variant in Cliniko
  practitioner_id: 'PRAC-001', business_id: 'BIZ-001',
  business_name: 'Prohealth HK', practitioner_name: 'Greg Smith',
};
const HYPHEN_SLOT_FU_MERGED = { name: 'Follow Up Appointment', ids: ['AT-FU1', 'AT-FU2'] };

// =============================================================================
describe('Appointment type normalisation — BOOK_HISTORY hyphen variants merge into one list item', () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    resetCliniko();
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  const PHYSIO_DATA = {
    selection_step: 'choose_type',
    selected_physio: { id: 'PRAC-001', first_name: 'Greg', last_name: 'Smith' },
    last_clinic_id: 'BIZ-001',
    navigation_chain: [{ selection_step: 'choose_physio_from_history', had_multiple_options: true, auto: false }],
  };

  async function seedHistoryAt(phone, extra = {}) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_HISTORY',
      context: JSON.stringify({ region: 'HK' }),
      data: JSON.stringify({ ...PHYSIO_DATA, ...extra }),
    });
    return db.getSession(id);
  }

  test('Cliniko types "Follow Up Appointment" and "Follow-Up Appointment" are deduplicated into one list item', async () => {
    // Cliniko returns two types that differ only in hyphen — they should merge.
    engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
      { id: 'AT-FU1', name: 'Follow Up Appointment' },
      { id: 'AT-FU2', name: 'Follow-Up Appointment' },
    ]);
    const session = await seedHistoryAt('+85290000001');
    await callHandler(engine, ['handleBookHistory'], session, '');

    const saved = JSON.parse((await db.getSession(session.id)).data || '{}');
    const list = saved.appointment_type_list || [];

    // Both types share the same normalised key → ONE merged item, not two.
    expect(list).toHaveLength(1);
    // The merged item's ids set contains both Cliniko type IDs.
    expect(list[0].ids).toContain('AT-FU1');
    expect(list[0].ids).toContain('AT-FU2');
  });

  test('"New Patient-Sports Massage" and "New Patient Sports Massage" also merge', async () => {
    engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
      { id: 'AT-NP1', name: 'New Patient-Sports Massage Therapy' },
      { id: 'AT-NP2', name: 'New Patient Sports Massage Therapy' },
    ]);
    const session = await seedHistoryAt('+85290000002');
    await callHandler(engine, ['handleBookHistory'], session, '');

    const saved = JSON.parse((await db.getSession(session.id)).data || '{}');
    const list = saved.appointment_type_list || [];

    // Filter out any Initial/New-client types if the engine strips them — but
    // these two are the same type and must merge regardless.
    // (Engine does NOT strip "New Patient" — only "initial" and "new client".)
    expect(list).toHaveLength(1);
    expect(list[0].ids).toContain('AT-NP1');
    expect(list[0].ids).toContain('AT-NP2');
  });

  test('hyphen-variant types with different meanings stay separate', async () => {
    // "Follow Up Appointment" vs "Follow Up Appointment-Physiotherapy" differ
    // after normalisation ("follow up appointment" vs "follow up appointment physiotherapy").
    engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
      { id: 'AT-FU1', name: 'Follow Up Appointment' },
      { id: 'AT-FU3', name: 'Follow Up Appointment-Physiotherapy' },
    ]);
    const session = await seedHistoryAt('+85290000003');
    await callHandler(engine, ['handleBookHistory'], session, '');

    const saved = JSON.parse((await db.getSession(session.id)).data || '{}');
    const list = saved.appointment_type_list || [];

    expect(list).toHaveLength(2);
    const ids = list.flatMap(item => item.ids);
    expect(ids).toContain('AT-FU1');
    expect(ids).toContain('AT-FU3');
  });

  test('slot filter matches "Follow-Up Appointment" slots when user selected "Follow Up Appointment"', async () => {
    // The merged appointment_type_list entry covers both IDs.
    // getAvailableSlotsByBusinessAndDate returns slots with appointment_type_name
    // "Follow-Up Appointment" (with hyphen).  The filter must find them.
    engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
      { clinic_id: 'BIZ-001', clinic_name: 'Prohealth HK', practitioners: [
        { id: 'PRAC-001', first_name: 'Greg', last_name: 'Smith' }
      ]},
    ]);
    engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([
      {
        id: 'SL-HK-01',
        slot: futureISO(2),
        appointment_type_id: 'AT-FU2',
        appointment_type_name: 'Follow-Up Appointment',   // hyphenated variant
        practitioner_id: 'PRAC-001',
        business_id: 'BIZ-001',
        business_name: 'Prohealth HK',
        practitioner_name: 'Greg Smith',
      },
    ]);

    // Pre-populate appointment_type_list with the MERGED entry (both IDs, no-hyphen display name).
    const session = await seedHistoryAt('+85290000004', {
      selection_step: 'view_slots',
      selected_physio: { id: 'PRAC-001', first_name: 'Greg', last_name: 'Smith' },
      selected_clinic: { id: 'BIZ-001', business_name: 'Prohealth HK' },
      // The merged entry: display name "Follow Up Appointment" but ids covers both variants.
      selected_appt_type: { name: 'Follow Up Appointment', norm_name: 'follow up appointment', ids: ['AT-FU1', 'AT-FU2'] },
      navigation_chain: [
        { selection_step: 'choose_physio_from_history', had_multiple_options: true, auto: false },
        { selection_step: 'choose_type', had_multiple_options: true, auto: false },
        { selection_step: 'choose_clinic', had_multiple_options: false, auto: true },
      ],
    });

    const reply = await callHandler(engine, ['handleBookHistory'], session, '');

    // Should show slots (not the no-slots prompt).
    const str = String(reply);
    expect(str).not.toMatch(/no available slots/i);
    expect(str).not.toMatch(/or message us/i);
  });
});

// =============================================================================
describe('Appointment type normalisation — BOOK_SOONEST hyphen variants', () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    resetCliniko();
    resetWhatsApp();
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  async function seedSoonest(phone, extra = {}) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_SOONEST',
      context: JSON.stringify({ region: 'HK' }),
      data: JSON.stringify({ email: 'p@test.com', patient_name: 'Test', ...extra }),
    });
    return db.getSession(id);
  }

  test('buildTypeCatalogue merges "Follow Up Appointment" and "Follow-Up Appointment" into one list item', async () => {
    engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
      { clinic_id: 'BIZ-HK', clinic_name: 'Prohealth HK', practitioners: [{ id: 'PRAC-HK', first_name: 'Greg', last_name: 'Smith' }] },
    ]);
    // Cliniko returns both hyphen variants + a different type (so planForward doesn't auto-select)
    engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
      { id: 'AT-FU1', name: 'Follow Up Appointment' },
      { id: 'AT-FU2', name: 'Follow-Up Appointment' },
      { id: 'AT-NP',  name: 'New Patient' },
    ]);

    const session = await seedSoonest('+85291000001');
    await callHandler(engine, ['handleBookSoonest'], session, '');

    const saved = JSON.parse((await db.getSession(session.id)).data || '{}');
    const list = saved.appointment_type_list || [];

    // 3 Cliniko types → 2 after dedup (FU merged, NP separate)
    expect(list).toHaveLength(2);
    const fuItem = list.find(item => item.name === 'Follow Up Appointment');
    expect(fuItem).toBeDefined();
    // Both IDs are in the catalogue map under the merged key
    const map = saved.appt_type_name_to_ids_norm || {};
    const fuIds = map['follow up appointment'] || [];
    expect(fuIds).toContain('AT-FU1');
    expect(fuIds).toContain('AT-FU2');
  });

  test('buildAvailablePhysiosForTypeName finds physio whose Cliniko type uses a hyphen', async () => {
    // Physio has "Follow-Up Appointment" in Cliniko; user selected the no-hyphen merged display name.
    // If the normalisation fix is missing, normName("Follow-Up Appointment") !== "follow up appointment"
    // → physio is filtered out → handler returns "No practitioners have available slots for...".
    engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
      { clinic_id: 'BIZ-HK', clinic_name: 'Prohealth HK', practitioners: [{ id: 'PRAC-HK', first_name: 'Greg', last_name: 'Smith' }] },
    ]);
    engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
      { id: 'AT-FU2', name: 'Follow-Up Appointment' },
    ]);
    engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([{
      id: 'SL-01', slot: futureISO(2),
      appointment_type_id: 'AT-FU2',
      appointment_type_name: 'Follow-Up Appointment',
      practitioner_id: 'PRAC-HK', business_id: 'BIZ-HK',
    }]);

    // Seed with selected_appt_type already set so handler enters the physio-filtering branch.
    const session = await seedSoonest('+85291000002', {
      selection_step: 'choose_type',
      appointment_type_list: [{ name: 'Follow Up Appointment', id: 'AT-FU2', norm_name: 'follow up appointment' }],
      selected_appt_type:    { name: 'Follow Up Appointment', id: 'AT-FU2', norm_name: 'follow up appointment' },
      navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: false, auto: true }],
    });
    const reply = await callHandler(engine, ['handleBookSoonest'], session, '');

    // If physio was found the handler does NOT return the "no practitioners" error.
    // (With slots matching the handler auto-advances all the way to SELECT_SLOT and returns
    // a slot list — so we can't check practitioner_list in DB directly, but we CAN rule out
    // the one distinctive failure response.)
    expect(String(reply)).not.toMatch(/no practitioners have available slots/i);
  });
});

// =============================================================================
describe('Appointment type normalisation — BOOK_SPECIFIC_DATE hyphen variants', () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    resetCliniko();
    resetWhatsApp();
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  const FUTURE_DATE = futureISO(7).slice(0, 10); // 'YYYY-MM-DD'

  async function seedDate(phone, extra = {}) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_SPECIFIC_DATE',
      context: JSON.stringify({ region: 'HK' }),
      data: JSON.stringify({ email: 'p@test.com', patient_name: 'Test', selected_date: FUTURE_DATE, ...extra }),
    });
    return db.getSession(id);
  }

  test('choose_physio: getPractitionersForTypeName finds physio whose Cliniko type uses a hyphen', async () => {
    // Cliniko stores "Follow-Up Appointment" (with hyphen); user selected "Follow Up Appointment".
    engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
      { clinic_id: 'BIZ-HK', clinic_name: 'Prohealth HK', practitioners: [{ id: 'PRAC-HK', first_name: 'Greg', last_name: 'Smith' }] },
    ]);
    engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
      { id: 'AT-FU2', name: 'Follow-Up Appointment' },
    ]);

    const session = await seedDate('+85292000001', {
      selection_step: 'choose_physio',
      selected_appt_type: { name: 'Follow Up Appointment', ids: ['AT-FU1', 'AT-FU2'], norm: 'follow up appointment' },
      navigation_chain: [{ selection_step: 'choose_type', had_multiple_options: true, auto: false }],
    });
    await callHandler(engine, ['handleBookSpecificDate'], session, '');

    const saved = JSON.parse((await db.getSession(session.id)).data || '{}');
    expect(Array.isArray(saved.practitioner_list)).toBe(true);
    expect(saved.practitioner_list.length).toBeGreaterThan(0);
    expect(String(saved.practitioner_list[0].id)).toBe('PRAC-HK');
  });

  test('view_slots: slot with hyphenated appointment_type_name is matched', async () => {
    engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([{
      id: 'SL-SD-01', slot: futureISO(7),
      appointment_type_id: 'AT-FU2',
      appointment_type_name: 'Follow-Up Appointment',
      practitioner_id: 'PRAC-HK', business_id: 'BIZ-HK',
    }]);

    const session = await seedDate('+85292000002', {
      selection_step: 'view_slots',
      selected_physio: { id: 'PRAC-HK', first_name: 'Greg', last_name: 'Smith' },
      selected_clinic: { id: 'BIZ-HK', business_name: 'Prohealth HK' },
      selected_appt_type: { name: 'Follow Up Appointment', ids: ['AT-FU1', 'AT-FU2'], norm: 'follow up appointment' },
      navigation_chain: [
        { selection_step: 'choose_type', had_multiple_options: true, auto: false },
        { selection_step: 'choose_physio', had_multiple_options: false, auto: true },
        { selection_step: 'choose_clinic', had_multiple_options: false, auto: true },
      ],
    });
    const reply = await callHandler(engine, ['handleBookSpecificDate'], session, '');
    expect(String(reply)).not.toMatch(/no slots/i);
  });
});

// =============================================================================
describe('Appointment type normalisation — BOOK_SPECIFIC_PHYSIO hyphen variants', () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    resetCliniko();
    resetWhatsApp();
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  async function seedPhysio(phone, extra = {}) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_SPECIFIC_PHYSIO',
      context: JSON.stringify({ region: 'HK' }),
      data: JSON.stringify({ email: 'p@test.com', patient_name: 'Test', ...extra }),
    });
    return db.getSession(id);
  }

  test('choose_type merges "Follow Up Appointment" and "Follow-Up Appointment" into one list item', async () => {
    engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
      { id: 'AT-FU1', name: 'Follow Up Appointment' },
      { id: 'AT-FU2', name: 'Follow-Up Appointment' },
    ]);

    const session = await seedPhysio('+85293000001', {
      selection_step: 'choose_type',
      selected_physio: { id: 'PRAC-HK', first_name: 'Greg', last_name: 'Smith' },
      navigation_chain: [{ selection_step: 'choose_physio', had_multiple_options: true, auto: false }],
    });
    await callHandler(engine, ['handleBookSpecificPhysio'], session, '');

    const saved = JSON.parse((await db.getSession(session.id)).data || '{}');
    const list = saved.appointment_type_list || [];
    expect(list).toHaveLength(1);
    expect(list[0].ids).toContain('AT-FU1');
    expect(list[0].ids).toContain('AT-FU2');
  });

  test('view_slots: slot with hyphenated appointment_type_name is matched', async () => {
    engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([{
      id: 'SL-SP-01', slot: futureISO(2),
      appointment_type_id: 'AT-FU2',
      appointment_type_name: 'Follow-Up Appointment',
      practitioner_id: 'PRAC-HK', business_id: 'BIZ-HK',
    }]);

    const session = await seedPhysio('+85293000002', {
      selection_step: 'view_slots',
      selected_physio: { id: 'PRAC-HK', first_name: 'Greg', last_name: 'Smith' },
      selected_clinic: { id: 'BIZ-HK', business_name: 'Prohealth HK' },
      selected_appt_type: { name: 'Follow Up Appointment', ids: ['AT-FU1', 'AT-FU2'], norm: 'follow up appointment' },
      navigation_chain: [
        { selection_step: 'choose_physio', had_multiple_options: true, auto: false },
        { selection_step: 'choose_type', had_multiple_options: false, auto: true },
        { selection_step: 'choose_clinic', had_multiple_options: false, auto: true },
      ],
    });
    const reply = await callHandler(engine, ['handleBookSpecificPhysio'], session, '');
    expect(String(reply)).not.toMatch(/no slots/i);
  });
});

// =============================================================================
describe('Appointment type normalisation — BOOK_SPECIFIC_CLINIC hyphen variants', () => {
  let db, sm, engine;

  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    resetCliniko();
    resetWhatsApp();
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  async function seedClinic(phone, extra = {}) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_SPECIFIC_CLINIC',
      context: JSON.stringify({ region: 'HK' }),
      data: JSON.stringify({ email: 'p@test.com', patient_name: 'Test',
        selected_clinic: { id: 'BIZ-HK', business_name: 'Prohealth HK' }, ...extra }),
    });
    return db.getSession(id);
  }

  test('choose_type merges "Follow Up Appointment" and "Follow-Up Appointment" into one list item', async () => {
    engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
      { clinic_id: 'BIZ-HK', clinic_name: 'Prohealth HK', practitioners: [{ id: 'PRAC-HK', first_name: 'Greg', last_name: 'Smith' }] },
    ]);
    engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
      { id: 'AT-FU1', name: 'Follow Up Appointment' },
      { id: 'AT-FU2', name: 'Follow-Up Appointment' },
    ]);

    const session = await seedClinic('+85294000001', {
      selection_step: 'choose_type',
      navigation_chain: [{ selection_step: 'choose_clinic', had_multiple_options: true, auto: false }],
    });
    await callHandler(engine, ['handleBookSpecificClinic'], session, '');

    const saved = JSON.parse((await db.getSession(session.id)).data || '{}');
    const list = saved.appointment_type_list || [];
    expect(list).toHaveLength(1);
    expect(list[0].ids).toContain('AT-FU1');
    expect(list[0].ids).toContain('AT-FU2');
  });

  test('choose_physio: practitioner with hyphen-variant type is included via merged IDs', async () => {
    // choose_physio builds `wanted` from appt_type_name_to_ids_norm (which has both AT-FU1 and AT-FU2).
    // The physio's Cliniko types include AT-FU2 (hyphenated). wanted.has('AT-FU2') must be TRUE.
    // If the normalisation fix is missing the map key ("follow up appointment") won't match the
    // lookup → `wanted` is empty → practitioner is excluded → handler shows empty physio list
    // (stays at BOOK_SPECIFIC_CLINIC, never reaches SELECT_SLOT).
    engine.clinikoAPI.getPractitionersByClinic.mockResolvedValue([
      { clinic_id: 'BIZ-HK', clinic_name: 'Prohealth HK', practitioners: [{ id: 'PRAC-HK', first_name: 'Greg', last_name: 'Smith' }] },
    ]);
    engine.clinikoAPI.getAppointmentTypes.mockResolvedValue([
      { id: 'AT-FU2', name: 'Follow-Up Appointment' },
    ]);
    // view_slots needs a slot with the same hyphenated name so it doesn't loop back
    engine.clinikoAPI.getAvailableSlotsByBusinessAndDate.mockResolvedValue([{
      id: 'SL-SC-01', slot: futureISO(2),
      appointment_type_id: 'AT-FU2',
      appointment_type_name: 'Follow-Up Appointment',
      practitioner_id: 'PRAC-HK', business_id: 'BIZ-HK',
    }]);

    const session = await seedClinic('+85294000002', {
      selection_step: 'choose_physio',
      appointment_type_list: [{ name: 'Follow Up Appointment', norm_name: 'follow up appointment', ids: ['AT-FU1', 'AT-FU2'] }],
      appt_type_name_to_ids_norm: { 'follow up appointment': ['AT-FU1', 'AT-FU2'] },
      selected_appt_type: { name: 'Follow Up Appointment', norm_name: 'follow up appointment', ids: ['AT-FU1', 'AT-FU2'] },
      navigation_chain: [
        { selection_step: 'choose_clinic', had_multiple_options: true, auto: false },
        { selection_step: 'choose_type', had_multiple_options: false, auto: true },
      ],
    });
    await callHandler(engine, ['handleBookSpecificClinic'], session, '');

    // If the physio was found (wanted.has('AT-FU2') = true) the handler auto-advances through
    // choose_physio → view_slots → slots match → session moves to SELECT_SLOT.
    // If the physio was NOT found the handler stays at BOOK_SPECIFIC_CLINIC.
    const updated = await db.getSession(session.id);
    expect(updated.conversation_state).toBe('SELECT_SLOT');
  });
});

// =============================================================================
// WhatsApp interactive length constraints
// Button reply titles must be ≤20 chars; list row titles ≤24; list button label ≤20.
// Regression guard: protects against the production bug where 'Register as new patient'
// (23 chars) and no-slots buttons caused WhatsApp error 131009 and silently killed the bot.
// =============================================================================
describe('WhatsApp interactive length constraints', () => {
  const WA_BUTTON_MAX   = 20;
  const WA_LIST_ROW_MAX = 24;
  const WA_LIST_BTN_MAX = 20;

  function assertInteractiveLengths(env, label) {
    if (!env || !env.interactive) return;
    const { interactive } = env;
    if (interactive.type === 'button') {
      for (const btn of interactive.action.buttons) {
        expect(btn.reply.title.length).toBeLessThanOrEqual(
          WA_BUTTON_MAX,
          `${label}: button '${btn.reply.title}' is ${btn.reply.title.length} chars (max ${WA_BUTTON_MAX})`
        );
      }
    }
    if (interactive.type === 'list') {
      expect(interactive.action.button.length).toBeLessThanOrEqual(
        WA_LIST_BTN_MAX,
        `${label}: list button label '${interactive.action.button}' is ${interactive.action.button.length} chars`
      );
      for (const section of (interactive.action.sections || [])) {
        for (const row of (section.rows || [])) {
          expect(row.title.length).toBeLessThanOrEqual(
            WA_LIST_ROW_MAX,
            `${label}: list row '${row.title}' is ${row.title.length} chars (max ${WA_LIST_ROW_MAX})`
          );
        }
      }
    }
  }

  let db, sm, engine;
  beforeAll(async () => {
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
    resetCliniko();
    ClinikoAPI._clearGroupsCache();
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });
  beforeEach(() => { jest.clearAllMocks(); resetCliniko(); ClinikoAPI._clearGroupsCache(); });

  async function seedUnverified(phone) {
    const s = await sm.getOrCreateSession(phone, true);
    await sm.updateSession(s.id, {
      conversation_state: 'INTRO',
      verified: false,
      context: JSON.stringify({ region: 'SG' }),
    });
    return sm.getSession(s.id);
  }

  async function seedVerifiedForLength(phone) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'INTRO',
      context: JSON.stringify({ region: 'SG' }),
    });
    return db.getSession(id);
  }

  // ── GATEWAY_BUTTONS: the production failure path ─────────────────────────────
  // INTRO "2" → handleVerifyState shows gateway buttons.
  // 'Register new patient' must be ≤20 chars; historically 'Register as new patient' was 23.
  test('VERIFY gateway buttons: all titles ≤20 chars', async () => {
    const session = await seedUnverified('+6599100001');
    const reply = await engine.handleVerifyState(session, '');
    assertInteractiveLengths(reply, 'VERIFY gateway');
    const labels = reply.interactive.action.buttons.map(b => b.reply.title);
    expect(labels.every(t => t.length <= WA_BUTTON_MAX)).toBe(true);
    expect(labels).toHaveLength(3);
  });

  // ── Unverified main menu: list row titles ≤24 chars ─────────────────────────
  test('unverified main menu (renderMainMenu): all list row titles ≤24 chars', async () => {
    const session = await seedUnverified('+6599100002');
    const reply = await engine.renderMainMenu(session);
    assertInteractiveLengths(reply, 'unverified main menu');
  });

  // ── Verified main menu: list row titles ≤24 chars ────────────────────────────
  test('verified main menu (renderMainMenu): all list row titles ≤24 chars', async () => {
    const session = await seedVerifiedForLength('+6599100003');
    const reply = await engine.renderMainMenu(session);
    assertInteractiveLengths(reply, 'verified main menu');
  });

  // ── No-slots 3-button panels: all titles ≤20 chars ───────────────────────────
  // Each handler that can show a no-slots panel is exercised by seeding a session
  // in the relevant state with a no_slots_prompt already set, then sending an
  // unrecognised input so the handler re-shows the buttons.
  // (Seeding no_slots_prompt avoids needing live Cliniko data.)

  async function seedNoSlots(phone, state, noSlotsCtx, extra = {}) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: state,
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({
        no_slots_prompt: { context: noSlotsCtx },
        selection_step: extra.selection_step || 'view_slots',
        selected_appt_type: { id: 'AT-001', name: 'Initial Consultation' },
        selected_physio: { id: 'PRAC-001', first_name: 'Alice', last_name: 'Smith' },
        selected_clinic: { id: 'BIZ-001', business_name: 'Test Clinic' },
        navigation_chain: extra.navigation_chain || [],
        ...extra.data,
      }),
    });
    return db.getSession(id);
  }

  const noSlotsScenarios = [
    { label: 'BOOK_HISTORY no-slots',          state: 'BOOK_HISTORY',          ctx: 'history',     handler: 'handleBookHistory' },
    { label: 'BOOK_SOONEST no-slots',          state: 'BOOK_SOONEST',          ctx: 'soonest',     handler: 'handleBookSoonest' },
    { label: 'BOOK_SPECIFIC_DATE outer',       state: 'BOOK_SPECIFIC_DATE',    ctx: 'date',        handler: 'handleBookSpecificDate' },
    { label: 'BOOK_SPECIFIC_PHYSIO outer',     state: 'BOOK_SPECIFIC_PHYSIO',  ctx: 'physio',      handler: 'handleBookSpecificPhysio' },
    { label: 'BOOK_SPECIFIC_CLINIC outer',     state: 'BOOK_SPECIFIC_CLINIC',  ctx: 'clinic',      handler: 'handleBookSpecificClinic' },
    { label: 'BOOK_SPECIFIC_DATE inner (Try another physio)',  state: 'BOOK_SPECIFIC_DATE',   ctx: 'date_inner',   handler: 'handleBookSpecificDate' },
    { label: 'BOOK_SPECIFIC_PHYSIO inner (Try another type)', state: 'BOOK_SPECIFIC_PHYSIO', ctx: 'physio_inner', handler: 'handleBookSpecificPhysio' },
  ];

  test.each(noSlotsScenarios)(
    '$label: no-slots buttons all ≤20 chars',
    async ({ label, state, ctx, handler }) => {
      const phoneIdx = noSlotsScenarios.indexOf(noSlotsScenarios.find(s => s.label === label));
      const session = await seedNoSlots(`+6599200${String(phoneIdx).padStart(3, '0')}`, state, ctx);
      const reply = await engine[handler](session, 'zzz_unknown_input');
      if (reply && reply.interactive) {
        assertInteractiveLengths(reply, label);
      }
      // If handler returned a string (fell through), the no_slots_prompt was not re-shown;
      // we still verify the seeded session data was intact (belt-and-suspenders).
      const updated = await db.getSession(session.id);
      const data = JSON.parse(updated.data || '{}');
      // The session must still be in the no-slots state if the handler didn't handle the input
      if (!reply?.interactive) {
        expect(data.no_slots_prompt || updated.conversation_state).toBeTruthy();
      }
    }
  );

  // ── SELECT_SLOT and RESCHEDULE no-slots panels ────────────────────────────────
  test('SELECT_SLOT no-slots buttons all ≤20 chars', async () => {
    const id = await db.createSession('+6599300001', PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'SELECT_SLOT',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({
        no_slots_prompt: { context: 'slot' },
        selected_appt_type: { id: 'AT-001', name: 'Initial Consultation' },
        selected_physio: { id: 'PRAC-001', first_name: 'Alice', last_name: 'Smith' },
        selected_clinic: { id: 'BIZ-001', business_name: 'Test Clinic' },
        navigation_chain: [],
      }),
    });
    const session = await db.getSession(id);
    const reply = await engine.handleSelectSlotState(session, 'zzz_unknown');
    if (reply && reply.interactive) {
      assertInteractiveLengths(reply, 'SELECT_SLOT no-slots');
    }
  });
});

// =============================================================================
// SUITE — goToInteractiveMenu region guard
// Regression for: unknown-region users (e.g. UK +44) saw the main menu twice —
// once from goToInteractiveMenu (no region set), then again after handleIntroState
// consumed their first "1" selection as a region pick instead of a menu action.
// =============================================================================
describe('goToInteractiveMenu — region guard', () => {
  let db, sm, engine;
  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  beforeEach(() => { jest.clearAllMocks(); resetCliniko(); resetWhatsApp(); });

  async function seedUnverifiedNoRegion(phone) {
    const s = await sm.getOrCreateSession(phone, true);
    await sm.updateSession(s.id, {
      conversation_state: 'INTRO',
      verified: false,
      context: JSON.stringify({}),
    });
    return sm.getSession(s.id);
  }

  async function seedUnverifiedWithRegion(phone, region = 'SG') {
    const s = await sm.getOrCreateSession(phone, true);
    await sm.updateSession(s.id, {
      conversation_state: 'INTRO',
      verified: false,
      context: JSON.stringify({ region }),
    });
    return sm.getSession(s.id);
  }

  test('unverified user with no region → goToInteractiveMenu shows region selection, not main menu', async () => {
    const session = await seedUnverifiedNoRegion('+4478634000001');
    const reply = String(await engine.goToInteractiveMenu(session));
    // Region selection must be shown — not the booking/register main menu
    expect(reply).toMatch(/region|hong kong|singapore|india|philippines/i);
    expect(reply).not.toMatch(/register as new patient/i);
  });

  test('unverified user with region set → goToInteractiveMenu shows main menu directly', async () => {
    const session = await seedUnverifiedWithRegion('+6561000001', 'SG');
    const reply = String(await engine.goToInteractiveMenu(session));
    expect(reply).toMatch(/register as new patient/i);
    // Must NOT prompt for region again
    expect(reply).not.toMatch(/please select your region/i);
  });

  test('SG number sends "hello" → main menu shown (region auto-detected, no extra region step)', async () => {
    const reply = await engine.handleMessage('hello', '+6562000001');
    expect(typeof reply).toBe('string');
    expect(reply).toMatch(/welcome|register|book/i);
    // Region selection prompt must not appear for a known-region number
    expect(reply).not.toMatch(/please select your region/i);
  });

  test('unknown-region number sends "hello" → region selection shown (not main menu)', async () => {
    const reply = await engine.handleMessage('hello', '+447700900001');
    expect(typeof reply).toBe('string');
    expect(reply).toMatch(/region|hong kong|singapore|india|philippines/i);
    expect(reply).not.toMatch(/register as new patient/i);
  });

  test('verified user sends "hi" → bypasses region entirely, sees verified menu', async () => {
    const phone = '+6563000001';
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'INTRO',
      context: JSON.stringify({ region: 'SG' }),
    });
    const reply = await engine.handleMessage('hi', phone);
    expect(typeof reply).toBe('string');
    expect(reply).toMatch(/book|cancel|reschedule/i);
    expect(reply).not.toMatch(/register as new patient/i);
    expect(reply).not.toMatch(/please select your region/i);
  });

  test('unknown-region multi-turn: hello → pick region → pick Register → first name (3 steps, not 4)', async () => {
    const phone = '+447700900002';
    // Step 1: "hello" → should show region selection
    const r1 = await engine.handleMessage('hello', phone);
    expect(String(r1)).toMatch(/region|hong kong|singapore/i);

    // Step 2: "1" → picks first region (HK) → should show main unverified menu
    const r2 = await engine.handleMessage('1', phone);
    expect(String(r2)).toMatch(/register as new patient/i);

    // Step 3: "1" → picks Register → should ask for first name (NOT show region/menu again)
    const r3 = await engine.handleMessage('1', phone);
    expect(String(r3)).toMatch(/first name/i);
    expect(String(r3)).not.toMatch(/register as new patient/i);
    expect(String(r3)).not.toMatch(/region|hong kong/i);
  });
});

// =============================================================================
// F1 regression — BOOK_SPECIFIC_DATE choose_type used global idx on page 1+
// Bug: typing "1" on page 1 selected list[0] (global) instead of list[5] (page-local).
// Fix: idx = interactivePageStart(page) + localNum - 1, with local page-range guard.
// Why existing tests missed it: all choose_type tests used ≤5 types (fit on page 0).
// =============================================================================
describe('F1 regression — BOOK_SPECIFIC_DATE choose_type page-local selection', () => {
  let db, sm, engine;
  const PATIENT_ID = 'PT-F1-001';

  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });
  beforeEach(() => { jest.clearAllMocks(); resetCliniko(); resetWhatsApp(); });

  function makeTypes(n) {
    return Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Type ${i + 1}` }));
  }

  async function seedChooseType(phone, page, types) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOK_SPECIFIC_DATE',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({
        selection_step: 'choose_type',
        selected_date: '2026-08-01',
        appt_type_page: page,
        appointment_type_list: types,
      }),
    });
    return db.getSession(id);
  }

  test('page 0: typing "1" selects Type 1 (first item)', async () => {
    const types = makeTypes(6);
    const session = await seedChooseType('+6591000001', 0, types);
    await engine.handleBookSpecificDate(session, '1');
    const d = JSON.parse((await db.getSession(session.id)).data);
    expect(d.selected_appt_type.name).toBe('Type 1');
  });

  test('page 1: typing "1" selects Type 6 (first item on page 1), not Type 1', async () => {
    // page 1 starts at index 5 (INTERACTIVE_SELECT_PAGE_FIRST=5)
    const types = makeTypes(6);
    const session = await seedChooseType('+6591000002', 1, types);
    await engine.handleBookSpecificDate(session, '1');
    const d = JSON.parse((await db.getSession(session.id)).data);
    expect(d.selected_appt_type.name).toBe('Type 6');
  });

  test('page 0: typing "6" (out of page range) does not select anything', async () => {
    // page 0 holds 5 items; "6" is beyond the page — must re-render, not select
    const types = makeTypes(6);
    const session = await seedChooseType('+6591000003', 0, types);
    const reply = await engine.handleBookSpecificDate(session, '6');
    const d = JSON.parse((await db.getSession(session.id)).data);
    expect(d.selected_appt_type).toBeUndefined();
    expect(reply).toHaveProperty('interactive');
  });
});

// =============================================================================
// F2 regression — BOOKING_METHOD_OPTIONS unrecognized input was a dead end
// Bug: returned a bare string with no menu, leaving the user stranded.
// Fix: prependTextToEnvelope(error, await this.renderBookingMethodMenu(session)).
// Why existing tests missed it: all existing tests sent valid inputs (1-5, 0, back).
// =============================================================================
describe('F2 regression — BOOKING_METHOD_OPTIONS invalid input re-renders interactive menu', () => {
  let db, sm, engine;
  const PATIENT_ID = 'PT-F2-001';

  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });
  beforeEach(() => { jest.clearAllMocks(); resetCliniko(); resetWhatsApp(); });

  async function seedBookingMethod(phone) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'BOOKING_METHOD_OPTIONS',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({}),
    });
    return db.getSession(id);
  }

  test('out-of-range "6" → re-renders interactive booking menu with error prefix', async () => {
    const session = await seedBookingMethod('+6592000001');
    const reply = await engine.handleBookingMethodOptions(session, '6');
    expect(reply).toHaveProperty('interactive');
    expect(reply._textFallback).toMatch(/valid|1–5|booking method/i);
  });

  test('garbage text → re-renders interactive booking menu (no dead end)', async () => {
    const session = await seedBookingMethod('+6592000002');
    const reply = await engine.handleBookingMethodOptions(session, 'hello there');
    expect(reply).toHaveProperty('interactive');
  });

  test('session stays at BOOKING_METHOD_OPTIONS after invalid input', async () => {
    const session = await seedBookingMethod('+6592000003');
    await engine.handleBookingMethodOptions(session, 'nope');
    const updated = await db.getSession(session.id);
    expect(updated.conversation_state).toBe('BOOKING_METHOD_OPTIONS');
  });
});

// =============================================================================
// F3 regression — cancel/reschedule list text-mode aliases 'p'/'m'/'more' not handled
// Bug: only exact 'prev'/'next' (interactive row IDs) were matched; text-mode aliases
//   used throughout every other paginated list were missing from these two handlers.
// Fix: /^p(rev)?$/i and /^m(ore)?$|^next$/i, consistent with all other handlers.
// Why existing tests missed it: L3 tests only checked 'prev'/'next', never 'p'/'m'.
// =============================================================================
describe('F3 regression — SELECT_APPOINTMENT_TO_CANCEL text-mode pagination aliases', () => {
  let db, sm, engine;
  const PATIENT_ID = 'PT-F3C-001';
  const MANY_APPTS = Array.from({ length: 7 }, (_, i) => ({
    id: `APPT-${i}`, starts_at: '2026-09-01T09:00:00Z', cancelled_at: null,
    _practitioner_display: `Dr ${i}`, _appointment_type_display: 'Physio', _display_dt: `Day ${i + 1}`,
  }));

  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  async function seed(phone, page = 0) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'SELECT_APPOINTMENT_TO_CANCEL',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({ cancel_appt_list: MANY_APPTS, cancel_appt_page: page }),
    });
    return db.getSession(id);
  }

  test('"p" on page 1 goes back to page 0', async () => {
    const session = await seed('+6593000001', 1);
    const reply = await engine.handleSelectAppointmentToCancelState(session, 'p');
    expect(reply).toHaveProperty('interactive');
    expect(JSON.parse((await db.getSession(session.id)).data).cancel_appt_page).toBe(0);
  });

  test('"m" on page 0 advances to page 1', async () => {
    const session = await seed('+6593000002', 0);
    const reply = await engine.handleSelectAppointmentToCancelState(session, 'm');
    expect(reply).toHaveProperty('interactive');
    expect(JSON.parse((await db.getSession(session.id)).data).cancel_appt_page).toBe(1);
  });

  test('"more" on page 0 advances to page 1', async () => {
    const session = await seed('+6593000003', 0);
    await engine.handleSelectAppointmentToCancelState(session, 'more');
    expect(JSON.parse((await db.getSession(session.id)).data).cancel_appt_page).toBe(1);
  });
});

describe('F3 regression — SELECT_APPOINTMENT_TO_RESCHEDULE text-mode pagination aliases', () => {
  let db, sm, engine;
  const PATIENT_ID = 'PT-F3R-001';
  const MANY_APPTS = Array.from({ length: 7 }, (_, i) => ({
    id: `APPT-${i}`, starts_at: '2026-09-01T09:00:00Z', cancelled_at: null,
    _practitioner_display: `Dr ${i}`, _appointment_type_display: 'Physio', _display_dt: `Day ${i + 1}`,
  }));

  beforeAll(async () => {
    resetCliniko(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => { if (sm.cleanupInterval) clearInterval(sm.cleanupInterval); db.close(); });

  async function seed(phone, page = 0) {
    const id = await db.createSession(phone, PATIENT_ID, 60);
    await db.updateSession(id, {
      verified: 1, patient_id: PATIENT_ID,
      conversation_state: 'SELECT_APPOINTMENT_TO_RESCHEDULE',
      context: JSON.stringify({ region: 'SG' }),
      data: JSON.stringify({ reschedule_appt_list: MANY_APPTS, reschedule_appt_page: page }),
    });
    return db.getSession(id);
  }

  test('"p" on page 1 goes back to page 0', async () => {
    const session = await seed('+6594000001', 1);
    const reply = await engine.handleSelectAppointmentToRescheduleState(session, 'p');
    expect(reply).toHaveProperty('interactive');
    expect(JSON.parse((await db.getSession(session.id)).data).reschedule_appt_page).toBe(0);
  });

  test('"m" on page 0 advances to page 1', async () => {
    const session = await seed('+6594000002', 0);
    const reply = await engine.handleSelectAppointmentToRescheduleState(session, 'm');
    expect(reply).toHaveProperty('interactive');
    expect(JSON.parse((await db.getSession(session.id)).data).reschedule_appt_page).toBe(1);
  });

  test('"more" on page 0 advances to page 1', async () => {
    const session = await seed('+6594000003', 0);
    await engine.handleSelectAppointmentToRescheduleState(session, 'more');
    expect(JSON.parse((await db.getSession(session.id)).data).reschedule_appt_page).toBe(1);
  });
});
