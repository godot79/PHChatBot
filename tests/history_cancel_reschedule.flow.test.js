#!/usr/bin/env node
/**
 * tests/history_cancel_reschedule.flow.test.js
 *
 * End‑to‑end-ish smoke tests for History → Select Slot, Cancel, and Reschedule flows
 * using in‑memory stubs. No network calls. Uses only existing handler entry points
 * and state transitions. Aligns with ChatbotEngine expectations:
 *  - SessionManager exposes getSession(id) and updateSession(id, patch)
 *  - History flow expects past booking with practitioner & business objects
 *  - Cancel/Reschedule flows enrich via URLs (engine calls enrichAppointmentsForDisplay)
 *  - Auto‑advance is allowed when only one option exists.
 *
 * Run: node tests/history_cancel_reschedule.flow.test.js
 */

// --- Resolve ChatbotEngine from typical project locations ---
let ChatbotEngine;
try { ChatbotEngine = require('../src/core/ChatbotEngine.js'); } catch (_) {}
try { if (!ChatbotEngine) ChatbotEngine = require('../ChatbotEngine.js'); } catch (_) {}
if (!ChatbotEngine) {
  console.error('Unable to require ChatbotEngine. Adjust require path.');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toTimeString().slice(0,8), ...a);
const isoZ = (d) => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,19) + 'Z';

// --- Minimal SessionManager stub with required API ---
class SessionStub {
  constructor() { this.store = new Map(); }
  async getSession(id) { return this.store.get(id) || { id, data: null }; }
  async updateSession(id, patch) {
    const cur = await this.getSession(id);
    const next = { ...cur, ...patch };
    this.store.set(id, next);
    return next;
  }
}

// --- ClinikoAPI stub covering methods used by the flows ---
class ClinikoStub {
  constructor() { this.calls = { cancel: [], update: [], times: [], slots: [] }; }

  // Engine asks for a mixed list; we return one past (object refs) and one future (URL refs)
  async getBookingsByPatientId(patientId) {
    const now = new Date();
    const past = new Date(now); past.setDate(past.getDate() - 7); past.setHours(9,0,0,0);
    const future = new Date(now); future.setDate(future.getDate() + 3); future.setHours(11,0,0,0);
    return [
      // Past appointment for History flow, uses embedded objects
      {
        id: 'PAST1',
        starts_at: isoZ(past),
        cancelled_at: null,
        patient_name: 'Test Patient',
        practitioner: { id: 'PRAC1', first_name: 'Jolinna', last_name: 'Chan', display_name: 'Jolinna Chan' },
        appointment_type: { id: 'TYP1', name: 'Initial 60 Min Visit (New Clients)' },
        business: { id: 'BIZ1', business_name: 'Prohealth In Touch Physiotherapy' }
      },
      // Future appointment for Cancel/Reschedule flows, uses URLs to exercise enrichment
      {
        id: 'FUT1',
        starts_at: isoZ(future),
        cancelled_at: null,
        patient_name: 'Test Patient',
        practitioner: 'https://api.cliniko.com/v1/practitioners/PRAC1',
        appointment_type: 'https://api.cliniko.com/v1/appointment_types/TYP1',
        business: 'https://api.cliniko.com/v1/businesses/BIZ1'
      }
    ];
  }

  // Lookups used by enrichAppointmentsForDisplay
  async getPractitionerById(id) { return { id, first_name: 'Jolinna', last_name: 'Chan' }; }
  async getAppointmentTypeById(id) { return { id, name: 'Initial 60 Min Visit (New Clients)' }; }
  async getBusinessById(id) { return { id, business_name: 'Prohealth In Touch Physiotherapy' }; }

  // Types for a practitioner (History flow)
  async getAppointmentTypes({ practitioner_id }) {
    if (String(practitioner_id) === 'PRAC1') {
      return [
        { id: 'TYP1', name: 'Initial 60 Min Visit (New Clients)' },
        { id: 'TYP1_DUP', name: 'Initial 60  Min  Visit  (New  Clients)' }, // duplicate after normalization
        { id: 'TYP2', name: 'Return Visit (Existing Clients)' }
      ];
    }
    return [];
  }

  // Slot sources the engine may call
  async getAvailableSlotsByBusinessAndDate({ business_id, practitioner_id, from, to }) {
    this.calls.slots.push({ business_id, practitioner_id, from, to });
    const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(11,0,0,0);
    return [
      {
        business_id: String(business_id || 'BIZ1'),
        practitioner_id: String(practitioner_id || 'PRAC1'),
        appointment_type_id: 'TYP1',
        appointment_type_name: 'Initial 60 Min Visit (New Clients)',
        slot: isoZ(t),
        business_name: 'Prohealth In Touch Physiotherapy',
        practitioner_name: 'Jolinna Chan'
      }
    ];
  }
  async getAvailableTimes({ practitioner_id, business_id, appt_type, from, to }) {
    this.calls.times.push({ practitioner_id, business_id, appt_type, from, to });
    const t1 = new Date(); t1.setDate(t1.getDate() + 1); t1.setHours(9,0,0,0);
    const t2 = new Date(); t2.setDate(t2.getDate() + 1); t2.setHours(10,0,0,0);
    return [ { appointment_start: isoZ(t1) }, { appointment_start: isoZ(t2) } ];
  }

