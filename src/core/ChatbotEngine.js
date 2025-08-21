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
  return '';
}

/**
 * Enriches appointments with display fields (_practitioner_display, _appointment_type_display, etc.)
 * by fetching all relevant related objects in parallel.
 * @param {Array<Object>} appointments
 * @param {ClinikoAPI} clinikoAPI
 * @returns {Promise<Array<Object>>} Enriched appointments
 */
// This is a direct, no-abstraction, no-generics version of your function with full logging.

async function enrichAppointmentsForDisplay(appointments, clinikoAPI) {
  const practitionerIds = new Set();
  const apptTypeIds = new Set();
  const businessIds = new Set();

  // Log incoming appointment objects (should be output of slotToEnrichable)
  console.log('--- ENRICH: incoming appointments ---');
  for (const appt of appointments) {
    console.log('APPOINTMENT:', appt);

    const practitionerId = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const apptTypeId = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    const businessId = extractIdFromClinikoRef(appt.business, 'businesses');

    console.log(`[ENRICH] Extracted practitionerId=${practitionerId}, apptTypeId=${apptTypeId}, businessId=${businessId}`);

    if (practitionerId) practitionerIds.add(practitionerId);
    if (apptTypeId) apptTypeIds.add(apptTypeId);
    if (businessId) businessIds.add(businessId);
  }

  // Fetch all entities in parallel and log results
  const [practitioners, apptTypes, businesses] = await Promise.all([
    Promise.all([...practitionerIds].map(id => clinikoAPI.getPractitionerById(id).then(obj => [id, obj]))),
    Promise.all([...apptTypeIds].map(id => clinikoAPI.getAppointmentTypeById(id).then(obj => [id, obj]))),
    Promise.all([...businessIds].map(id => clinikoAPI.getBusinessById(id).then(obj => [id, obj])))
  ]);

  const practitionerMap = Object.fromEntries(practitioners);
  const apptTypeMap = Object.fromEntries(apptTypes);
  const businessMap = Object.fromEntries(businesses);

  console.log('--- ENRICH: practitionerMap ---');
  console.log(practitionerMap);
  console.log('--- ENRICH: apptTypeMap ---');
  console.log(apptTypeMap);
  console.log('--- ENRICH: businessMap ---');
  console.log(businessMap);

  for (const appt of appointments) {
    const practitionerId = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const apptTypeId = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    const businessId = extractIdFromClinikoRef(appt.business, 'businesses');

    const practitionerObj = practitionerMap[practitionerId] || null;
    const apptTypeObj = apptTypeMap[apptTypeId] || null;
    const businessObj = businessMap[businessId] || null;

    // Log the final objects and IDs for this appointment
  console.log('BUSINESS OBJ FOR', businessId, ':', businessObj);
    console.log(`--- ENRICH: Final lookup for appointment ---`);
    console.log({
      appt,
      practitionerId,
      apptTypeId,
      businessId,
      practitionerObj,
      apptTypeObj,
      businessObj
    });

    // Your original display assignment logic (unchanged)
    appt._practitioner_display = getPractitionerDisplayName(practitionerObj);
    appt._appointment_type_display = getAppointmentTypeDisplayName(apptTypeObj);
    appt._business_display = getBusinessDisplayName(businessObj);
    appt._display_dt = new Date(appt.starts_at).toLocaleString();

    // Log the final display fields
    console.log('ENRICHED DISPLAY FIELDS:', {
      _practitioner_display: appt._practitioner_display,
      _appointment_type_display: appt._appointment_type_display,
      _business_display: appt._business_display,
      _display_dt: appt._display_dt
    });
  }
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
 * @param {Object} slot
 * @param {number} idx - 1-based index for display
 * @returns {string}
 */
function formatSlotItem(slot, idx) {
  const dt = new Date(slot.slot);
  return `${idx}. ${slot.practitioner_name} — ${slot.appointment_type_name}\n   ${dt.toLocaleString()}`;
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
      "\n\nNeed help? Call us at +65 6123 4567 or email support@prohealth.com.sg"
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
    if (!session.verified) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.renderMainMenu(updatedSession);
    }

    if (session.conversation_state === this.STATES.BOOKING_METHOD_OPTIONS) {
      return await this.renderBookingMethodMenu(session);
    }
    // Add more as needed (manage, cancel, etc.)
    // Falling through here
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_MANAGE_OPTIONS });
    const updatedSession = await this.sessionManager.getSession(session.id);
    return await this.renderMainMenu(session);
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
   * Render the correct main menu based on verification.
   * @param {object} session
   */
  async renderMainMenu(session) {
    if (session.verified) {
      return (
        `What would you like to do?\n\n` +
        `1️⃣ Book Appointment\n` +
        `2️⃣ Cancel Appointment\n` +
        `3️⃣ Reschedule Appointment\n` +
        `9️⃣ Logout & Delete Data\n\n` +
        `Reply with the number or a keyword.`
      );
    } else {
      return (
        `👋 *Welcome to ProHealthAsia*\n\n` +
        `Please select an option:\n` +
        `1️⃣ Book or Manage Appointment\n` +
        `2️⃣ View Fees\n` +
        `3️⃣ View Locations\n` +
        `4️⃣ Register as New Patient\n\n` +
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
        "Please try again later. If the problem continues, contact us at +65 6123 4567 or email support@prohealth.com.sg"
      );
    }
  }

  // ====== STATE HANDLERS ======

  /**
   * Handle the intro state (first message).
   * @param {object} session
   * @param {string} message
   */
  async handleIntroState(session, message) {
    if (session.verified) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS
      });
      return await this.renderMainMenu(session);
    }
    const text = message.trim().toLowerCase();
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
    return `Sorry, I didn't understand that.\n\n` + await this.renderMainMenu(session);
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
        "\n\nNeed help? Call us at +65 6123 4567 or email support@prohealth.com.sg"
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
   * Book based on last appointment's physio and type.
   * @param {object} session
   * @param {string} message
   */
  async handleBookHistory(session, message) {
    const patient_id = session.patient_id;
    if (!patient_id) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, verified: false });
      return 'Cannot find your patient id. Trying logging in again' + await this.renderMainMenu(session);
    }
    const latest = await this.clinikoAPI.getLatestAppointmentSummaryForPatient(patient_id);
    if (!latest) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS });
      return "No recent appointment found. Please choose another booking option.\n\n" + await this.goToInteractiveMenu(session);
    }
    const practitioner_id = extractIdFromClinikoRef(latest.practitioner, 'practitioners');
    const business_id = extractIdFromClinikoRef(latest.business, 'businesses');
    const slots = await this.clinikoAPI.getNextAvailableSlots({
      practitioner_id,
      business_id
    });
    if (!slots.length) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS });
      return "No available slots for your previous physio. Please choose another booking method." + await this.goToInteractiveMenu(session);
    }
    let data = {};
    data.slot_list = slots;
    data.slot_page = 0;
    data.selected_physio = { id: practitioner_id };
    data.selected_clinic = { id: business_id };
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_SLOT,
      data: JSON.stringify(data)
    });
    const reply = formatPaginatedList({
      items: slots,
      formatFn: formatSlotItem,
      page: 0,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More slots',
      header: 'Available slots with your last physio:'
    }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
    return reply;
  }
  

  /**
   * Book soonest available appointment, with pagination for slots, clinics and physios.
   * @param {object} session
   * @param {string} message
   */
  async handleBookSoonest(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const text = (message || '').trim().toLowerCase();

    // Always use a flow step marker
    if (!data.selection_step) data.selection_step = 'choose_type';

    // "Back" to booking method menu ONLY from root step
    if (['0', 'menu', 'back'].includes(text) && data.selection_step === 'choose_type') {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.goToInteractiveMenu(updatedSession);
    }

    // ---- Choose type: Any / Clinic / Physio ----
    if (data.selection_step === 'choose_type') {
      if (!text) {
        return "Do you have a preference for clinic or physio?\n\n1️⃣ Any\n2️⃣ Choose clinic\n3️⃣ Choose physio\n\nReply with number. (0️⃣ Back)";
      }
      if (text === '1' || text.includes('any')) {
        const clinics = await this.clinikoAPI.getClinics();
        if (!clinics.length) {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
            data: null
          });
          const updatedSession = await this.sessionManager.getSession(session.id);
          return "No clinics found. Please try again.";
        }
        const business_id = clinics[0].id;
        const slots = await this.clinikoAPI.getNextAvailableSlotsByBusiness({ business_id });
        if (!slots.length) {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
            data: null
          });
          const updatedSession = await this.sessionManager.getSession(session.id);
          return "No available slots. Please try another method.";
        }
        const slotData = {
          slot_list: slots,
          slot_page: 0
        };
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_SLOT,
          data: JSON.stringify(slotData)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const reply = formatPaginatedList({
          items: slots,
          formatFn: formatSlotItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More slots',
          header: 'Soonest available slots:'
        }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
        return reply;
      }
      if (text === '2' || text.includes('clinic')) {
        const clinics = await this.clinikoAPI.getClinics();
        data.clinic_list = clinics;
        data.clinic_page = 0;
        data.selection_step = 'choose_clinic';
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SOONEST,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const reply = formatPaginatedList({
          items: clinics,
          formatFn: (c, idx) => `${idx}. ${c.business_name}\n `,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: 'Select a clinic:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      if (text === '3' || text.includes('physio')) {
        const physiosByClinic = await this.clinikoAPI.getPractitionersByClinic();
        // Deduplicate physios by ID
        const physioMap = new Map();
        for (const { clinic_id, clinic_name, practitioners } of physiosByClinic) {
          for (const p of practitioners) {
            if (!physioMap.has(p.id)) {
              physioMap.set(p.id, { ...p, clinic_id, clinic_name });
            }
          }
        }
        const physioList = Array.from(physioMap.values());
        data.physio_list = physioList;
        data.physio_page = 0;
        data.selection_step = 'choose_physio';
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SOONEST,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const reply = formatPaginatedList({
          items: physioList,
          formatFn: formatPhysioItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More physios',
          header: 'Select a physiotherapist:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      // If unrecognized input, show menu again
      return "Do you have a preference for clinic or physio?\n\n1️⃣ Any\n2️⃣ Choose clinic\n3️⃣ Choose physio\n\nReply with number. (0️⃣ Back)";
    }

    // ---- Back from clinic list goes to choose_type ----
    if (data.selection_step === 'choose_clinic' && ['0', 'menu', 'back'].includes(text)) {
      data.selection_step = 'choose_type';
      delete data.clinic_list;
      delete data.clinic_page;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SOONEST,
        data: JSON.stringify(data)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleBookSoonest(updatedSession, '');
    }

    // ---- Clinic list pagination and selection ----
    if (data.selection_step === 'choose_clinic') {
      if (text === 'm' || text === 'more') {
        data.clinic_page = (data.clinic_page || 0) + 1;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SOONEST,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const page = data.clinic_page;
        const reply = formatPaginatedList({
          items: data.clinic_list,
          formatFn: (c, idx) => `${idx}. ${c.business_name}\n `,
          page,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: 'Select a clinic:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      if (/^\d+$/.test(text)) {
        const clinics = data.clinic_list;
        const idx = parseInt(text, 10) - 1;
        if (!clinics[idx]) {
          return 'Invalid clinic selection. Reply with a number from the list.';
        }
        const business_id = clinics[idx].id;
        const slots = await this.clinikoAPI.getNextAvailableSlotsByBusiness({ business_id });
        if (!slots.length) {
          return "No available slots for that clinic. Please try another.";
        }
        const slotData = {
          slot_list: slots,
          slot_page: 0
        };
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_SLOT,
          data: JSON.stringify(slotData)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const reply = formatPaginatedList({
          items: slots,
          formatFn: formatSlotItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More slots',
          header: `Soonest slots for ${clinics[idx].business_name}:`
        }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
        return reply;
      }
      // Fallback to menu
      const clinics = data.clinic_list;
      const page = data.clinic_page || 0;
      const reply = formatPaginatedList({
        items: clinics,
        formatFn: (c, idx) => `${idx}. ${c.business_name}\n `,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: 'Select a clinic:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // ---- Back from physio list goes to choose_type ----
    if (data.selection_step === 'choose_physio' && ['0', 'menu', 'back'].includes(text)) {
      data.selection_step = 'choose_type';
      delete data.physio_list;
      delete data.physio_page;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SOONEST,
        data: JSON.stringify(data)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleBookSoonest(updatedSession, '');
    }

    // ---- Physio list pagination and selection ----
    if (data.selection_step === 'choose_physio') {
      if (text === 'm' || text === 'more') {
        data.physio_page = (data.physio_page || 0) + 1;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SOONEST,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const page = data.physio_page;
        const reply = formatPaginatedList({
          items: data.physio_list,
          formatFn: formatPhysioItem,
          page,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More physios',
          header: 'Select a physiotherapist:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      if (/^\d+$/.test(text)) {
        const physios = data.physio_list;
        const idx = parseInt(text, 10) - 1;
        if (!physios[idx]) {
          return 'Invalid physiotherapist selection. Reply with a number from the list.';
        }
        const selectedPhysio = physios[idx];
        const slots = await this.clinikoAPI.getNextAvailableSlots({
          practitioner_id: selectedPhysio.id,
          business_id: selectedPhysio.clinic_id
        });
        if (!slots.length) {
          return "No available slots for that physiotherapist. Please try another.";
        }
        const slotData = {
          slot_list: slots,
          slot_page: 0
        };
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_SLOT,
          data: JSON.stringify(slotData)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const reply = formatPaginatedList({
          items: slots,
          formatFn: formatSlotItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More slots',
          header: `Soonest slots for ${selectedPhysio.display_name || selectedPhysio.first_name}:`
        }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
        return reply;
      }
      // Fallback to menu
      const physios = data.physio_list;
      const page = data.physio_page || 0;
      const reply = formatPaginatedList({
        items: physios,
        formatFn: formatPhysioItem,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More physios',
        header: 'Select a physiotherapist:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Final fallback
    return "Please reply with a valid option.";
  }

  /**
   * Book at a specific date, with pagination for date, clinic, physio, and slots.
   * @param {object} session
   * @param {string} message
   */
  async handleBookSpecificDate(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const text = (message || '').trim().toLowerCase();

    if (!data.selection_step) data.selection_step = 'choose_date';

    // Go up from clinic/physio selection to choose_type
    if (data.selection_step === 'choose_clinic' && ['0', 'menu', 'back'].includes(text)) {
      data.selection_step = 'choose_type';
      delete data.clinic_list;
      delete data.clinic_page;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
        data: JSON.stringify(data)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleBookSpecificDate(updatedSession, '');
    }
    if (data.selection_step === 'choose_physio' && ['0', 'menu', 'back'].includes(text)) {
      data.selection_step = 'choose_type';
      delete data.physio_list;
      delete data.physio_page;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
        data: JSON.stringify(data)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleBookSpecificDate(updatedSession, '');
    }
    // Go up from choose_type or choose_date to booking method menu
    if (
      ['0', 'menu', 'back'].includes(text) &&
      (data.selection_step === 'choose_type' || data.selection_step === 'choose_date')
    ) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.goToInteractiveMenu(updatedSession);
    }

    // ---- Date selection and pagination ----
    if (data.selection_step === 'choose_date') {
      // Pagination request
      if (text === 'm' || text === 'more') {
        data.date_page = (data.date_page || 0) + 1;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        return await this.handleBookSpecificDate(updatedSession, '');
      }

      // Date number selection
      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        const page = data.date_page || 0;
        const today = new Date();
        today.setDate(today.getDate() + (page * MAX_DATE_ITEMS) + 1);
        const dates = getNextAvailableDates(today, MAX_DATE_ITEMS, MAX_DATE_ITEMS * MAX_DATE_PAGES - page * MAX_DATE_ITEMS);
        if (!dates[idx]) {
          return "Invalid selection. Please choose a number from the list.";
        }
        data.selected_date = dates[idx].toISOString().slice(0, 10);
        data.selection_step = 'choose_type';
        data.date_page = 0;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        return "Would you like to choose by:\n1️⃣ Clinic\n2️⃣ Physio\n\nReply with number. (0️⃣ Back)";
      }

      // Show paginated date menu
      const page = data.date_page || 0;
      const today = new Date();
      today.setDate(today.getDate() + (page * MAX_DATE_ITEMS) + 1);
      const dates = getNextAvailableDates(today, MAX_DATE_ITEMS, MAX_DATE_ITEMS * MAX_DATE_PAGES - page * MAX_DATE_ITEMS);
      let menu = dates.map((d, i) =>
        `${i + 1}. ${d.toISOString().slice(0, 10)} (${d.toLocaleDateString(undefined, { weekday: 'long' })})`
      ).join('\n');
      if ((page + 1) * MAX_DATE_ITEMS < MAX_DATE_ITEMS * MAX_DATE_PAGES) {
        menu += `\nM. More dates`;
      }
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
        data: JSON.stringify({ ...data, date_page: page })
      });
      return `Please choose a date for your appointment:\n\n${menu}\n\nReply with the number or M for more dates. (0️⃣ Back)`;
    }

    // ---- Choose by clinic or physio after date is picked ----
    if (data.selection_step === 'choose_type') {
      if (text === '1' || text.includes('clinic')) {
        const clinics = await this.clinikoAPI.getClinics();
        data.clinic_list = clinics;
        data.clinic_page = 0;
        data.selection_step = 'choose_clinic';
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const reply = formatPaginatedList({
          items: clinics,
          formatFn: (c, idx) => `${idx}. ${c.business_name}\n `,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: 'Select a clinic:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      if (text === '2' || text.includes('physio')) {
        const physiosByClinic = await this.clinikoAPI.getPractitionersByClinic();
        // Deduplicate physios by ID
        const physioMap = new Map();
        for (const { clinic_id, clinic_name, practitioners } of physiosByClinic) {
          for (const p of practitioners) {
            if (!physioMap.has(p.id)) {
              physioMap.set(p.id, { ...p, clinic_id, clinic_name });
            }
          }
        }
        const physioList = Array.from(physioMap.values());
        data.physio_list = physioList;
        data.physio_page = 0;
        data.selection_step = 'choose_physio';
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const reply = formatPaginatedList({
          items: physioList,
          formatFn: formatPhysioItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More physios',
          header: 'Select a physiotherapist:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      // Show the menu again on unrecognized input
      return "Would you like to choose by:\n1️⃣ Clinic\n2️⃣ Physio\n\nReply with number. (0️⃣ Back)";
    }

    // ---- Clinic pagination and selection ----
    if (data.selection_step === 'choose_clinic') {
      if (text === 'm' || text === 'more') {
        data.clinic_page = (data.clinic_page || 0) + 1;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const page = data.clinic_page;
        const reply = formatPaginatedList({
          items: data.clinic_list,
          formatFn: (c, idx) => `${idx}. ${c.business_name}\n `,
          page,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: 'Select a clinic:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      if (/^\d+$/.test(text)) {
        const clinics = data.clinic_list;
        const idx = parseInt(text, 10) - 1;
        if (!clinics[idx]) {
          return 'Invalid clinic selection. Reply with a number from the list.';
        }
        const business_id = clinics[idx].id;
        const from = data.selected_date;
        const to = data.selected_date;
        try {
          const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({ business_id, from, to });
          if (!slots.length) {
            return "No available slots for that clinic on that date. Please try another.";
          }
          const slotData = {
            slot_list: slots,
            slot_page: 0
          };
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.SELECT_SLOT,
            data: JSON.stringify(slotData)
          });
          const updatedSession = await this.sessionManager.getSession(session.id);
          const reply = formatPaginatedList({
            items: slots,
            formatFn: formatSlotItem,
            page: 0,
            pageSize: MAX_SLOT_ITEMS,
            moreLabel: 'M. More slots',
            header: `Available slots at ${clinics[idx].business_name} on ${data.selected_date}:`
          }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
          return reply;
        } catch (error) {
          return "There was a problem fetching available slots. Please try again later.";
        }
      }
      // Fallback to menu
      const clinics = data.clinic_list;
      const page = data.clinic_page || 0;
      const reply = formatPaginatedList({
        items: clinics,
        formatFn: (c, idx) => `${idx}. ${c.business_name}\n `,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: 'Select a clinic:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // ---- Physio pagination and selection ----
    if (data.selection_step === 'choose_physio') {
      if (text === 'm' || text === 'more') {
        data.physio_page = (data.physio_page || 0) + 1;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
          data: JSON.stringify(data)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        const page = data.physio_page;
        const reply = formatPaginatedList({
          items: data.physio_list,
          formatFn: formatPhysioItem,
          page,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More physios',
          header: 'Select a physiotherapist:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      if (/^\d+$/.test(text)) {
        const physios = data.physio_list;
        const idx = parseInt(text, 10) - 1;
        if (!physios[idx]) {
          return 'Invalid physiotherapist selection. Reply with a number from the list.';
        }
        const selectedPhysio = physios[idx];
        const from = data.selected_date;
        const to = data.selected_date;
        try {
          const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
            business_id: selectedPhysio.clinic_id,
            practitioner_id: selectedPhysio.id,
            from,
            to
          });
          if (!slots.length) {
            return "No available slots for that physiotherapist on that date. Please try another.";
          }
          const slotData = {
            slot_list: slots,
            slot_page: 0
          };
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.SELECT_SLOT,
            data: JSON.stringify(slotData)
          });
          const updatedSession = await this.sessionManager.getSession(session.id);
          const reply = formatPaginatedList({
            items: slots,
            formatFn: formatSlotItem,
            page: 0,
            pageSize: MAX_SLOT_ITEMS,
            moreLabel: 'M. More slots',
            header: `Available slots for ${selectedPhysio.display_name || selectedPhysio.first_name} on ${data.selected_date}:`
          }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
          return reply;
        } catch (error) {
          return "There was a problem fetching available slots. Please try again later.";
        }
      }
      // Fallback to menu
      const physios = data.physio_list;
      const page = data.physio_page || 0;
      const reply = formatPaginatedList({
        items: physios,
        formatFn: formatPhysioItem,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More physios',
        header: 'Select a physiotherapist:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Final fallback
    return "Please reply with a valid option.";
  }
  

  /**
   * Book by picking a physio directly, then optionally clinic if physio is at multiple clinics.
   * @param {object} session
   * @param {string} message
   */
  async handleBookSpecificPhysio(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    let text = (message || '').trim().toLowerCase();

    // Handle "0"/"back" at the physio list level (returns to booking method options if not in clinic subflow)
    if (
      ['0', 'menu', 'back'].includes((message || '').trim().toLowerCase())
      && !(data.selected_physio && data.clinics_for_physio)
    ) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return await this.goToInteractiveMenu(session);
    }

    // 1. Paging for physio list (when not in a clinic selection subflow)
    if (data.physio_list && !data.selected_physio && (text === 'm' || text === 'more')) {
      data.physio_page = (data.physio_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
        data: JSON.stringify(data)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleBookSpecificPhysio(updatedSession, '');
    }

    // 2. Paging for clinic list (when in clinic selection subflow)
    if (data.selected_physio && data.clinics_for_physio && (text === 'm' || text === 'more')) {
      data.clinic_page = (data.clinic_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
        data: JSON.stringify(data)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleBookSpecificPhysio(updatedSession, '');
    }

    // 3. Clinic selection for the selected physio (must handle before physio selection)
    if (data.selected_physio && data.clinics_for_physio) {
      
      if (['0', 'menu', 'back'].includes(text)) {
        // Remove clinic selection state, go back to physio list
        delete data.selected_physio;
        delete data.clinics_for_physio;
        delete data.clinic_page;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
          data: JSON.stringify(data)
        });
        // Show current physio page again
        const physios = data.physio_list;
        const physioPage = data.physio_page || 0;
        const reply = formatPaginatedList({
          items: physios,
          formatFn: formatPhysioItem,
          page: physioPage,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More physios',
          header: 'Select a physiotherapist:'
        }) + `\n\nReply with number.`;
        return reply;
      }

      const clinicsForPhysio = data.clinics_for_physio;
      const page = data.clinic_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= clinicsForPhysio.length) {
          return 'Invalid clinic selection. Reply with a number from the list.';
        }
        const selectedClinic = clinicsForPhysio[idx];
        // Show slots for this physio at this clinic
        const slots = await this.clinikoAPI.getNextAvailableSlots({
          practitioner_id: data.selected_physio.id,
          business_id: selectedClinic.clinic_id
        });
        if (!slots.length) {
          return "No available slots for that physiotherapist at this clinic. Please try another.";
        }
        // Clean up subflow data
        delete data.clinics_for_physio;
        delete data.selected_physio;
        data.slot_list = slots;
        data.slot_page = 0;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_SLOT,
          data: JSON.stringify(data)
        });
        const reply = formatPaginatedList({
          items: slots,
          formatFn: formatSlotItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More slots',
          header: `Available slots for ${data.selected_physio?.display_name || data.selected_physio?.first_name} at ${selectedClinic.clinic_name}:`
        }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
        return reply;
      }
      // Show paginated clinic list again
      const reply = formatPaginatedList({
        items: clinicsForPhysio,
        formatFn: (c, idx) => `${idx}. ${c.clinic_name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: `Select a clinic for ${data.selected_physio.display_name || data.selected_physio.first_name}:`
      }) + `\n\nReply with the number of your preferred clinic.`;
      return reply;
    }

    // 4. Initial physio list (unique physios only)
    if (!data.physio_list) {
      // Build a unique physio list
      const physiosByClinic = await this.clinikoAPI.getPractitionersByClinic();
      const physioMap = new Map();
      for (const { practitioners } of physiosByClinic) {
        for (const p of practitioners) {
          if (!physioMap.has(p.id)) {
            physioMap.set(p.id, p);
          }
        }
      }
      const physioList = Array.from(physioMap.values());
      data.physio_list = physioList;
      data.physio_page = 0;
      // For clinic lookup later
      data.physios_by_clinic = physiosByClinic;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
        data: JSON.stringify(data)
      });
      // Show first page
      const page = 0;
      const reply = formatPaginatedList({
        items: physioList,
        formatFn: formatPhysioItem,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More physios',
        header: 'Select a physiotherapist:'
      }) + `\n\nReply with number.`;
      return reply;
    }

    // 5. Physio selection
    const physios = data.physio_list;
    const page = data.physio_page || 0;
    if (!isNaN(text) && text !== '') {
      const idx = parseInt(text, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= physios.length) {
        return 'Invalid physiotherapist selection. Reply with a number from the list.';
      }
      const selectedPhysio = physios[idx];

      // Find all clinics this physio practices at (from physios_by_clinic)
      const physiosByClinic = data.physios_by_clinic;
      const clinicsForPhysio = [];
      const seenClinicIds = new Set();
      for (const { clinic_id, clinic_name, practitioners } of physiosByClinic) {
        if (practitioners.some(p => p.id == selectedPhysio.id)) {
          if (!seenClinicIds.has(clinic_id)) {
            clinicsForPhysio.push({ clinic_id, clinic_name });
            seenClinicIds.add(clinic_id);
          }
        }
      }

      if (clinicsForPhysio.length > 1) {
        // Save subflow state
        data.selected_physio = selectedPhysio;
        data.clinics_for_physio = clinicsForPhysio;
        data.clinic_page = 0;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
          data: JSON.stringify(data)
        });
        const reply = formatPaginatedList({
          items: clinicsForPhysio,
          formatFn: (c, idx) => `${idx}. ${c.clinic_name}`,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: `Select a clinic for ${selectedPhysio.display_name || selectedPhysio.first_name}:`
        }) + `\n\nReply with the number of your preferred clinic.`;
        return reply;
      }

      // Only one clinic: show slots immediately
      const chosenClinic = clinicsForPhysio[0];
      const slots = await this.clinikoAPI.getNextAvailableSlots({
        practitioner_id: selectedPhysio.id,
        business_id: chosenClinic?.clinic_id || selectedPhysio.clinic_id
      });
      if (!slots.length) {
        return "No available slots for that physiotherapist. Please try another.";
      }
      data.slot_list = slots;
      data.slot_page = 0; // reset paging for slots
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      const reply = formatPaginatedList({
        items: slots,
        formatFn: formatSlotItem,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header: `Available slots for ${selectedPhysio.display_name || selectedPhysio.first_name}${chosenClinic ? ' at ' + chosenClinic.clinic_name : ''}:`
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }

    // 6. Show current physio page
    const reply = formatPaginatedList({
      items: physios,
      formatFn: formatPhysioItem,
      page,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More physios',
      header: 'Select a physiotherapist:'
    }) + `\n\nReply with number.`;
    return reply;
  }
  
  /**
   * Book by picking a clinic directly.
   * @param {object} session
   * @param {string} message
   */
  async handleBookSpecificClinic(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    let text = (message || '').trim().toLowerCase();
    if (['0', 'menu', 'back'].includes((message || '').trim().toLowerCase())) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return await this.goToInteractiveMenu(session);
    }
    // Paging for clinic list
    if (data.clinic_list && (text === 'm' || text === 'more')) {
      data.clinic_page = (data.clinic_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
        data: JSON.stringify(data)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleBookSpecificClinic(updatedSession, '');
    }

    if (!data.clinic_list) {
      const clinics = await this.clinikoAPI.getClinics();
      data.clinic_list = clinics;
      data.clinic_page = 0;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
        data: JSON.stringify(data)
      });
      const reply = formatPaginatedList({
        items: clinics,
        formatFn: (c, idx) => `${idx}. ${c.business_name}\n `,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: 'Select a clinic:'
      }) + `\n\nReply with number.`;
      return reply;
    }
    const clinics = data.clinic_list;
    const page = data.clinic_page || 0;
    if (!isNaN(text) && text !== '') {
      const idx = parseInt(text, 10) - 1 ;
      if (isNaN(idx) || !clinics[idx]) {
        return 'Invalid clinic selection. Reply with a number from the list.';
      }
      const business_id = clinics[idx].id;
      // Show slots for that clinic (all practitioners)
      const slots = await this.clinikoAPI.getNextAvailableSlotsByBusiness({ business_id });
      if (!slots.length) {
        return "No available slots for that clinic. Please try another.";
      }
      data.slot_list = slots;
      data.slot_page = 0;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      const reply = formatPaginatedList({
        items: slots,
        formatFn: formatSlotItem,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header: `Available slots at ${clinics[idx].business_name}:`
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }
    // Show clinic page
    const reply = formatPaginatedList({
      items: clinics,
      formatFn: (c, idx) => `${idx}. ${c.business_name}\n `,
      page,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More clinics',
      header: 'Select a clinic:'
    }) + `\n\nReply with number.`;
    return reply;
  }

  // ==== SLOT SELECTION & CONFIRMATION (RE-USE YOUR EXISTING LOGIC) ====

  /**
   * Handles user selection of an appointment slot in any workflow leading to SELECT_SLOT state.
   * @param {object} session - The user session object.
   * @param {string} message - The user's input (expected: slot number).
   * @returns {Promise<string>} Message to send to the user.
   */
  async handleSelectSlotState(session, message) {
    let data;
    try {
      data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    } catch (e) {
    }
    const slots = Array.isArray(data.slot_list) ? data.slot_list : [];
    let text = (message || '').trim().toLowerCase();

    // Paging: next page of slots
    if (text === 'm' || text === 'more') {
      data.slot_page = (data.slot_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      // Recursively call for next page
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleSelectSlotState(updatedSession, '');
    }

    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return await this.goToInteractiveMenu(session);
    }

    if (!slots.length) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return "Sorry, I couldn't find any available appointment slots. Please try again.";
    }
    const page = data.slot_page || 0;
    // Only parse number if not paging
    if (!isNaN(text) && text !== '') {
      const idx = parseInt(text, 10) - 1 ;
      if (isNaN(idx) || idx < 0 || idx >= slots.length) {
        return 'Invalid slot selection. Please reply with a number from the list, or 0️⃣ to go back.';
      }
      const selectedSlot = slots[idx];
      data.selected_slot = selectedSlot;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.CONFIRM_BOOKING,
        data: JSON.stringify(data)
      });
      const dt = new Date(selectedSlot.slot);
      return (
        `You have selected:\n\n` +
        `👨‍⚕️ *${selectedSlot.practitioner_name}*\n` +
        `🏥 *${selectedSlot.business_name || ''}*\n` +
        `🗓️ ${dt.toLocaleString()}\n\n` +
        `Reply YES to confirm, or 0️⃣ to cancel.`
      );
    }
    // Show paginated slot list
    const reply = formatPaginatedList({
      items: slots,
      formatFn: formatSlotItem,
      page,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More slots',
      header: 'Available slots:'
    }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
    return reply;
  }

  /**
   * Handle confirmation of booking slot.
   * @param {object} session
   * @param {string} message
   */
  /*
  async handleConfirmBookingState(session, message) {
    const text = message.trim().toLowerCase();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return 'How would you like to book?\n\n1️⃣ Based on your last physio visit\n2️⃣ Soonest available\n3️⃣ At specific date\n4️⃣ Pick a specific physio\n5️⃣ Pick a specific clinic\n\nReply with number or keyword.';
    }
    if (text === 'yes') {
      const patient_id = session.patient_id;
      const slot = data.selected_slot;
      if (!patient_id || !slot) {
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, verified: false });
        return 'Cannot proceed with booking. Please start again.\n\n' + await this.renderMainMenu(session);
      }
      const result = await this.clinikoAPI.bookAppointment({
        patient_id,
        practitioner_id: slot.practitioner_id,
        business_id: slot.business_id,
        appointment_type_id: slot.appointment_type_id,
        starts_at: slot.slot
      });
      if (result.success) {
        return `✅ Your appointment is booked for:\n${slot.practitioner_name} — ${slot.appointment_type_name}\n${new Date(slot.slot).toLocaleString()}\n\n` + await this.goToInteractiveMenu(session);
      } else {
        return `❌ Could not book your appointment. ${result.message || ''}\n\n` + await this.goToInteractiveMenu(session);
      }
    }
    return 'Please type "yes" to confirm booking, or "0" to go back.';
  }
  }
  */

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
   * Handle patient registration flow.
   * @param {object} session
   * @param {string} message
   */
  async handleRegisterPatientState(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const requiredFields = ['first_name', 'last_name', 'email'];
    let nextField = null;
    for (const field of requiredFields) {
      if (!data[field]) {
        nextField = field;
        break;
      }
    }
    if (nextField) {
      if (message.trim()) {
        data[nextField] = message.trim();
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      }
      const prompts = {
        first_name: "Please tell me your first name:",
        last_name: "Got it. What's your last name?",
        email: "Thanks. Lastly, what's your email address?"
      };
      if (!data.first_name) return prompts.first_name;
      if (!data.last_name) return prompts.last_name;
      if (!data.email) return prompts.email;
    }
    // All fields collected, now try registration
    const phoneNumber = session.phone_number || session.phoneNumber;
    if (!data.email || !phoneNumber) {
      await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.INTRO,
      verified: false
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
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
          data: null // Clear registration data
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
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
