// File: /src/core/ChatbotEngine.js

const ConversationService = require('../services/ConversationService.js');
const ClinikoAPI = require('../api/ClinikoAPI.js');
const { checkDatabaseHealth, checkAPIHealth } = require('../routes/health.js');
const SessionManager = require('./SessionManager');
const Logger = require('./Logger.js');
const axios = require('axios');

// Code Constants
const WHATSAPP_MAX_MESSAGE_LENGTH = 4096;
const WHATSAPP_SAFE_REPLY_LENGTH = 3500;
const MAX_SLOT_ITEMS = 10;
const MAX_DATE_ITEMS = 5;
const MAX_DATE_PAGES = 2; // 2 pages of 5 = 10 business days (excluding Sundays)

const REGION_SUPPORT_INFO = {
  SG: {
    phone: '+65 6123 4567',
    email: 'support@prohealth.com.sg'
  },
  HK: {
    phone: '+852 1234 5678',
    email: 'support@prohealth.hk'
  },
  IN: {
    phone: '+91 98765 43210',
    email: 'support@prohealth.in'
  },
  PH: {
    phone: '+63 912 345 6789',
    email: 'support@prohealth.ph'
  }
};

/**
 * A unified navigation stack to manage step transitions and back behavior.
 * Frames: { step: string, auto: boolean }
 * - auto=true when we auto-advanced (single option); back skips these frames.
 */
/**
 * Formal navigation utilities and transition matrix.
 */

class NavigationStack {
  static from(data) {
    const s = new NavigationStack();
    s.frames = Array.isArray(data?.navigation_chain) ? data.navigation_chain.slice() : [];
    return s;
  }
  constructor() { this.frames = []; }
  toJSON() { return this.frames.slice(); }
  clear() { this.frames = []; }
  push(step, { auto = false } = {}) { this.frames.push({ step, auto }); }
  stepBack() {
    if (!this.frames.length) return { step: null, popped: [] };
    const popped = [];
    let frame = this.frames.pop();
    popped.push(frame);
    // Skip all auto-advanced frames to land on last user-choice step
    while (frame && frame.auto && this.frames.length) {
      frame = this.frames.pop();
      popped.push(frame);
    }
    const step = frame && !frame.auto ? frame.step : null;
    return { step, popped };
  }
}

// Soonest supports flexible entry via choose_any
const TransitionMatrix = {
  soonest: ['choose_any', 'choose_type', 'choose_physio_or_clinic', 'choose_physio', 'choose_clinic', 'select_slot'],
  history: ['choose_appt_type', 'select_slot']
};

function nextStep(flow, currentStep) {
  const seq = TransitionMatrix[flow] || [];
  const idx = seq.indexOf(currentStep);
  return idx >= 0 && idx < seq.length - 1 ? seq[idx + 1] : null;
}

const CLEAR_FIELDS_BY_STEP = {
  choose_any: ['selected_appt_type', 'selected_physio', 'selected_clinic', 'appt_types_for_physio', 'appt_type_page', 'practitioner_list', 'practitioner_page', 'clinic_list', 'clinic_page'],
  choose_type: ['selected_appt_type', 'practitioner_list', 'practitioner_page', 'clinic_list', 'clinic_page'],
  choose_physio_or_clinic: [],
  choose_physio: ['selected_physio', 'clinic_list', 'clinic_page', 'appt_types_for_physio', 'appt_type_page'],
  choose_clinic: ['selected_clinic', 'appt_types_for_physio', 'appt_type_page'],
  choose_appt_type: ['selected_appt_type']
};

function clearForwardStateForPopped(data, popped) {
  const toClear = new Set();
  for (const fr of popped) {
    const fields = CLEAR_FIELDS_BY_STEP[fr.step] || [];
    for (const f of fields) toClear.add(f);
  }
  for (const f of toClear) delete data[f];
}

function planStepForward({ data, flow, step, optionsCount, onAuto }) {
  const nav = NavigationStack.from(data);
  let advanced = false;
  let auto = false;
  if (optionsCount === 1 && !data.suppress_auto_advance) {
    if (typeof onAuto === 'function') onAuto();
    nav.push(step, { auto: true });
    advanced = true;
    auto = true;
  } else if (optionsCount > 1) {
    nav.push(step, { auto: false });
  }
  data.navigation_chain = nav.toJSON();
  return { advanced, auto };
}

function handleBackGeneric(flowKey, rerenderHandler) {
  return async function(session, data) {
    const nav = NavigationStack.from(data);
    const { step, popped } = nav.stepBack();
    data.navigation_chain = nav.toJSON();

    if (step) {
      clearForwardStateForPopped(data, popped);
      data.selection_step = step;
      data.suppress_auto_advance = true; // prevent immediate re-auto-advance
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES[flowKey === 'soonest' ? 'BOOK_SOONEST' : 'BOOK_FROM_HISTORY'],
        data: JSON.stringify(data)
      });
      return await rerenderHandler.call(this, session, '');
    }
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
      data: null
    });
    return await this.goToInteractiveMenu(session);
  };
}

/**
 * Validates and normalizes a date search window enforcing:
 * - bookings start from next day (not today),
 * - max 7 days span (inclusive),
 * - ISO strings in 'YYYY-MM-DDTHH:mm:ssZ' or 'YYYY-MM-DD' interpreted as UTC.
 *
 * If input is missing, constructs from next-day start up to next-day + 6 (7-day window).
 * If provided 'from'/'to' violate constraints, clamps within the valid window.
 *
 * @param {string|undefined} fromISO - optional 'YYYY-MM-DDTHH:mm:ssZ' or 'YYYY-MM-DD'
 * @param {string|undefined} toISO   - optional 'YYYY-MM-DDTHH:mm:ssZ' or 'YYYY-MM-DD'
 * @param {number} maxSpanDays       - maximum span (default 7)
 * @returns {{ from: string, to: string }}
 */
function normalizeDateWindow(fromISO, toISO, maxSpanDays = 7) {
  // Compute next-day window
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const nextDay = new Date(base);
  nextDay.setUTCDate(base.getUTCDate() + 1);
  const lastDay = new Date(nextDay);
  // Inclusive span of maxSpanDays => last day is nextDay + (maxSpanDays - 1)
  lastDay.setUTCDate(nextDay.getUTCDate() + (maxSpanDays - 1));

  // parse helper that accepts 'YYYY-MM-DD' or ISO with time
  const parseDate = (s, endOfDay = false) => {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(`${s}T00:00:00Z`);
      if (endOfDay) d.setUTCHours(23, 59, 59, 999);
      return d;
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d;
  };

  // Build initial from/to
  let from = fromISO ? parseDate(fromISO, false) : new Date(nextDay);
  let to = toISO ? parseDate(toISO, true) : new Date(lastDay);
  if (!from) from = new Date(nextDay);
  if (!to) to = new Date(lastDay);

  // Enforce not earlier than nextDay
  if (from < nextDay) from = new Date(nextDay);
  if (to < from) to = new Date(from);

  // Clamp to max span
  const maxTo = new Date(from);
  maxTo.setUTCDate(from.getUTCDate() + (maxSpanDays - 1));
  if (to > maxTo) to = maxTo;

  // Also do not exceed global allowed lastDay bound
  if (to > lastDay) to = new Date(lastDay);

  const toISODate = d => {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const fromOut = `${toISODate(from)}T00:00:00Z`;
  const toOut = `${toISODate(to)}T23:59:59Z`;
  return { from: fromOut, to: toOut };
}

/**
 * Build a unique list of all practitioners from the grouped array returned by getPractitionersByClinic.
 * @param {Array<{clinic_id: string, clinic_name: string, practitioners: Array<Object>}>} groups
 * @returns {Array<Object>} Array of unique practitioner objects.
 */
function uniquePractitionersFromGroups(groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const p of group.practitioners) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        result.push(p);
      }
    }
  }
  return result;
}

/**
 * Build a deduplicated list of all appointment types offered by all practitioners.
 * @param {ClinikoAPI} clinikoAPI
 * @param {Array<{clinic_id: string, clinic_name: string, practitioners: Array<Object>}>} groups
 * @returns {Promise<Array<Object>>} Array of unique appointment type objects.
 */
async function getAllAppointmentTypesForAllPractitioners(clinikoAPI, groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const p of group.practitioners) {
      const types = await clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
      for (const t of types) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          result.push(t);
        }
      }
    }
  }
  return result;
}

/**
 * For a given appointment type, return all practitioners (unique) who offer that type.
 * @param {Array<{clinic_id: string, clinic_name: string, practitioners: Array<Object>}>} groups
 * @param {ClinikoAPI} clinikoAPI
 * @param {string|number} apptTypeId
 * @returns {Promise<Array<Object>>}
 */
async function getPractitionersForType(groups, clinikoAPI, apptTypeId) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const p of group.practitioners) {
      if (seen.has(p.id)) continue;
      const types = await clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
      if (types.some(t => t.id === apptTypeId)) {
        seen.add(p.id);
        result.push(p);
      }
    }
  }
  return result;
}

/**
 * Returns support info string for the given region code.
 * Defaults to SG if region not found.
 * @param {string} region
 * @returns {string}
 */
function getSupportInfo(region) {
  const info = REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG;
  return `Need help? Call us at ${info.phone} or email ${info.email}`;
}

/**
 * Extracts the Cliniko ID from a reference object.
 * @param {object} obj - Cliniko reference object.
 * @param {string} type - Resource type (e.g., 'businesses').
 * @returns {string|undefined}
 */
function extractIdFromClinikoRef(obj, type) {
  if (!obj) return undefined;
  if (obj.id) return obj.id;
  const url = obj.links?.self;
  if (url) {
    const parts = url.split('/');
    const idx = parts.findIndex(p => p === type);
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    return parts[parts.length - 1];
  }
  return undefined;
}

/**
 * Converts a slot object to the shape expected by enrichAppointmentsForDisplay.
 * Ensures starts_at is set for enrichment.
 * @param {object} slot
 * @returns {object}
 */
function slotToEnrichable(slot) {
  // Defensive: support both slot.slot and slot.starts_at
  return {
    ...slot,
    starts_at: slot.slot || slot.starts_at, // This is the critical missing field!
    business: { id: slot.business_id },
    practitioner: { id: slot.practitioner_id },
    appointment_type: { id: slot.appointment_type_id }
  };
}

