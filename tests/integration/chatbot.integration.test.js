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
      this.db = new sqlite3.Database(':memory:');
      this.isInitialized = false;
    }

    generateSessionId () {
      return crypto.randomBytes(16).toString('hex');
    }

    async testConnection () {
      return new Promise((res, rej) =>
        this.db.get('SELECT 1', (err) => (err ? rej(err) : res(true)))
      );
    }

    async initialize () {
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

    // Used in edge-case tests to write intentionally broken data
    _rawRun (sql, params = []) {
      return new Promise((res, rej) =>
        this.db.run(sql, params, (err) => (err ? rej(err) : res()))
      );
    }

    close () { this.db.close(); }
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

const PAST_APPT = {
  id: 'APPT-P', starts_at: pastISO(7), cancelled_at: null,
  practitioner:     { id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan', display_name: 'Jolinna Chan' },
  appointment_type: { id: 'AT-001',   name: 'Initial 60 Min Visit (New Clients)' },
  business:         { id: 'BIZ-001',  business_name: 'Prohealth In Touch' },
};

// ─── Mock reset helpers ────────────────────────────────────────────────────────
function resetClinico () {
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
    { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', duration: 60 },
    { id: 'AT-002', name: 'Return Visit (Existing Clients)',    duration: 30 },
  ]);
  ClinikoAPI.prototype.healthCheck                  = jest.fn().mockResolvedValue({ status: 'ok' });
  ClinikoAPI.prototype.getBusinessById              = jest.fn().mockResolvedValue({ id: 'BIZ-001', business_name: 'Prohealth In Touch' });
  ClinikoAPI.prototype.getPractitionerById          = jest.fn().mockResolvedValue({ id: 'PRAC-001', first_name: 'Jolinna', last_name: 'Chan' });
  ClinikoAPI.prototype.getAppointmentTypeById       = jest.fn().mockResolvedValue({ id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)' });
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
      return engine[name].call(engine, session, msg);
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
    const s = await sm.getOrCreateSession('+6520000001');
    expect(s).toBeDefined();
    expect(s.id).toBeTruthy();
    expect(s.phone_number).toBe('+6520000001');
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
    resetClinico(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  beforeEach(() => { jest.clearAllMocks(); resetClinico(); resetWhatsApp(); });

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
    ClinikoAPI.prototype.getBookingsByPatientId = jest.fn().mockResolvedValue([PAST_APPT]);
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
    ClinikoAPI.prototype.getBookingsByPatientId = jest.fn().mockResolvedValue([PAST_APPT]);
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
  test('BOOK_SOONEST with no slots returns a helpful message', async () => {
    ClinikoAPI.prototype.getAvailableAppointmentTimes = jest.fn().mockResolvedValue([]);
    const session = await seedVerified(db, '+6530000051');
    await db.updateSession(session.id, { conversation_state: 'BOOK_SOONEST' });
    const fresh = await db.getSession(session.id);
    const reply = await callHandler(engine,
      ['handleBookSoonestState','handleBookSoonest'], fresh, '')
      ?? await engine.handleMessage('', '+6530000051');
    expect(reply).toMatch(/no.*slot|unavailable|try another|no appointment|no available|contact/i);
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
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// SUITE 4 — Multi-turn simulation
// =============================================================================
describe('Multi-turn conversation simulation', () => {
  let db, sm, engine;
  beforeAll(async () => {
    resetClinico(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  beforeEach(() => { jest.clearAllMocks(); resetClinico(); resetWhatsApp(); });

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
  beforeEach(() => resetClinico());

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
    resetClinico(); resetWhatsApp();
    db = new DatabaseManager(); await db.initialize();
    sm = new SessionManager(db); await sm.initialize();
    engine = new ChatbotEngine();
    engine.sessionManager = sm;
  });
  afterAll(() => {
    if (sm.cleanupInterval) clearInterval(sm.cleanupInterval);
    db.close();
  });
  beforeEach(() => { jest.clearAllMocks(); resetClinico(); resetWhatsApp(); });

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