  // Cancel / Reschedule
  async cancelSpecificAppointment(appointmentId) { this.calls.cancel.push({ appointmentId }); return { ok: true }; }
  async updateIndividualAppointment(appointmentId, payload) { this.calls.update.push({ appointmentId, payload }); return { ok: true }; }
}

(async () => {
  console.log('▶ Chatbot history/cancel/reschedule flow tests');

  // Engine + stubs
  const engine = new ChatbotEngine();
  const sessions = new SessionStub();
  const api = new ClinikoStub();
  engine.sessionManager = sessions; // inject stub
  engine.clinikoAPI = api;          // inject stub

  // Seed session
  const session = {
    id: 'sess1',
    phoneNumber: '+6500000000',
    verified: true,
    patient_id: 'PATIENT1',
    context: { region: 'SG' },
    data: null
  };

  // Helper to drive current state handler
  const step = async (msg = '') => {
    const cur = await sessions.getSession(session.id);
    session.data = cur.data; // keep local snapshot in sync
    const state = cur.conversation_state;
    const handler = engine.stateHandlers[state] || (state === engine.STATES.BOOK_HISTORY ? engine.handleBookHistory.bind(engine) : null);
    if (!handler) throw new Error('No handler for state ' + state);
    return handler(session, msg);
  };

  // ===== 1) History → types → slot =====
  try {
    await sessions.updateSession(session.id, { conversation_state: engine.STATES.BOOK_HISTORY, data: null });
    let out = await step('');
    if (!/Appointment types for/i.test(out)) throw new Error('Expected appointment types list');
    console.log('PASS - History shows types list');

    // Pick first type
    out = await step('1');
    // Next step may be inline slot list or transition to SELECT_SLOT. Accept either.
    const after = await sessions.getSession(session.id);
    if (after.conversation_state === engine.STATES.SELECT_SLOT) {
      const parsed = JSON.parse(after.data || '{}');
      if (!Array.isArray(parsed.slot_list) || parsed.slot_list.length === 0) throw new Error('Expected non-empty slot_list');
    }
    console.log('PASS - History advances to slots');
  } catch (e) {
    console.error('FAIL - History flow:', e.message || e);
    process.exitCode = 1;
  }

  // ===== 2) Cancel flow (supports auto-advance when only one upcoming) =====
  try {
    await sessions.updateSession(session.id, { conversation_state: engine.STATES.CANCEL_APPOINTMENT, data: null });
    let out = await step('');
    const s1 = await sessions.getSession(session.id);
    if (s1.conversation_state === engine.STATES.SELECT_APPOINTMENT_TO_CANCEL) {
      if (!/Your upcoming appointments/i.test(out)) throw new Error('Expected upcoming appointments list');
      console.log('PASS - Cancel lists upcoming appointments');
      out = await step('1'); // pick first
    } else if (s1.conversation_state === engine.STATES.CONFIRM_CANCEL) {
      if (!/confirm cancellation/i.test(out)) throw new Error('Expected confirmation prompt');
      console.log('PASS - Cancel auto-advanced to confirmation');
    } else {
      throw new Error('Unexpected state after cancel entry: ' + s1.conversation_state);
    }

    // Confirm cancellation
    out = await step('yes');
    if (api.calls.cancel.length !== 1 || api.calls.cancel[0].appointmentId !== 'FUT1') throw new Error('cancelSpecificAppointment not called with FUT1');
    console.log('PASS - Cancel calls API with correct appointment id');
  } catch (e) {
    console.error('FAIL - Cancel flow:', e.message || e);
    process.exitCode = 1;
  }

  // ===== 3) Reschedule flow (supports auto-advance when only one upcoming) =====
  try {
    await sessions.updateSession(session.id, { conversation_state: engine.STATES.RESCHEDULE_APPOINTMENT, data: null });
    let out = await step('');
    const s2 = await sessions.getSession(session.id);
    if (s2.conversation_state === engine.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE) {
      if (!/Your upcoming appointments/i.test(out)) throw new Error('Expected upcoming appointments list');
      console.log('PASS - Reschedule lists upcoming appointments');
      out = await step('1'); // pick first
    } else if (s2.conversation_state === engine.STATES.CONFIRM_RESCHEDULE) {
      console.log('PASS - Reschedule auto-advanced to slots');
    } else {
      throw new Error('Unexpected state after reschedule entry: ' + s2.conversation_state);
    }

    // Now in CONFIRM_RESCHEDULE. Pick first slot.
    out = await step('1');
    if (api.calls.update.length !== 1 || api.calls.update[0].appointmentId !== 'FUT1') throw new Error('updateIndividualAppointment not called with FUT1');
    console.log('PASS - Reschedule calls API with correct appointment id');
  } catch (e) {
    console.error('FAIL - Reschedule flow:', e.message || e);
    process.exitCode = 1;
  }
})();