function deduplicateSlots(slots) {
  const seen = new Set();
  return slots.filter(slot => {
    const key = `${slot.practitioner_id}|${slot.business_id}|${slot.slot}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Returns a displayable practitioner name from a practitioner object.
 * @param {Object|null|undefined} practitioner
 * @returns {string}
 */
function getPractitionerDisplayName(practitioner) {
  if (!practitioner) return 'Practitioner';
  if (practitioner.display_name) return practitioner.display_name;
  if (practitioner.first_name || practitioner.last_name)
    return [practitioner.first_name, practitioner.last_name].filter(Boolean).join(' ');
  return 'Practitioner';
}

/**
 * Returns a displayable appointment type name from an appointment type object.
 * @param {Object|null|undefined} apptType
 * @returns {string}
 */
function getAppointmentTypeDisplayName(apptType) {
  if (!apptType) return 'Appointment';
  if (apptType.name) return apptType.name;
  return 'Appointment';
}

/**
 * Returns a displayable business name from a business object.
 * @param {Object|null|undefined} business
 * @returns {string}
 */
function getBusinessDisplayName(business) {
  if (!business) return '';
  return business.business_name || business.display_name || '';
}

/**
 * Enriches appointments with display fields (_practitioner_display, _appointment_type_display, etc.)
 * by fetching all relevant related objects in parallel.
 * @param {Array<Object>} appointments
 * @param {ClinikoAPI} clinikoAPI
 * @returns {Promise<Array<Object>>} Enriched appointments
 */
async function enrichAppointmentsForDisplay(appointments, clinikoAPI) {
  const practitionerIds = new Set();
  const apptTypeIds = new Set();
  const businessIds = new Set();

  // Single consolidated log for incoming appointments
  if (appointments.length > 0) {
    console.log(`[ENRICH] Processing ${appointments.length} appointments`);
  }

  // Collect IDs
  for (const appt of appointments) {
    const practitionerId = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const apptTypeId = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    const businessId = extractIdFromClinikoRef(appt.business, 'businesses');

    if (practitionerId) practitionerIds.add(practitionerId);
    if (apptTypeId) apptTypeIds.add(apptTypeId);
    if (businessId) businessIds.add(businessId);
  }

  // Single log for what we're fetching
  console.log(`[ENRICH] Fetching: ${practitionerIds.size} practitioners, ${apptTypeIds.size} types, ${businessIds.size} businesses`);

  // Fetch all entities in parallel
  const [practitioners, apptTypes, businesses] = await Promise.all([
    Promise.all([...practitionerIds].map(id => clinikoAPI.getPractitionerById(id).then(obj => [id, obj]))),
    Promise.all([...apptTypeIds].map(id => clinikoAPI.getAppointmentTypeById(id).then(obj => [id, obj]))),
    Promise.all([...businessIds].map(id => clinikoAPI.getBusinessById(id).then(obj => [id, obj])))
  ]);

  const practitionerMap = Object.fromEntries(practitioners);
  const apptTypeMap = Object.fromEntries(apptTypes);
  const businessMap = Object.fromEntries(businesses);

  // Only log if there were fetch failures
  const missingPractitioners = [...practitionerIds].filter(id => !practitionerMap[id]);
  const missingTypes = [...apptTypeIds].filter(id => !apptTypeMap[id]);
  const missingBusinesses = [...businessIds].filter(id => !businessMap[id]);
  
  if (missingPractitioners.length > 0 || missingTypes.length > 0 || missingBusinesses.length > 0) {
    console.warn('[ENRICH] Missing entities:', {
      practitioners: missingPractitioners,
      types: missingTypes,
      businesses: missingBusinesses
    });
  }

  // Enrich appointments
  for (const appt of appointments) {
    const practitionerId = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const apptTypeId = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    const businessId = extractIdFromClinikoRef(appt.business, 'businesses');

    const practitionerObj = practitionerMap[practitionerId] || null;
    const apptTypeObj = apptTypeMap[apptTypeId] || null;
    const businessObj = businessMap[businessId] || null;

    appt._practitioner_display = getPractitionerDisplayName(practitionerObj);
    appt._appointment_type_display = getAppointmentTypeDisplayName(apptTypeObj);
    appt._business_display = getBusinessDisplayName(businessObj);
    appt._display_dt = new Date(appt.starts_at).toLocaleString();
  }

  // Single summary log at the end
  console.log(`[ENRICH] Completed enrichment for ${appointments.length} appointments`);
  
  return appointments;
}

/**
 * Paginate and format a list of options for WhatsApp reply.
 * @param {Array} items - Array of objects to present (slots, physios, clinics, etc.)
 * @param {function} formatFn - Function that returns string for each item (item, idx) => string
 * @param {number} [page=0] - Page number (0-based)
 * @param {number} [pageSize=MAX_SLOT_ITEMS] - Items per page
 * @param {string} [moreLabel='M. More'] - Label for "more" option
 * @param {string} [header=''] - Optional header/title for the list
 * @returns {string} WhatsApp-safe paginated list
 */
function formatPaginatedList({
  items,
  formatFn,
  page = 0,
  pageSize = MAX_SLOT_ITEMS,
  moreLabel = 'M. More',
  header = ''
}) {
  if (!Array.isArray(items)) return '';
  const start = page * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  let text = pageItems.map((item, idx) => formatFn(item, idx + 1 + start)).join('\n');
  if (items.length > start + pageSize) text += `\n${moreLabel}`;
  let reply = header ? header + '\n\n' + text : text;
  if (reply.length > WHATSAPP_SAFE_REPLY_LENGTH) {
    reply = reply.slice(0, WHATSAPP_SAFE_REPLY_LENGTH - 50) + "\n\n[Reply 'M' for more]";
  }
  return reply;
}

/**
 * Format a slot object for display in slot lists.
 * Omit practitioner_name and/or business_name if already selected.
 * @param {Object} slot
 * @param {number} idx - 1-based index for display
 * @param {Object} [opts] - { omitPhysio, omitClinic }
 * @returns {string}
 */
function formatSlotItem(slot, idx, opts = {}) {
  const dt = new Date(slot.slot);
  let main = [];
  if (!opts.omitPhysio && slot.practitioner_name) main.push(slot.practitioner_name);
  if (!opts.omitClinic && slot.business_name) main.push(slot.business_name);
  if (slot.appointment_type_name) main.push(slot.appointment_type_name);
  return `${idx}. ${main.join(' — ')}\n   ${dt.toLocaleString()}`;
}

/**
 * Format a physiotherapist for display in physio lists.
 * @param {Object} physio
 * @param {number} idx - 1-based index for display
 * @returns {string}
 */
function formatPhysioItem(physio, idx) {
  const name = `${physio.first_name || ''} ${physio.last_name || ''}`.trim() || physio.display_name;
  return `${idx}. ${name}${physio.specialization ? ' - ' + physio.specialization : ''}`;
}

/**
 * Get the next available appointment dates, skipping Sundays.
 * @param {Date} [startFrom=new Date()] - Date to start from (not included)
 * @param {number} [count=MAX_DATE_ITEMS] - Number of dates to return
 * @param {number} [maxDays=14] - How many days max to look ahead
 * @returns {Date[]}
 */
function getNextAvailableDates(startFrom = new Date(), count = MAX_DATE_ITEMS, maxDays = 14) {
  const result = [];
  let date = new Date(startFrom);
  let added = 0;
  let checked = 0;
  while (added < count && checked < maxDays) {
    if (date.getDay() !== 0) { // 0 = Sunday
      result.push(new Date(date));
      added++;
    }
    date.setDate(date.getDate() + 1);
    checked++;
  }
  return result;
}
/**
 * Main Chatbot conversation engine for WhatsApp/Cliniko integration.
 */
class ChatbotEngine {
  constructor() {
    this.sessionManager = new SessionManager();
    this.clinikoAPI = new ClinikoAPI();
    this.logger = new Logger('ChatbotEngine');
    this.isInitialized = false;
    this.STATES = {
      INTRO: 'INTRO',
      VERIFY: 'VERIFY',
      BOOK_MANAGE_OPTIONS: 'BOOK_MANAGE_OPTIONS',
      BOOKING_METHOD_OPTIONS: 'BOOKING_METHOD_OPTIONS',
      BOOK_HISTORY: 'BOOK_HISTORY',
      BOOK_SOONEST: 'BOOK_SOONEST',
      BOOK_SPECIFIC_DATE: 'BOOK_SPECIFIC_DATE',
      BOOK_SPECIFIC_PHYSIO: 'BOOK_SPECIFIC_PHYSIO',
      BOOK_SPECIFIC_CLINIC: 'BOOK_SPECIFIC_CLINIC',
      SELECT_SLOT: 'SELECT_SLOT',
      CONFIRM_BOOKING: 'CONFIRM_BOOKING',
      CANCEL_APPOINTMENT: 'CANCEL_APPOINTMENT',
      SELECT_APPOINTMENT_TO_CANCEL: 'SELECT_APPOINTMENT_TO_CANCEL',
      CONFIRM_CANCEL: 'CONFIRM_CANCEL',
      RESCHEDULE_APPOINTMENT: 'RESCHEDULE_APPOINTMENT',
      SELECT_APPOINTMENT_TO_RESCHEDULE: 'SELECT_APPOINTMENT_TO_RESCHEDULE',
      CONFIRM_RESCHEDULE: 'CONFIRM_RESCHEDULE',
      VIEW_FEES: 'VIEW_FEES',
      VIEW_LOCATIONS: 'VIEW_LOCATIONS',
      REGISTER_PATIENT: 'REGISTER_PATIENT',
      FALLBACK: 'FALLBACK',
    };
    this.stateHandlers = {};
    this.initializeFlows();
  }

  /**
   * Returns the region code for this session, or 'SG' if not set.
   * @param {object} session
   * @returns {string}
   */
  _getSessionRegion(session) {
    let context = session.context;
    if (context && typeof context === 'string') {
      try { context = JSON.parse(context); } catch {}
    }
    return (context && context.region) || 'SG';
  }

  /**
   * Unified error message with menu and support info.
   * @param {object} session
   */
  async renderErrorWithMenu(session) {
    let menu = '';
    if (session && session.verified) {
      menu = await this.renderMainMenu(session);
    }
    return (
      "We encountered an unexpected error processing your request. " +
      "You can continue using the menu below, or contact support if the issue persists.\n\n" +
      menu +
      "\n\n" + getSupportInfo(this._getSessionRegion(session))
    );
  }

  /**
   * Initialize session manager and mark engine as initialized.
   */
  async initialize() {
    try {
      await this.sessionManager.initialize();
      this.isInitialized = true;
      this.logger.info('ChatbotEngine initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize ChatbotEngine:', error);
      throw error;
    }
  }

  /**
   * Register all state handlers for the chatbot state machine.
   */
  initializeFlows() {
    this.stateHandlers = {
      [this.STATES.INTRO]: this.handleIntroState.bind(this),
      [this.STATES.VERIFY]: this.handleVerifyState.bind(this),
      [this.STATES.BOOK_MANAGE_OPTIONS]: this.handleBookManageOptions.bind(this),
      [this.STATES.BOOKING_METHOD_OPTIONS]: this.handleBookingMethodOptions.bind(this),
      [this.STATES.BOOK_HISTORY]: this.handleBookHistory.bind(this),
      [this.STATES.BOOK_SOONEST]: this.handleBookSoonest.bind(this),
      [this.STATES.BOOK_SPECIFIC_DATE]: this.handleBookSpecificDate.bind(this),
      [this.STATES.BOOK_SPECIFIC_PHYSIO]: this.handleBookSpecificPhysio.bind(this),
      [this.STATES.BOOK_SPECIFIC_CLINIC]: this.handleBookSpecificClinic.bind(this),
      [this.STATES.SELECT_SLOT]: this.handleSelectSlotState.bind(this),
      [this.STATES.CONFIRM_BOOKING]: this.handleConfirmBookingState.bind(this),
      [this.STATES.CANCEL_APPOINTMENT]: this.handleCancelAppointmentState.bind(this),
      [this.STATES.SELECT_APPOINTMENT_TO_CANCEL]: this.handleSelectAppointmentToCancelState.bind(this),
      [this.STATES.CONFIRM_CANCEL]: this.handleConfirmCancelState.bind(this),
      [this.STATES.RESCHEDULE_APPOINTMENT]: this.handleRescheduleAppointmentState.bind(this),
      [this.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE]: this.handleSelectAppointmentToRescheduleState.bind(this),
      [this.STATES.CONFIRM_RESCHEDULE]: this.handleConfirmRescheduleState.bind(this),
      [this.STATES.VIEW_FEES]: this.handleViewFeesState.bind(this),
      [this.STATES.VIEW_LOCATIONS]: this.handleViewLocationsState.bind(this),
      [this.STATES.REGISTER_PATIENT]: this.handleRegisterPatientState.bind(this),
      [this.STATES.FALLBACK]: this.handleFallbackState.bind(this),
    };
  }

  // ====== MENU RENDER HELPERS ======

  /**
   * Sets the appropriate menu state and renders the main menu.
   * @param {object} session
   * @returns {Promise<string>}
   */
  async goToInteractiveMenu(session) {
    // Always get the latest session state from DB
    const updatedSession = await this.sessionManager.getSession(session.id);

    if (!updatedSession.verified) {
      await this.sessionManager.updateSession(updatedSession.id, { conversation_state: this.STATES.INTRO });
      const fresh = await this.sessionManager.getSession(updatedSession.id);
      return await this.renderMainMenu(fresh);
    }

    if (updatedSession.conversation_state === this.STATES.BOOKING_METHOD_OPTIONS) {
      return await this.renderBookingMethodMenu(updatedSession);
    }
    // Add more as needed (manage, cancel, etc.)
    // Falling through here
    await this.sessionManager.updateSession(updatedSession.id, { conversation_state: this.STATES.BOOK_MANAGE_OPTIONS });
    const fresh = await this.sessionManager.getSession(updatedSession.id);
    return await this.renderMainMenu(fresh);
  }
  async renderBookingMethodMenu(session) {
    return (
      'How would you like to book?\n\n' +
      '1️⃣ Based on your last physio visit\n' +
      '2️⃣ Soonest available\n' +
      '3️⃣ At specific date\n' +
      '4️⃣ Pick a specific physio\n' +
      '5️⃣ Pick a specific clinic\n\n' +
      'Reply with number'
    );
  }

  /**
    Render the correct main menu based on verification and region.
    Always shows the current region (if set) and a hint to change it.
    @param {object} session
    @returns {Promise<string>}
  */
  async renderMainMenu(session) {
    // Get region from context (parse string if needed)
    let region = '';
    let context = session.context;
    if (context && typeof context === 'string') {
      try { context = JSON.parse(context); } catch {}
    }
    if (context && context.region) {
      const regionLabels = {
        HK: 'Hong Kong 🇭🇰',
        SG: 'Singapore 🇸🇬',
        IN: 'India 🇮🇳',
        PH: 'Philippines 🇵🇭'
      };
      if (regionLabels[context.region]) {
        region = `🌏 *Your region*: ${regionLabels[context.region]}\n`;
      }
    }

    if (session.verified) {
      return (
        `${region}` +
        `What would you like to do?\n\n` +
        `1️⃣ Book Appointment\n` +
        `2️⃣ Cancel Appointment\n` +
        `3️⃣ Reschedule Appointment\n` +
        `9️⃣ Logout & Delete Data\n\n` +
        `Type "region" anytime to change region.\n` +
        `Reply with the number or a keyword.`
      );
    } else {
      return (
        `👋 *Welcome to ProHealthAsia*\n\n` +
        `${region}` +
        `Please select an option:\n` +
        `1️⃣ Book or Manage Appointment\n` +
        `2️⃣ View Fees\n` +
        `3️⃣ View Locations\n` +
        `4️⃣ Register as New Patient\n\n` +
        `Type "region" anytime to change region.\n` +
        `Reply with the number or a keyword.`
      );
    }
  }
 
  // ====== MAIN ENTRY POINT ======

  /**
   * Main entry point: handle a message for a phone number.
   * @param {string} message
   * @param {string} phoneNumber
   */
  async handleMessage(message, phoneNumber) {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      this.logger.debug('Handling message:', { message, phoneNumber });
      let session = await this.sessionManager.getOrCreateSession(phoneNumber);
      if (!session) {
        this.logger.warn(`Failed to create session for ${phoneNumber}`);
        return 'Sorry, there was an issue starting your session. Please try again.';
      }
      // If first message, always start at INTRO unless already set
      if (!session.conversation_state) {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.INTRO
        });
        session.conversation_state = this.STATES.INTRO;
      }
      const currentState = session.conversation_state || this.STATES.INTRO;
      if (!this.stateHandlers[currentState]) {
        return await this.handleFallbackState(session, message);
      }
      const response = await this.stateHandlers[currentState](session, message);
      if (session.id) {
        await this.sessionManager.db.addChatHistory(session.id, message, response);
      }
      return response;
    } catch (error) {
      this.logger.error('handleMessage error', { stack: error.stack, message: error.message, error });
      let session;
      try {
        session = await this.sessionManager.getSessionByPhoneNumber?.(phoneNumber);
      } catch {}
      if (session) {
        return await this.renderErrorWithMenu(session);
      }
      return (
          "We're currently experiencing a technical issue and could not start your session. " +
          "Please try again later. If the problem continues, " +
        getSupportInfo(this._getSessionRegion(session))
      );
    }
  }

  // ====== STATE HANDLERS ======

  /**

  Handle the intro state (first message), including region detection and selection.
  If region can be detected from phone, set as default.
  If not, prompt user to select.
  User can type "region" anytime to change region.
  All menu rendering is delegated to renderMainMenu.
  @param {object} session
  @param {string} message
  @returns {Promise<string>}
  */
  async handleIntroState(session, message) {
    const regionLabels = {
      HK: 'Hong Kong 🇭🇰',
      SG: 'Singapore 🇸🇬',
      IN: 'India 🇮🇳',
      PH: 'Philippines 🇵🇭'
    };
    const regionCodes = Object.keys(regionLabels);

    // Parse context safely
    let context = (session.context && typeof session.context === 'string')
      ? JSON.parse(session.context)
      : (session.context || {});
    const text = (message || '').trim().toLowerCase();

    // If region not set, try auto-detect
    if (!context.region) {
      const phone = session.phone_number || session.phoneNumber;
      if (typeof this.sessionManager.getRegionFromPhoneNumber === 'function') {
        const info = this.sessionManager.getRegionFromPhoneNumber(phone);
        if (info && info.region && regionLabels[info.region]) {
          context.region = info.region;
          await this.sessionManager.updateSession(session.id, { context });
        }
      }
    }

    // If region not set or user typed "region", show region selection menu
    if (!context.region || text === 'region' || text === 'change region' || context.awaiting_region_selection) {
      context.awaiting_region_selection = true;
      // Handle selection input
      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        if (idx >= 0 && idx < regionCodes.length) {
          context.region = regionCodes[idx];
          delete context.awaiting_region_selection;
          await this.sessionManager.updateSession(session.id, { context });
          // Return main menu immediately after setting region
          return await this.renderMainMenu(session);
        }
      } else if (regionCodes.some(code => text.includes(regionLabels[code].toLowerCase()))) {
        const found = regionCodes.find(code => text.includes(regionLabels[code].toLowerCase()));
        context.region = found;
        delete context.awaiting_region_selection;
        await this.sessionManager.updateSession(session.id, { context });
        // Return main menu immediately after setting region
        return await this.renderMainMenu(session);
      }

      if (!context.region || context.awaiting_region_selection) {
        const menu = regionCodes.map((code, i) => `${i + 1}. ${regionLabels[code]}`).join('\n');
        await this.sessionManager.updateSession(session.id, { context });
        return `Please select your region:\n\n${menu}\n\nReply with the number.`;
      }
    }

    // From here, region is set. Proceed with your existing menu logic, using renderMainMenu.
    if (session.verified) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS
      });
      return await this.renderMainMenu(session);
    }

    if (!text || ['menu', 'hi', 'hello', 'hey', '0', 'back'].includes(text)) {
      return await this.renderMainMenu(session);
    }
    if (text === '1' || text.includes('book') || text.includes('manage')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VERIFY,
        verified: false
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleVerifyState(updatedSession, '');
    }
    if (text === '2' || text.includes('fee')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VIEW_FEES
      });
      return await this.handleViewFeesState(session, '');
    }
    if (text === '3' || text.includes('location')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VIEW_LOCATIONS
      });
      return await this.handleViewLocationsState(session, '');
    }
    if (text === '4' || text.includes('register')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.REGISTER_PATIENT
      });
      return await this.handleRegisterPatientState(session, '');
    }
    return `Sorry, I didn't understand that.\n\n` +
      await this.renderMainMenu(session);
  }

  /**
   * Handle fallback for any unknown state or invalid input.
   * @param {object} session
   * @param {string} message
   */
  async handleFallbackState(session, message) {
    return `I'm sorry, I didn't understand that.\n\n` + await this.goToInteractiveMenu(session);
  }

  /**
   * Handle user identity verification state.
   * @param {object} session
   * @param {string} message
   */
  async handleVerifyState(session, message) {
    let data = {};
    try {
      data = typeof session.data === 'string'
        ? JSON.parse(session.data)
        : session.data || {};
    } catch (e) {
      data = {};
    }
    if (!data.awaiting_email) {
      const updatedData = { ...data, awaiting_email: true };
      await this.sessionManager.updateSession(session.id, {
        data: JSON.stringify(updatedData)
      });
      return 'To verify your identity, please enter the email address you used to register with us.';
    }
    const email = message.trim().toLowerCase();
    if (!email.includes('@') || !email.includes('.')) {
      return 'That doesn\'t look like a valid email. Please enter a valid email address to proceed.';
    }
    const patient = await this.clinikoAPI.findPatientByEmail(email);
    const clearedData = { ...data };
    delete clearedData.awaiting_email;
    if (patient) {
      await this.sessionManager.updateSession(session.id, {
        verified: true,
        patient_id: patient.id,
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: JSON.stringify(clearedData)
      });
      return 'Verification successful!\n\nWhat would you like to do?\n\n1️⃣ Book Appointment\n2️⃣ Cancel Appointment\n3️⃣ Reschedule Appointment\n\nReply with the number or a keyword.';
    } else {
      await this.sessionManager.updateSession(session.id, {
        verified: false,
        conversation_state: this.STATES.INTRO,
        data: JSON.stringify(clearedData)
      });
      return (
        "We encountered an unexpected error processing your request. " +
        "You can continue using the menu below, or contact support if the issue persists.\n\n" +
        await this.renderMainMenu(session) +
        "\n\n" + getSupportInfo(this._getSessionRegion(session))
      );
    }
  }

  /**
   * Handle the Book/Manage options menu (after verification).
   * @param {object} session
   * @param {string} message
   */
  async handleBookManageOptions(session, message) {
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.renderMainMenu(updatedSession);
    }
    if (text === '9' || text.includes('logout')) {
      await this.sessionManager.deleteSessionAndData(session.id);
      const updatedSession = await this.sessionManager.getOrCreateSession(
        session.phone_number || session.phoneNumber,
        true
      );
      updatedSession.verified = false;
      return '✅ All your data has been deleted and you are logged out.\n\n' +
        (await this.goToInteractiveMenu(updatedSession));
    }

    if (text === '1' || text.includes('book')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS });
      return 'How would you like to book?\n\n1️⃣ Based on your last physio visit\n2️⃣ Soonest available\n3️⃣ At specific date\n4️⃣ Pick a specific physio\n5️⃣ Pick a specific clinic\n\nReply with number or keyword.';
    }
    if (text === '2' || text.includes('cancel')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.CANCEL_APPOINTMENT });
      return await this.handleCancelAppointmentState(session, '');
    }
    if (text === '3' || text.includes('resched')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.RESCHEDULE_APPOINTMENT });
      return await this.handleRescheduleAppointmentState(session, '');
    }
    return 'Your response is not understood. Here are the options. Try again.' + (await this.goToInteractiveMenu(session));
  }

  /**
   * Handle options for booking method selection.
   * @param {object} session
   * @param {string} message
   */
  async handleBookingMethodOptions(session, message) {
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_MANAGE_OPTIONS });
      return 'What would you like to do?\n\n' + (await this.goToInteractiveMenu(session));
    }
    if (text === '1' || text.includes('history')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_HISTORY });
      return await this.handleBookHistory(session, '');
    }
    if (text === '2' || text.includes('soonest')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SOONEST });
      return await this.handleBookSoonest(session, '');
    }
    if (text === '3' || text.includes('date')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      return await this.handleBookSpecificDate(session, '');
    }
    if (text === '4' || text.includes('physio')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      return await this.handleBookSpecificPhysio(session, '');
    }
    if (text === '5' || text.includes('clinic')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      return await this.handleBookSpecificClinic(session, '');
    }
    return 'Please reply with a valid booking method (1-5).';
  }

  /**
   * Returns the previous logical selection step for the given flow and step.
   * Use this in all handlers for robust, consistent "back" navigation.
   *
   * @param {string} selection_step
   * @param {string} flow - One of 'clinic', 'physio', 'date', 'soonest'
   * @returns {string|null} previous step or null if at top
   */
  async getPreviousStepForBooking(selection_step, flow) {
    if (flow === 'clinic') {
      if (['choose_physio', 'choose_appt_type'].includes(selection_step))
        return 'choose_clinic';
      if (selection_step === 'choose_clinic')
        return null;
    }
    if (flow === 'physio') {
      if (['choose_clinic', 'choose_appt_type'].includes(selection_step))
        return 'choose_physio';
      if (selection_step === 'choose_physio')
        return null;
    }
    if (flow === 'date') {
      if (['choose_clinic', 'choose_physio'].includes(selection_step))
        return 'choose_type';
      if (selection_step === 'choose_type')
        return 'choose_date';
      if (selection_step === 'choose_date')
        return null;
    }
    if (flow === 'soonest') {
      if (['choose_clinic', 'choose_physio'].includes(selection_step))
        return 'choose_type';
      if (selection_step === 'choose_type')
        return null;
    }
    return null;
  }

  /**
   * Centralized: Record the last multi-choice menu for correct back navigation.
   */
  async recordLastMultiOption(session, data, state, selection_step, options) {
    if (options && options.length > 1) {
      data.last_multi_option_state = { state, selection_step };
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    }
  }

  /**
   * Book based on patient history:
   * - Shows previous practitioner and clinic.
   * - For returning clients, filters out "Initial/New Client" appointment types.
   * - Displays header with Type • Physio • Clinic once; slot lines show only date/time.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookHistory(session, message) {
    const flow = 'history';
    const log = this.logger.child({ component: 'BookFromHistory', sessionId: session?.id });
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const text = (message || '').trim().toLowerCase();

    if (['0', 'back', 'menu'].includes(text)) {
      return await handleBackGeneric(flow, this.handleBookHistory).call(this, session, data);
    }

    // Load last context
    if (!data.history_context) {
      const last = await this.clinikoAPI.getLastAppointmentForPatient(session.patient_id);
      if (!last) {
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
        return "No previous appointments found. Please use another booking method.\n\n" + await this.goToInteractiveMenu(session);
      }
      data.history_context = { practitioner: last.practitioner, clinic: last.business };
      data.selection_step = 'choose_appt_type';
      data.navigation_chain = [];
      data.suppress_auto_advance = false;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_FROM_HISTORY, data: JSON.stringify(data) });
    }

    const practitioner = data.history_context.practitioner;
    const clinic = data.history_context.clinic;

    if (data.selection_step === 'choose_appt_type') {
      if (!data.appt_types_for_physio) {
        let types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: practitioner.id });
        types = (types || []).filter(t => !/(initial|new)/i.test(t.name)); // returning client filter
        data.appt_types_for_physio = types;
        data.appt_type_page = 0;
      }
      const types = data.appt_types_for_physio || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= types.length) return 'Invalid appointment type selection. Reply with a number.';
        data.selected_appt_type = types[idx];
        data.selection_step = 'select_slot';
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_appt_type', optionsCount: types.length,
          onAuto: () => { data.selected_appt_type = types[0]; data.selection_step = 'select_slot'; }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_FROM_HISTORY });
        if (forward.advanced && forward.auto) return await this.handleBookHistory(session, '');
        if (!types.length) return "No suitable appointment types found. Please choose another method.";
        const header = `Choose appointment type with ${practitioner.display_name || practitioner.first_name} at ${clinic.business_name}:`;
        const reply = formatPaginatedList({
          items: types,
          formatFn: (a, i) => `${i}. ${a.name}`,
          page: data.appt_type_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More types',
          header
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'select_slot') {
      const { from, to } = normalizeDateWindow(undefined, undefined, 7);
      const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: clinic.id, from, to, practitioner_id: practitioner.id
      });
      const filtered = (slots || []).filter(s => s.appointment_type_id === data.selected_appt_type.id);
      if (!filtered.length) return "No available slots for that selection. Please try another type or method. (0️⃣ Back)";

      const header = `${data.selected_appt_type.name} • ${practitioner.display_name || practitioner.first_name} • ${clinic.business_name}`;
      const slotData = {
        slot_list: filtered,
        slot_page: 0,
        last_selection_flow: 'history',
        prev_state_data: {
          selected_physio: practitioner,
          selected_clinic: clinic,
          selected_appt_type: data.selected_appt_type
        }
      };
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(slotData) });

      const reply = formatPaginatedList({
        items: filtered,
        formatFn: (slot, idx) => `${idx}. ${new Date(slot.slot).toLocaleString()}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }

    return 'Please try again.';
  }
  
  
  /**
   * Book soonest available appointment.
   * Enforces next-day start and 7-day max window via normalizeDateWindow.
   * Consistent back navigation:
   * - "0"/"back"/"menu" goes up one logical step; at top goes to BOOKING_METHOD_OPTIONS.
   * Auto-advance on single-option selection is recorded in navigation_chain with had_multiple_options=false.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSoonest(session, message) {
    const flow = 'soonest';
    const log = this.logger.child({ component: 'BookSoonest', sessionId: session?.id });
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const text = (message || '').trim().toLowerCase();

    // Back/menu
    if (['0', 'back', 'menu'].includes(text)) {
      return await handleBackGeneric(flow, this.handleBookSoonest).call(this, session, data);
    }

    // Init
    if (!data.selection_step) {
      data.selection_step = 'choose_any';
      data.navigation_chain = [];
      data.suppress_auto_advance = false;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SOONEST, data: JSON.stringify(data) });
    }

    // Step: choose_any (pivot)
    if (data.selection_step === 'choose_any') {
      if (!isNaN(text) && text !== '') {
        const choice = parseInt(text, 10);
        if (choice === 1) {
          data.selection_step = 'choose_type';
        } else if (choice === 2) {
          data.selection_step = 'choose_physio';
        } else if (choice === 3) {
          data.selection_step = 'choose_clinic';
        } else {
          return 'Please reply 1, 2, or 3.\n1. Appointment type\n2. Physiotherapist\n3. Clinic\n\n(0️⃣ Back)';
        }
      } else {
        // No auto-advance here; always show pivot
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return [
          'How would you like to start?',
          '1. Appointment type',
          '2. Physiotherapist',
          '3. Clinic',
          '',
          '(0️⃣ Back)'
        ].join('\n');
      }
    }

    // Helper: ensure appointment types for a given practitioner (and deduplicated by name)
    const loadApptTypesForPractitioner = async (practitionerId) => {
      let types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: practitionerId });
      const unique = new Map();
      for (const t of types || []) if (!/UWC/i.test(t.name)) if (!unique.has(t.name)) unique.set(t.name, t);
      return Array.from(unique.values());
    };

    // Step: choose_physio
    if (data.selection_step === 'choose_physio') {
      if (!data.practitioner_list) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        data.practitioner_list = uniquePractitionersFromGroups(groups);
        data.practitioner_page = 0;
      }
      const physios = data.practitioner_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= physios.length) return 'Invalid physiotherapist selection. Reply with a number.';
        data.selected_physio = physios[idx];
        data.selection_step = 'choose_type';
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_physio', optionsCount: physios.length,
          onAuto: () => { data.selected_physio = physios[0]; data.selection_step = 'choose_type'; }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SOONEST });
        if (forward.advanced && forward.auto) return await this.handleBookSoonest(session, '');
        if (!physios.length) return 'No physiotherapists found.';
        const reply = formatPaginatedList({
          items: physios,
          formatFn: formatPhysioItem,
          page: data.practitioner_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More physios',
          header: 'Select a physiotherapist:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    // Step: choose_clinic
    if (data.selection_step === 'choose_clinic') {
      if (!data.clinic_list) {
        const clinicsFetched = await this.clinikoAPI.getClinics();
        data.clinic_list = (clinicsFetched || []).filter(c => !/UWC/i.test(c.business_name));
        data.clinic_page = 0;
      }
      const clinics = data.clinic_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= clinics.length) return 'Invalid clinic selection. Reply with a number.';
        data.selected_clinic = clinics[idx];
        data.selection_step = 'choose_type';
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_clinic', optionsCount: clinics.length,
          onAuto: () => { data.selected_clinic = clinics[0]; data.selection_step = 'choose_type'; }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SOONEST });
        if (forward.advanced && forward.auto) return await this.handleBookSoonest(session, '');
        if (!clinics.length) return "No clinics available at the moment. Please try another booking method.";
        const reply = formatPaginatedList({
          items: clinics,
          formatFn: (c, i) => `${i}. ${c.business_name}`,
          page: data.clinic_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: 'Select a clinic:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    // Step: choose_type
    if (data.selection_step === 'choose_type') {
      // Build appointment types based on context:
      // - If physio selected: types for that physio.
      // - If clinic selected: union of types across physios in clinic (unique by name).
      // - If neither: union of all types across all practitioners (unique by name).
      if (!data.appointment_type_list) {
        let types = [];
        if (data.selected_physio?.id) {
          types = await loadApptTypesForPractitioner(data.selected_physio.id);
        } else if (data.selected_clinic?.id) {
          const physios = await this.clinikoAPI.getPractitionersForClinic(data.selected_clinic.id);
          const map = new Map();
          for (const p of physios || []) {
            const t = await loadApptTypesForPractitioner(p.id);
            for (const at of t) if (!map.has(at.name)) map.set(at.name, at);
          }
          types = Array.from(map.values());
        } else {
          const groups = await this.clinikoAPI.getPractitionersByClinic();
          const map = new Map();
          for (const g of groups || []) {
            for (const p of g.practitioners || []) {
              const t = await loadApptTypesForPractitioner(p.id);
              for (const at of t) if (!map.has(at.name)) map.set(at.name, at);
            }
          }
          types = Array.from(map.values());
        }
        data.appointment_type_list = types;
        data.appt_type_page = 0;
      }
      const types = data.appointment_type_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= types.length) return 'Invalid appointment type selection. Reply with a number.';
        data.selected_appt_type = types[idx];
        // Determine next step: if neither physio nor clinic chosen, ask which dimension next
        if (!data.selected_physio && !data.selected_clinic) {
          data.selection_step = 'choose_physio_or_clinic';
        } else {
          data.selection_step = 'select_slot';
        }
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_type', optionsCount: types.length,
          onAuto: () => {
            data.selected_appt_type = types[0];
            data.selection_step = (!data.selected_physio && !data.selected_clinic) ? 'choose_physio_or_clinic' : 'select_slot';
          }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SOONEST });
        if (forward.advanced && forward.auto) return await this.handleBookSoonest(session, '');
        if (!types.length) return 'No appointment types available.';
        // Header reflects context if present
        const parts = ['Choose appointment type'];
        if (data.selected_physio) parts.push(`with ${data.selected_physio.display_name || data.selected_physio.first_name}`);
        if (data.selected_clinic) parts.push(`at ${data.selected_clinic.business_name}`);
        const header = parts.join(' ');
        const reply = formatPaginatedList({
          items: types,
          formatFn: (a, i) => `${i}. ${a.name}`,
          page: data.appt_type_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More types',
          header
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    // Step: choose_physio_or_clinic (only used when user started with Type)
    if (data.selection_step === 'choose_physio_or_clinic') {
      if (!isNaN(text) && text !== '') {
        const choice = parseInt(text, 10);
        if (choice === 1) {
          data.selection_step = 'choose_physio';
        } else if (choice === 2) {
          data.selection_step = 'choose_clinic';
        } else {
          return 'Please reply 1 or 2.\n1. Physiotherapist\n2. Clinic\n\n(0️⃣ Back)';
        }
      } else {
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return 'Would you like to pick:\n1. Physiotherapist\n2. Clinic\n\n(0️⃣ Back)';
      }
    }

    // Step: select_slot (after we have selected_appt_type and at least one of physio or clinic)
    if (data.selection_step === 'select_slot') {
      const { from, to } = normalizeDateWindow(undefined, undefined, 7);
      let slots = [];

      // If both physio and clinic chosen, fetch for that exact combination and filter by type
      if (data.selected_physio?.id && data.selected_clinic?.id) {
        const all = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: data.selected_clinic.id, from, to, practitioner_id: data.selected_physio.id
        });
        slots = (all || []).filter(s => s.appointment_type_id === data.selected_appt_type.id);
      } else if (data.selected_physio?.id) {
        // Physio chosen first: aggregate across all clinics for that physio
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const clinicsForP = groups
          .filter(g => g.practitioners.some(p => p.id === data.selected_physio.id))
          .filter(g => !/UWC/i.test(g.clinic_name))
          .map(g => ({ id: g.clinic_id, business_name: g.clinic_name }));
        for (const c of clinicsForP) {
          const all = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
            business_id: c.id, from, to, practitioner_id: data.selected_physio.id
          });
          const filtered = (all || []).filter(s => s.appointment_type_id === data.selected_appt_type.id);
          // Ensure clinic_name present per slot
          for (const s of filtered) { s.business_name = c.business_name; }
          slots.push(...filtered);
        }
        // Header: Type • Physio; line: date/time + Clinic
      } else if (data.selected_clinic?.id) {
        // Clinic chosen first: aggregate across all physios for that clinic
        const physios = await this.clinikoAPI.getPractitionersForClinic(data.selected_clinic.id);
        for (const p of physios || []) {
          const all = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
            business_id: data.selected_clinic.id, from, to, practitioner_id: p.id
          });
          const filtered = (all || []).filter(s => s.appointment_type_id === data.selected_appt_type.id);
          for (const s of filtered) { s.practitioner_name = p.display_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(); }
          slots.push(...filtered);
        }
        // Header: Type • Clinic; line: date/time + Physio
      }

      if (!slots.length) {
        return "No available slots for that selection. Please try another option. (0️⃣ Back)";
      }

      // Build header
      const headerParts = [data.selected_appt_type?.name].filter(Boolean);
      if (data.selected_physio) headerParts.push(data.selected_physio.display_name || data.selected_physio.first_name);
      if (data.selected_clinic) headerParts.push(data.selected_clinic.business_name);
      const header = headerParts.join(' • ');

      // Line formatter based on what varies
      const lineForPhysioFirst = (slot, i) => {
        const dt = new Date(slot.slot);
        const clin = slot.business_name || data.selected_clinic?.business_name || slot.business_name || '';
        return `${i}. ${dt.toLocaleString()} • ${clin}`;
      };
      const lineForClinicFirst = (slot, i) => {
        const dt = new Date(slot.slot);
        const phys = slot.practitioner_name || '';
        return `${i}. ${dt.toLocaleString()} • ${phys}`;
      };
      const lineForBothChosen = (slot, i) => `${i}. ${new Date(slot.slot).toLocaleString()}`;

      let formatFn = lineForBothChosen;
      if (data.selected_physio && !data.selected_clinic) formatFn = lineForPhysioFirst;
      if (data.selected_clinic && !data.selected_physio) formatFn = lineForClinicFirst;

      const slotData = {
        slot_list: slots,
        slot_page: 0,
        last_selection_flow: 'soonest',
        prev_state_data: {
          selected_appt_type: data.selected_appt_type,
          selected_physio: data.selected_physio || null,
          selected_clinic: data.selected_clinic || null
        }
      };
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(slotData)
      });
      const reply = formatPaginatedList({
        items: slots,
        formatFn,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }

    return 'Please try again.';
  }

  /**
   * Book at a specific date with robust back navigation and normalized date window.
   * Steps:
   * 1. choose_date (free input, must be future and >= next day)
   * 2. choose_type
   * 3. choose_physio (filtered by availability on that date)
   * 4. choose_clinic (filtered by availability on that date)
   * 5. SELECT_SLOT downstream
   *
   * Back: "0"/"back"/"menu" always goes up one logical step; at top -> BOOKING_METHOD_OPTIONS.
   * Auto-advance on single-option steps recorded with had_multiple_options=false.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSpecificDate(session, message) {
    const flow = 'date';
    const log = this.logger.child({ component: 'BookSpecificDate', sessionId: session?.id });
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const text = (message || '').trim().toLowerCase();

    if (['0', 'back', 'menu'].includes(text)) {
      return await handleBackGeneric.call(this, session, data, flow, this.handleBookSpecificDate);
    }

    if (!data.selection_step) {
      data.selection_step = 'choose_date';
      data.navigation_chain = [];
      data.suppress_auto_advance = false;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_DATE, data: JSON.stringify(data) });
    }

    if (data.selection_step === 'choose_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const example = new Date(Date.now() + 86400000).toISOString().split('T')[0];
        return `Please enter your desired date (YYYY-MM-DD).\nExample: ${example}\n\n(0️⃣ Back)`;
      }
      const selectedDate = text;
      const { from, to } = normalizeDateWindow(`${selectedDate}T00:00:00Z`, `${selectedDate}T23:59:59Z`, 7);
      const daySame = s => s.split('T')[0] === selectedDate;
      if (!(daySame(from) && daySame(to))) {
        const example = new Date(Date.now() + 86400000).toISOString().split('T')[0];
        return `Please select a future date (from tomorrow). Example: ${example}\n\n(0️⃣ Back)`;
      }
      data.selected_date = selectedDate;
      data.selection_step = nextStep(flow, 'choose_date'); // choose_type
    }

    if (data.selection_step === 'choose_type') {
      if (!data.appointment_type_list) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        data.appointment_type_list = await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
        data.appt_type_page = 0;
      }
      const types = data.appointment_type_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= types.length) return 'Invalid appointment type selection. Reply with a number.';
        data.selected_appt_type = types[idx];
        data.selection_step = nextStep(flow, 'choose_type'); // choose_physio
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_type', optionsCount: types.length,
          onAuto: () => { data.selected_appt_type = types[0]; data.selection_step = nextStep(flow, 'choose_type'); }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        if (forward.advanced && forward.auto) return await this.handleBookSpecificDate(session, '');
        if (!types.length) return 'No appointment types available.';
        const reply = formatPaginatedList({
          items: types,
          formatFn: (a, i) => `${i}. ${a.name}`,
          page: data.appt_type_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More types',
          header: `Choose appointment type for ${data.selected_date}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'choose_physio') {
      if (!data.practitioner_list) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const allPractitioners = await getPractitionersForType(groups, this.clinikoAPI, data.selected_appt_type.id);
        const { from, to } = normalizeDateWindow(`${data.selected_date}T00:00:00Z`, `${data.selected_date}T23:59:59Z`, 7);
        const available = [];
        for (const p of allPractitioners) {
          let hasSlots = false;
          for (const g of groups) {
            if (/UWC/i.test(g.clinic_name)) continue;
            if (g.practitioners.some(pp => pp.id === p.id)) {
              try {
                const slots = await this.clinikoAPI.getAvailableTimes({
                  practitioner_id: p.id,
                  business_id: g.clinic_id,
                  appt_type: data.selected_appt_type.id,
                  from, to
                });
                if (slots && slots.length) { hasSlots = true; break; }
              } catch (e) {}
            }
          }
          if (hasSlots) available.push(p);
        }
        data.practitioner_list = available;
        data.practitioner_page = 0;
      }
      const list = data.practitioner_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= list.length) return 'Invalid selection. Reply with a number.';
        data.selected_physio = list[idx];
        data.selection_step = nextStep(flow, 'choose_physio'); // choose_clinic
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_physio', optionsCount: list.length,
          onAuto: () => { data.selected_physio = list[0]; data.selection_step = nextStep(flow, 'choose_physio'); }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        if (forward.advanced && forward.auto) return await this.handleBookSpecificDate(session, '');
        if (!list.length) return `No practitioners available for ${data.selected_appt_type.name} on ${data.selected_date}.`;
        const reply = formatPaginatedList({
          items: list,
          formatFn: formatPhysioItem,
          page: data.practitioner_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More practitioners',
          header: `Practitioners available for ${data.selected_appt_type.name} on ${data.selected_date}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'choose_clinic') {
      if (!data.clinic_list) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const { from, to } = normalizeDateWindow(`${data.selected_date}T00:00:00Z`, `${data.selected_date}T23:59:59Z`, 7);
        const availableClinics = [];
        for (const g of groups) {
          if (/UWC/i.test(g.clinic_name)) continue;
          if (g.practitioners.some(p => p.id === data.selected_physio.id)) {
            try {
              const slots = await this.clinikoAPI.getAvailableTimes({
                practitioner_id: data.selected_physio.id,
                business_id: g.clinic_id,
                appt_type: data.selected_appt_type.id,
                from, to
              });
              if (slots && slots.length) availableClinics.push({ id: g.clinic_id, business_name: g.clinic_name });
            } catch (e) {}
          }
        }
        data.clinic_list = availableClinics;
        data.clinic_page = 0;
      }
      const clinics = data.clinic_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= clinics.length) return 'Invalid selection. Reply with a number.';
        data.selected_clinic = clinics[idx];
        data.selection_step = nextStep(flow, 'choose_clinic'); // select_slot
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_clinic', optionsCount: clinics.length,
          onAuto: () => { data.selected_clinic = clinics[0]; data.selection_step = nextStep(flow, 'choose_clinic'); }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        if (forward.advanced && forward.auto) return await this.handleBookSpecificDate(session, '');
        if (!clinics.length) return `No clinics available for ${data.selected_physio.display_name || data.selected_physio.first_name} on ${data.selected_date}.`;
        const reply = formatPaginatedList({
          items: clinics,
          formatFn: (c, i) => `${i}. ${c.business_name}`,
          page: data.clinic_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: `Clinics where ${data.selected_physio.display_name || data.selected_physio.first_name} is available on ${data.selected_date}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'select_slot') {
      const { from, to } = normalizeDateWindow(`${data.selected_date}T00:00:00Z`, `${data.selected_date}T23:59:59Z`, 7);
      const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: data.selected_clinic.id,
        from, to,
        practitioner_id: data.selected_physio.id
      });
      const filtered = (slots || []).filter(s => s.appointment_type_id === data.selected_appt_type.id);
      if (!filtered.length) return "No slots available for that selection. Please try another option. (0️⃣ Back)";
      const slotData = {
        slot_list: filtered,
        slot_page: 0,
        last_selection_flow: 'date',
        prev_state_data: data
      };
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(slotData) });
      const header = `${data.selected_appt_type.name} • ${data.selected_physio.display_name || data.selected_physio.first_name} • ${data.selected_clinic.business_name} • ${data.selected_date}`;
      const reply = formatPaginatedList({
        items: filtered,
        formatFn: (slot, idx) => `${idx}. ${new Date(slot.slot).toLocaleString()}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }

    return 'Please try again.';
  }

  /**
   * Book by picking a physio directly with consistent back navigation and auto-advance semantics.
   * Back: "0"/"back"/"menu" -> up one level; top -> BOOKING_METHOD_OPTIONS.
   * Auto-advance (single choice) recorded with had_multiple_options=false.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSpecificPhysio(session, message) {
    const flow = 'physio';
    const log = this.logger.child({ component: 'BookSpecificPhysio', sessionId: session?.id });
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const text = (message || '').trim().toLowerCase();

    if (['0', 'back', 'menu'].includes(text)) {
      return await handleBackGeneric.call(this, session, data, flow, this.handleBookSpecificPhysio);
    }

    if (!data.selection_step) {
      // Initial physio list
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      data.physio_list = uniquePractitionersFromGroups(groups);
      data.physio_page = 0;
      data.selection_step = 'choose_physio';
      data.navigation_chain = [];
      data.suppress_auto_advance = false;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO, data: JSON.stringify(data) });
    }

    if (data.selection_step === 'choose_physio') {
      const physios = data.physio_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= physios.length) return 'Invalid physiotherapist selection. Reply with a number.';
        data.selected_physio = physios[idx];
        data.selection_step = nextStep(flow, 'choose_physio'); // choose_clinic
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_physio', optionsCount: physios.length,
          onAuto: () => { data.selected_physio = physios[0]; data.selection_step = nextStep(flow, 'choose_physio'); }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
        if (forward.advanced && forward.auto) return await this.handleBookSpecificPhysio(session, '');
        if (!physios.length) return 'No physiotherapists found.';
        const reply = formatPaginatedList({
          items: physios,
          formatFn: formatPhysioItem,
          page: data.physio_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More physios',
          header: 'Select a physiotherapist:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'choose_clinic') {
      if (!data.clinic_list) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        data.clinic_list = groups
          .filter(g => g.practitioners.some(p => p.id === data.selected_physio.id))
          .filter(g => !/UWC/i.test(g.clinic_name))
          .map(g => ({ id: g.clinic_id, business_name: g.clinic_name }));
        data.clinic_page = 0;
      }
      const clinics = data.clinic_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= clinics.length) return 'Invalid clinic selection. Reply with a number.';
        data.selected_clinic = clinics[idx];
        data.selection_step = nextStep(flow, 'choose_clinic'); // choose_appt_type
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_clinic', optionsCount: clinics.length,
          onAuto: () => { data.selected_clinic = clinics[0]; data.selection_step = nextStep(flow, 'choose_clinic'); }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
        if (forward.advanced && forward.auto) return await this.handleBookSpecificPhysio(session, '');
        if (!clinics.length) return "No clinics found for this physiotherapist.";
        const reply = formatPaginatedList({
          items: clinics,
          formatFn: (c, i) => `${i}. ${c.business_name}`,
          page: data.clinic_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: `Clinics for ${data.selected_physio.display_name || data.selected_physio.first_name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'choose_appt_type') {
      if (!data.appt_types_for_physio) {
        let apptTypes = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: data.selected_physio.id });
        const unique = new Map();
        for (const t of apptTypes || []) if (!/UWC/i.test(t.name)) if (!unique.has(t.name)) unique.set(t.name, t);
        data.appt_types_for_physio = Array.from(unique.values());
        data.appt_type_page = 0;
      }
      const types = data.appt_types_for_physio || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= types.length) return 'Invalid appointment type selection. Reply with a number.';
        data.selected_appt_type = types[idx];
        data.selection_step = nextStep(flow, 'choose_appt_type'); // select_slot
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_appt_type', optionsCount: types.length,
          onAuto: () => { data.selected_appt_type = types[0]; data.selection_step = nextStep(flow, 'choose_appt_type'); }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
        if (forward.advanced && forward.auto) return await this.handleBookSpecificPhysio(session, '');
        if (!types.length) return "This physiotherapist has no available appointment types at this clinic. Please try another clinic.";
        const reply = formatPaginatedList({
          items: types,
          formatFn: (a, i) => `${i}. ${a.name}`,
          page: data.appt_type_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More types',
          header: `Appointment types for ${data.selected_physio.display_name || data.selected_physio.first_name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'select_slot') {
      const { from, to } = normalizeDateWindow(undefined, undefined, 7);
      const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: data.selected_clinic.id, from, to, practitioner_id: data.selected_physio.id
      });
      const filtered = (slots || []).filter(s => s.appointment_type_id === data.selected_appt_type.id);
      if (!filtered.length) return "No available slots for that appointment type and physio at this clinic. Please try another.";
      const slotData = {
        slot_list: filtered,
        slot_page: 0,
        last_selection_flow: 'physio',
        prev_state_data: data
      };
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(slotData) });
      const header = `${data.selected_appt_type.name} • ${data.selected_physio.display_name || data.selected_physio.first_name} • ${data.selected_clinic.business_name}`;
      const reply = formatPaginatedList({
        items: filtered,
        formatFn: (slot, idx) => `${idx}. ${new Date(slot.slot).toLocaleString()}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }

    return 'Please try again.';
  }

  /**
   * Book by picking a clinic directly with consistent back navigation and auto-advance semantics.
   * Back: "0"/"back"/"menu" -> up one logical level; at top -> BOOKING_METHOD_OPTIONS.
   * Auto-advance steps are flagged so back skips them without re-triggering.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSpecificClinic(session, message) {
    const flow = 'clinic';
    const log = this.logger.child({ component: 'BookSpecificClinic', sessionId: session?.id });
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const text = (message || '').trim().toLowerCase();

    if (['0', 'back', 'menu'].includes(text)) {
      return await handleBackGeneric.call(this, session, data, flow, this.handleBookSpecificClinic);
    }

    if (!data.selection_step) {
      const clinicsFetched = await this.clinikoAPI.getClinics();
      data.clinic_list = (clinicsFetched || []).filter(c => !/UWC/i.test(c.business_name));
      data.clinic_page = 0;
      data.selection_step = 'choose_clinic';
      data.navigation_chain = [];
      data.suppress_auto_advance = false;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC, data: JSON.stringify(data) });
    }

    if (data.selection_step === 'choose_clinic') {
      const clinics = data.clinic_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= clinics.length) return 'Invalid clinic selection. Reply with a number.';
        data.selected_clinic = clinics[idx];
        data.selection_step = nextStep(flow, 'choose_clinic'); // choose_physio
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_clinic', optionsCount: clinics.length,
          onAuto: () => { data.selected_clinic = clinics[0]; data.selection_step = nextStep(flow, 'choose_clinic'); }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (forward.advanced && forward.auto) return await this.handleBookSpecificClinic(session, '');
        if (!clinics.length) return "No clinics available at the moment. Please try another booking method.";
        const reply = formatPaginatedList({
          items: clinics,
          formatFn: (c, i) => `${i}. ${c.business_name}`,
          page: data.clinic_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: 'Select a clinic:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'choose_physio') {
      if (!data.physio_list) {
        data.physio_list = await this.clinikoAPI.getPractitionersForClinic(data.selected_clinic.id);
        data.physio_page = 0;
      }
      const physios = data.physio_list || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= physios.length) return 'Invalid physiotherapist selection. Reply with a number.';
        data.selected_physio = physios[idx];
        data.selection_step = nextStep(flow, 'choose_physio'); // choose_appt_type
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_physio', optionsCount: physios.length,
          onAuto: () => { data.selected_physio = physios[0]; data.selection_step = nextStep(flow, 'choose_physio'); }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (forward.advanced && forward.auto) return await this.handleBookSpecificClinic(session, '');
        if (!physios.length) return "No physiotherapists found for this clinic.";
        const reply = formatPaginatedList({
          items: physios,
          formatFn: formatPhysioItem,
          page: data.physio_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More physios',
          header: `Physiotherapists at ${data.selected_clinic.business_name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'choose_appt_type') {
      if (!data.appt_types_for_physio) {
        let apptTypes = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: data.selected_physio.id });
        const unique = new Map();
        for (const t of apptTypes || []) if (!/UWC/i.test(t.name)) if (!unique.has(t.name)) unique.set(t.name, t);
        data.appt_types_for_physio = Array.from(unique.values());
        data.appt_type_page = 0;
      }
      const types = data.appt_types_for_physio || [];

      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= types.length) return 'Invalid appointment type selection. Reply with a number.';
        data.selected_appt_type = types[idx];
        data.selection_step = nextStep(flow, 'choose_appt_type'); // select_slot
      } else {
        const forward = planStepForward({
          data, flow, step: 'choose_appt_type', optionsCount: types.length,
          onAuto: () => { data.selected_appt_type = types[0]; data.selection_step = nextStep(flow, 'choose_appt_type'); }
        });
        data.suppress_auto_advance = false;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (forward.advanced && forward.auto) return await this.handleBookSpecificClinic(session, '');
        if (!types.length) return "This practitioner has no available appointment types. Please try another physiotherapist.";
        const reply = formatPaginatedList({
          items: types,
          formatFn: (a, i) => `${i}. ${a.name}`,
          page: data.appt_type_page || 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More types',
          header: `Appointment types for ${data.selected_physio.display_name || data.selected_physio.first_name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
    }

    if (data.selection_step === 'select_slot') {
      const { from, to } = normalizeDateWindow(undefined, undefined, 7);
      const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: data.selected_clinic.id, from, to, practitioner_id: data.selected_physio.id
      });
      const filtered = (slots || []).filter(s => s.appointment_type_id === data.selected_appt_type.id);
      if (!filtered.length) return "No available slots for that appointment type and physio at this clinic. Please try another.";
      const slotData = {
        slot_list: filtered,
        slot_page: 0,
        last_selection_flow: 'clinic',
        prev_state_data: data
      };
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(slotData) });
      const header = `${data.selected_appt_type.name} • ${data.selected_physio.display_name || data.selected_physio.first_name} • ${data.selected_clinic.business_name}`;
      const reply = formatPaginatedList({
        items: filtered,
        formatFn: (slot, idx) => `${idx}. ${new Date(slot.slot).toLocaleString()}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }

    return 'Please try again.';
  }

  /**
   * Handles user selection of an appointment slot in any workflow leading to SELECT_SLOT state.
   * "Back" always returns to Booking Options menu.
   * Slot display omits physio/clinic if already selected, based on previous data.
   * @param {object} session - The user session object.
   * @param {string} message - The user's input (expected: slot number).
   * @returns {Promise<string>} Message to send to the user.
   */
  async handleSelectSlotState(session, message) {
    const log = this.logger.child({ component: 'SelectSlot', sessionId: session?.id });
    let data;
    try { data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {}); } catch { data = {}; }
    const slots = Array.isArray(data.slot_list) ? data.slot_list : [];
    const text = (message || '').trim().toLowerCase();

    if (text === 'm' || text === 'more') {
      data.slot_page = (data.slot_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(data) });
      const updated = await this.sessionManager.getSession(session.id);
      return await this.handleSelectSlotState(updated, '');
    }

    if (['0', 'menu', 'back'].includes(text)) {
      if (data.prev_state_data) {
        const prevData = data.prev_state_data;
        const step = data.last_selection_flow;
        if (step === 'physio') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO, data: JSON.stringify(prevData) });
          return await this.handleBookSpecificPhysio(session, '');
        }
        if (step === 'clinic') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC, data: JSON.stringify(prevData) });
          return await this.handleBookSpecificClinic(session, '');
        }
        if (step === 'date') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_DATE, data: JSON.stringify(prevData) });
          return await this.handleBookSpecificDate(session, '');
        }
        if (step === 'soonest') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SOONEST, data: JSON.stringify(prevData) });
          return await this.handleBookSoonest(session, '');
        }
        if (step === 'history') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_FROM_HISTORY, data: JSON.stringify(prevData) });
          return await this.handleBookFromHistory(session, '');
        }
      }
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }

    if (!slots.length) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_MANAGE_OPTIONS, data: null });
      return "Sorry, I couldn't find any available appointment slots. Please try again.";
    }

    const page = data.slot_page || 0;
    if (!isNaN(text) && text !== '') {
      const idx = parseInt(text, 10) - 1;
      if (idx < 0 || idx >= slots.length) return 'Invalid slot selection. Please reply with a number, or 0️⃣ to go back.';
      const selectedSlot = slots[idx];
      data.selected_slot = selectedSlot;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.CONFIRM_BOOKING, data: JSON.stringify(data) });
      const dt = new Date(selectedSlot.slot);
      const parts = [];
      if (data.prev_state_data?.selected_appt_type?.name) parts.push(data.prev_state_data.selected_appt_type.name);
      if (data.prev_state_data?.selected_physio?.display_name || data.prev_state_data?.selected_physio?.first_name) parts.push(data.prev_state_data.selected_physio.display_name || data.prev_state_data.selected_physio.first_name);
      if (data.prev_state_data?.selected_clinic?.business_name) parts.push(data.prev_state_data.selected_clinic.business_name);
      const header = parts.join(' • ') || selectedSlot.practitioner_name;
      return `You have selected:\n\n• ${header}\n• ${dt.toLocaleString()}\n\nReply YES to confirm, or 0️⃣ to cancel.`;
    }

    let header = 'Available slots:';
    const parts = [];
    if (data.prev_state_data?.selected_appt_type?.name) parts.push(data.prev_state_data.selected_appt_type.name);
    if (data.prev_state_data?.selected_physio?.display_name || data.prev_state_data?.selected_physio?.first_name) parts.push(data.prev_state_data.selected_physio.display_name || data.prev_state_data.selected_physio.first_name);
    if (data.prev_state_data?.selected_clinic?.business_name) parts.push(data.prev_state_data.selected_clinic.business_name);
    if (parts.length) header = parts.join(' • ');

    const reply = formatPaginatedList({
      items: slots,
      formatFn: (slot, idx) => `${idx}. ${new Date(slot.slot).toLocaleString()}`,
      page,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More slots',
      header
    }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
    return reply;
  }
  
  /**
   * Handle confirmation of booking slot.
   * Enriches the selected slot with practitioner and clinic display names,
   * always shows the clinic, and logs errors with debug comments.
   *
   * @param {object} session - User session object
   * @param {string} message - User input (expected: "yes" or "0"/"menu"/"back")
   * @returns {Promise<string>} Message to send to the user
   */
  async handleConfirmBookingState(session, message) {
    // --- Debug: Start function ---
    this.logger.debug('[handleConfirmBookingState] Entry', { message, sessionId: session?.id });

    const text = (message || '').trim().toLowerCase();

    // Parse session data safely
    let data = {};
    try {
      data = typeof session.data === 'string'
        ? JSON.parse(session.data || '{}')
        : (session.data || {});
    } catch (e) {
      this.logger.warn('[handleConfirmBookingState] Failed to parse session.data', { error: e, raw: session.data });
      data = {};
    }

    // Handle "back" or "menu"
    if (['0', 'menu', 'back'].includes(text)) {
      try {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
          data: null
        });
      } catch (e) {
        this.logger.error('[handleConfirmBookingState] Failed to update session for menu/back', e);
      }
      return 'How would you like to book?\n\n1️⃣ Based on your last physio visit\n2️⃣ Soonest available\n3️⃣ At specific date\n4️⃣ Pick a specific physio\n5️⃣ Pick a specific clinic\n\nReply with number or keyword.';
    }

    // --- Debug: Prepare slot for enrichment ---
    let selectedSlot = data.selected_slot;
    // Defensive: If slot is missing, bail out
    if (!selectedSlot) {
      this.logger.warn('[handleConfirmBookingState] No selected_slot in session.data');
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return "No slot was selected. Please try booking again.";
    }

    // --- Debug: Enrichment ---
    let enrichedSlot = selectedSlot;
    try {
      const enrichableSlot = slotToEnrichable(selectedSlot);
      const enrichedArr = await enrichAppointmentsForDisplay([enrichableSlot], this.clinikoAPI);
      if (enrichedArr && enrichedArr[0]) {
        enrichedSlot = enrichedArr[0];
        this.logger.debug('[handleConfirmBookingState] Slot enriched', { enriched: enrichedSlot });
      } else {
        this.logger.warn('[handleConfirmBookingState] Enrichment did not return an enriched slot');
      }
    } catch (e) {
      this.logger.warn('[handleConfirmBookingState] Slot enrichment failed', { error: e });
    }
    const dt = new Date(enrichedSlot.slot);

    // --- Debug: Handle confirmation ---
    if (text === 'yes') {
      // Defensive: Check required booking info
      const patient_id = session.patient_id;
      if (!patient_id) {
        this.logger.warn('[handleConfirmBookingState] Missing patient_id');
        try {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.INTRO,
            verified: false
          });
        } catch (e) {
          this.logger.error('[handleConfirmBookingState] Failed to set INTRO state after missing patient_id', e);
        }
        return 'Cannot proceed with booking. Please start again.\n\n' + await this.renderMainMenu(session);
      }

      // Defensive: Check slot fields
      if (!selectedSlot.practitioner_id || !selectedSlot.business_id || !selectedSlot.appointment_type_id || !selectedSlot.slot) {
        this.logger.warn('[handleConfirmBookingState] Slot missing required fields', { slot: selectedSlot });
        return "The selected slot is missing some details. Please try booking again.";
      }

      // --- Debug: Attempt booking ---
      let result = {};
      try {
        result = await this.clinikoAPI.bookAppointment({
          patient_id,
          practitioner_id: selectedSlot.practitioner_id,
          business_id: selectedSlot.business_id,
          appointment_type_id: selectedSlot.appointment_type_id,
          starts_at: selectedSlot.slot
        });
        this.logger.debug('[handleConfirmBookingState] Book appointment result', { result });
      } catch (e) {
        this.logger.error('[handleConfirmBookingState] Error in bookAppointment', e);
        result = { success: false, message: "Booking failed due to a technical error." };
      }

      if (result.success) {
        // --- Debug: Booking success, show enriched details ---
        return (
          `✅ Your appointment is booked for:\n` +
          `👨‍⚕️ *${enrichedSlot._practitioner_display || enrichedSlot.practitioner_name}*\n` +
          `🏥 *${enrichedSlot._business_display || ''}*\n` +
          `🗓️ ${dt.toLocaleString()}\n\n` +
          await this.goToInteractiveMenu(session)
        );
      } else {
        // --- Debug: Booking failed, show error message ---
        return (
          `❌ Could not book your appointment. ${result.message || ''}\n\n` +
          await this.goToInteractiveMenu(session)
        );
      }
    }

    // --- Debug: Default, show confirmation message ---
    return (
      `You have selected:\n\n` +
      `👨‍⚕️ *${enrichedSlot._practitioner_display || enrichedSlot.practitioner_name}*\n` +
      `🏥 *${enrichedSlot._business_display || ''}*\n` +
      `🗓️ ${dt.toLocaleString()}\n\n` +
      `Reply YES to confirm, or 0️⃣ to cancel.`
    );
  }

  // ========== VIEW FEES / LOCATIONS / REGISTER (REUSE) ==========

  async handleViewFeesState(session, message) {
    // (re-use your static display or API as before)
    const fees = `
💰 *Fee Structure by Clinic*

🏥 *Prohealth Physiofocus Pte Ltd*
• Initial: SGD 180
• Follow-up: SGD 150

🏥 *Prohealth In Touch Physiotherapy*
• Initial: SGD 190
• Follow-up: SGD 160

🏥 *UWC East*
• Initial: SGD 170
• Follow-up: SGD 140

🏥 *UWC Dover*
• Initial: SGD 175
• Follow-up: SGD 145
    `.trim();
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
    return fees + '\n\n' + await this.renderMainMenu(session);
  }

  async handleViewLocationsState(session, message) {
    const clinics = await this.clinikoAPI.getClinics();
    const displayText = clinics.map((c, idx) =>
      `${idx + 1}. ${c.business_name}\n `
    ).join('\n');
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
    return `Here are our clinic locations:\n\n${displayText}\n\n` + await this.renderMainMenu(session);
  }

  /**
   * Handle patient registration flow with support for "0/back/menu".
   * - At any prompt, typing "0"/"back"/"menu" cancels registration and returns to the Intro menu.
   * - Preserves your required fields order: first_name -> last_name -> email.
   * - Uses only ClinikoAPI.registerNewPatient; does not change Logger or API contracts.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleRegisterPatientState(session, message) {
    const log = this.logger.child({ component: 'RegisterPatient', sessionId: session?.id });
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const text = (message || '').trim();

    // Back/cancel to Intro menu from any step of registration
    if (['0', 'back', 'menu'].includes(text.toLowerCase())) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.INTRO,
        verified: false,
        data: null
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      log.info('Registration cancelled -> Intro');
      return await this.renderMainMenu(updatedSession);
    }

    const requiredFields = ['first_name', 'last_name', 'email'];
    let nextField = null;
    for (const field of requiredFields) {
      if (!data[field]) {
        nextField = field;
        break;
      }
    }

    if (nextField) {
      // If the user provided input, store it under the expected next field
      if (text) {
        data[nextField] = text;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        log.info('Collected field', { field: nextField });
      }

      // Prompt for the remaining field in order
      if (!data.first_name) return "Please tell me your first name:\n(0️⃣ Back)";
      if (!data.last_name) return "Got it. What's your last name?\n(0️⃣ Back)";
      if (!data.email) return "Thanks. Lastly, what's your email address?\n(0️⃣ Back)";
    }

    // All fields collected, now try registration
    const phoneNumber = session.phone_number || session.phoneNumber;
    if (!data.email || !phoneNumber) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.INTRO,
        verified: false
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      log.warn('Missing email or phone for registration');
      return "We need both email and phone number to complete registration.\n\n" + await this.renderMainMenu(updatedSession);
    }

    const patient = {
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      phone: phoneNumber
    };

    try {
      const result = await this.clinikoAPI.registerNewPatient(patient);
      if (result) {
        await this.sessionManager.updateSession(session.id, {
          verified: true,
          conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
          data: null // Clear registration data on success
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        log.info('Registration success', { email: patient.email });
        return `✅ You've been registered! Welcome ${patient.first_name}.\n\n` + await this.renderMainMenu(updatedSession);
      }
    } catch (err) {
      this.logger.error("Registration error:", err);
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.INTRO,
        verified: false,
        data: null
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      log.error('Registration failed', { error: err?.message });
      return (
        "❌ Error during registration (your details could not be registered, please check spelling or try again).\n\n"
        + (await this.renderMainMenu(updatedSession))
      );
    }
  }

  // ========== CANCEL WORKFLOW  ==========

  /**
   * Handle appointment cancellation flow.
   * @param {object} session
   * @param {string} message
   */
  async handleCancelAppointmentState(session, message) {
    const patient_id = session.patient_id;
    if (!patient_id) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VERIFY
      });
      return 'You need to be a registered patient to cancel appointments. Enter your email to verify your details first.';
    }

    // Fetch and enrich all future appointments
    let appts = await this.clinikoAPI.getBookingsByPatientId(patient_id);
    let futureAppts = appts.filter(a => new Date(a.starts_at) > new Date());
    if (!futureAppts.length) {
      return 'No upcoming appointments found to cancel.\n\n' + await this.goToInteractiveMenu(session);
    }
    futureAppts = await enrichAppointmentsForDisplay(futureAppts, this.clinikoAPI);
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.cancel_appt_list = futureAppts;

    if (futureAppts.length === 1) {
      data.selected_cancel_appt = futureAppts[0];
      data.selected_cancel_appt_idx = 0;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this._cancelPresentConfirmation(session, data, true);
    } else {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_APPOINTMENT_TO_CANCEL,
        data: JSON.stringify(data)
      });
      const listText = futureAppts.map((appt, idx) =>
        `${idx + 1}. ${appt._practitioner_display} — ${appt._appointment_type_display}\n   ${appt._display_dt}`
      ).join('\n');
      return `Your upcoming appointments:\n\n${listText}\n\nPlease reply with the number of the appointment you want to cancel, or "0" to go back.`;
    }
  }

  /**
   * Handle selection of which appointment to cancel.
   * @param {object} session
   * @param {string} message
   */
  async handleSelectAppointmentToCancelState(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const appts = data.cancel_appt_list || [];
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      delete data.cancel_appt_list;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !appts[idx]) {
      return 'Invalid selection. Please reply with the number of the appointment you want to cancel, or "0" to go back.';
    }
    data.selected_cancel_appt = appts[idx];
    data.selected_cancel_appt_idx = idx;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    return await this._cancelPresentConfirmation(session, data, false);
  }

  /**
   * Presents cancellation confirmation for a selected appointment.
   * Used by both the single-appointment and selection flows.
   * @param {object} session
   * @param {object} data
   * @param {boolean} isSingle (true if called from the "only one appt" shortcut)
  */
  async _cancelPresentConfirmation(session, data, isSingle) {
    const appt = data.selected_cancel_appt;
    if (!appt) {
      // Clean up
      delete data.cancel_appt_list;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
    }
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.CONFIRM_CANCEL,
      data: JSON.stringify(data)
    });
    const intro = isSingle
      ? `You have one upcoming appointment:\n\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n`
      : `You selected:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n`;
    return `${intro}\nType "yes" to confirm cancellation, or "0" to go back.`;
  }

  /**
   * Handle confirmation of cancellation of appointment.
   * @param {object} session
   * @param {string} message
   */
  async handleConfirmCancelState(session, message) {
    const text = message.trim().toLowerCase();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    if (['0', 'menu', 'back'].includes(text)) {
      delete data.cancel_appt_list;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }
    if (text === 'yes') {
      const appt = data.selected_cancel_appt;
      if (!appt?.id) {
        delete data.cancel_appt_list;
        delete data.selected_cancel_appt;
        delete data.selected_cancel_appt_idx;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
      }
      const result = await this.clinikoAPI.cancelSpecificAppointment(appt.id);
      delete data.cancel_appt_list;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      if (result.success) {
        return `✅ Your appointment has been canceled.\n\n` + await this.goToInteractiveMenu(session);
      } else {
        return `❌ Could not cancel your appointment. ${result.message || ''}\n\n` + await this.goToInteractiveMenu(session);
      }
    }
    const appt = data.selected_cancel_appt;
    return `Please type "yes" to confirm cancellation, or "0" to go back.\n\nYou are confirming:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}`;
  }

  // ========== RESCHEDULE WORKFLOW  ==========
  /**
   * Handle rescheduling flow: user selects which appointment to reschedule.
   * @param {object} session
   * @param {string} message
   */
  async handleRescheduleAppointmentState(session, message) {
    const patient_id = session.patient_id;
    if (!patient_id) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VERIFY
      });
      return 'You need to be a registered patient to reschedule appointments. Enter your email to verify your details first.';
    }

    // Fetch and enrich all future appointments
    let appts = await this.clinikoAPI.getBookingsByPatientId(patient_id);
    let futureAppts = appts.filter(a => new Date(a.starts_at) > new Date());
    if (!futureAppts.length) {
      return 'No upcoming appointments found to reschedule.\n\n' + await this.goToInteractiveMenu(session);
    }
    futureAppts = await enrichAppointmentsForDisplay(futureAppts, this.clinikoAPI);
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.reschedule_appt_list = futureAppts;

    if (futureAppts.length === 1) {
      // Set selection in data and jump to downstream logic
      data.selected_reschedule_appt = futureAppts[0];
      data.selected_reschedule_appt_idx = 0;
      await this.sessionManager.updateSession(session.id, {
        data: JSON.stringify(data)
      });
      return await this._reschedulePresentSlots(session, data, true);
    } else {
      // Multiple: show list and prompt for selection
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE,
        data: JSON.stringify(data)
      });
      const listText = futureAppts.map((appt, idx) =>
        `${idx + 1}. ${appt._practitioner_display} — ${appt._appointment_type_display}\n   ${appt._display_dt}`
      ).join('\n');
      return `Your upcoming appointments:\n\n${listText}\n\nPlease reply with the number of the appointment you want to reschedule, or "0" to go back.`;
    }
  } 

  /**
   * Handle selection of which appointment to reschedule.
   * @param {object} session
   * @param {string} message
   */
  async handleSelectAppointmentToRescheduleState(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const appts = data.reschedule_appt_list || [];
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, {
        data: JSON.stringify(data)
      });
      return await this.goToInteractiveMenu(session);
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !appts[idx]) {
      return 'Invalid selection. Please reply with the number of the appointment you want to reschedule, or "0" to go back.';
    }
    data.selected_reschedule_appt = appts[idx];
    data.selected_reschedule_appt_idx = idx;
    await this.sessionManager.updateSession(session.id, {
      data: JSON.stringify(data)
    });
    return await this._reschedulePresentSlots(session, data, false);
  } 

  /**
   * Presents available slots for a selected appointment (with pagination).
   * Used by both the single-appointment and selection flows.
   * @param {object} session
   * @param {object} data
   * @param {boolean} isSingle (true if called from the "only one appt" shortcut)
   */
  async _reschedulePresentSlots(session, data, isSingle) {
    const appt = data.selected_reschedule_appt;
    if (!appt) {
      // Clean up
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
    }
    const business_id = extractIdFromClinikoRef(appt.business, 'businesses');
    const practitioner_id = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const appointment_type_id = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    if (!business_id || !practitioner_id || !appointment_type_id) {
      // Clean up
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return (
        'Sorry, this appointment does not have enough information to find available slots for rescheduling. ' +
        'Please contact our clinic for assistance.\n\n' +
        await this.goToInteractiveMenu(session)
      );
    }
    const availableTimes = await this.clinikoAPI.getAvailableTimes({
      practitioner_id,
      business_id,
      appt_type: appointment_type_id
    });
    if (!availableTimes.length) {
      // Clean up
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Sorry, there are no available slots for this practitioner at this clinic for this appointment type. Please try again later.\n\n' + await this.goToInteractiveMenu(session);
    }
    data.available_times = availableTimes;
    data.slot_page = 0; // Reset slot page for new selection
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.CONFIRM_RESCHEDULE,
      data: JSON.stringify(data)
    });
    const slotList = formatPaginatedList({
      items: availableTimes,
      formatFn: (slot, i) => `${i}. ${new Date(slot.appointment_start).toLocaleString()}`,
      page: 0,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More slots',
      header: ''
    });
    const intro = isSingle
      ? `You have one upcoming appointment:\n\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n`
      : `You selected to reschedule:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n`;
    return `${intro}\nPlease choose a new slot:\n\n${slotList}\n\nReply with the number of your chosen slot, "M" for more, or "0" to go back.`;
  }

  /**
   * Handle confirmation of rescheduling, with slot pagination.
   * @param {object} session
   * @param {string} message
   */
  async handleConfirmRescheduleState(session, message) {
    const text = message.trim();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const appt = data.selected_reschedule_appt;
    const availableTimes = data.available_times || [];
    let slot_page = data.slot_page || 0;

    // Slot pagination
    if (['m', 'more'].includes(text.toLowerCase())) {
      slot_page = slot_page + 1;
      data.slot_page = slot_page;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.CONFIRM_RESCHEDULE,
        data: JSON.stringify(data)
      });
      const slotList = formatPaginatedList({
        items: availableTimes,
        formatFn: (slot, i) => `${i}. ${new Date(slot.appointment_start).toLocaleString()}`,
        page: slot_page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header: ''
      });
      const intro = appt
        ? `You are rescheduling:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n`
        : '';
      return `${intro}\nPlease choose a new slot:\n\n${slotList}\n\nReply with the number of your chosen slot, "M" for more, or "0" to go back.`;
    }

    if (['0', 'menu', 'back'].includes(text.toLowerCase())) {
      // Clean up session data
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      delete data.available_times;
      delete data.slot_page;
      await this.sessionManager.updateSession(session.id, {
        data: JSON.stringify(data)
      });
      return await this.goToInteractiveMenu(session);
    }

    // Parse slot selection with pagination offset
    const idx = parseInt(text, 10) - 1 ;
    if (isNaN(idx) || !availableTimes[idx]) {
      return 'Invalid slot selection. Please reply with the number of your chosen slot, "M" for more, or "0" to go back.' +
        (appt? `\n\nYou are rescheduling:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}` : '');
    }
    const slot = availableTimes[idx];
    if (!appt?.id) {
      // Clean up session data
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      delete data.available_times;
      delete data.slot_page;
      await this.sessionManager.updateSession(session.id, {
        data: JSON.stringify(data)
      });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
    }
    const business_id = extractIdFromClinikoRef(appt.business, 'businesses');
    const practitioner_id = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const appointment_type_id = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    const patient_id = session.patient_id;
    const starts_at = slot.starts_at || slot.appointment_start || slot.slot;
    let ends_at = slot.ends_at || slot.appointment_end;
    if (!ends_at) {
      ends_at = new Date(new Date(starts_at).getTime() + 30 * 60000).toISOString();
    }
    if (!business_id || !practitioner_id || !appointment_type_id || !patient_id || !starts_at) {
      // Clean up session data
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      delete data.available_times;
      delete data.slot_page;
      await this.sessionManager.updateSession(session.id, {
        data: JSON.stringify(data)
      });
      return 'Could not retrieve all necessary details for rescheduling. Please try again or contact the clinic.\n\n' + await this.goToInteractiveMenu(session);
    }
    const payload = {
      appointment_type_id,
      business_id,
      patient_id,
      practitioner_id,
      starts_at,
      ends_at
    };
    const result = await this.clinikoAPI.updateIndividualAppointment(appt.id, payload);

    // Clean up session data
    delete data.reschedule_appt_list;
    delete data.selected_reschedule_appt;
    delete data.selected_reschedule_appt_idx;
    delete data.available_times;
    delete data.slot_page;
    await this.sessionManager.updateSession(session.id, {
      data: JSON.stringify(data)
    });

    if (result.success) {
      return `✅ Your appointment has been rescheduled to:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${new Date(payload.starts_at).toLocaleString()}\n\n` + await this.goToInteractiveMenu(session);
    } else {
      return `❌ Could not reschedule your appointment. ${result.message || ''}\n\n` + await this.goToInteractiveMenu(session);
    }
  }

} // End of Class

module.exports = ChatbotEngine;
