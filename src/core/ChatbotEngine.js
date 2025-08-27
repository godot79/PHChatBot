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
        }
      } else if (regionCodes.some(code => text.includes(regionLabels[code].toLowerCase()))) {
        const found = regionCodes.find(code => text.includes(regionLabels[code].toLowerCase()));
        context.region = found;
        delete context.awaiting_region_selection;
        await this.sessionManager.updateSession(session.id, { context });
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
   * "Back" goes up one submenu step, or to Booking Options menu if at top.
   * Slot display omits physio/clinic per slot when already selected, showing them in header.
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSoonest(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    let text = (message || '').trim().toLowerCase();

    // Initialize navigation chain if not exists
    if (!data.navigation_chain) {
      data.navigation_chain = [];
    }

    if (['0', 'menu', 'back'].includes(text)) {
      // Pop from navigation chain
      if (data.navigation_chain && data.navigation_chain.length > 0) {
        const previousState = data.navigation_chain.pop();
        data.selection_step = previousState.selection_step;
        
        if (previousState.selection_step === 'choose_type') {
          delete data.selected_appt_type;
          delete data.selected_physio;
          delete data.selected_clinic;
          delete data.practitioner_list;
          delete data.clinic_list;
        } else if (previousState.selection_step === 'choose_physio') {
          delete data.selected_physio;
          delete data.selected_clinic;
          delete data.clinic_list;
        } else if (previousState.selection_step === 'choose_clinic') {
          delete data.selected_clinic;
        }
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SOONEST,
          data: JSON.stringify(data)
        });
        return await this.handleBookSoonest(session, '');
      }
      
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return await this.goToInteractiveMenu(session);
    }

    if (!data.selection_step) {
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const allTypes = await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
      data.appointment_type_list = allTypes;
      data.appt_type_page = 0;
      data.selection_step = 'choose_type';
      data.navigation_chain = []; // Reset chain
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SOONEST,
        data: JSON.stringify(data)
      });
      const reply = formatPaginatedList({
        items: allTypes,
        formatFn: (a, idx) => `${idx}. ${a.name}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
        header: `Choose appointment type:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    if (data.selection_step === 'choose_type' && data.appointment_type_list && (text === 'm' || text === 'more')) {
      data.appt_type_page = (data.appt_type_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SOONEST,
        data: JSON.stringify(data)
      });
      return await this.handleBookSoonest(session, '');
    }

    if (data.selection_step === 'choose_type') {
      const apptTypes = data.appointment_type_list;
      const page = data.appt_type_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= apptTypes.length) {
          return 'Invalid appointment type selection. Reply with a number from the list.';
        }
        
        // Record navigation step
        if (apptTypes.length > 1) {
          data.navigation_chain.push({
            selection_step: 'choose_type',
            had_multiple_options: true
          });
        }
        
        const selectedApptType = apptTypes[idx];
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const practitioners = await getPractitionersForType(groups, this.clinikoAPI, selectedApptType.id);
        data.selected_appt_type = selectedApptType;
        data.practitioner_list = practitioners;
        data.practitioner_page = 0;
        data.selection_step = 'choose_physio';
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SOONEST,
          data: JSON.stringify(data)
        });
        if (!practitioners.length) {
          return "No practitioners found for that appointment type.";
        }
        
        // Auto-advance if only one practitioner
        if (practitioners.length === 1) {
          data.navigation_chain.push({
            selection_step: 'choose_physio',
            had_multiple_options: false
          });
          await this.sessionManager.updateSession(session.id, {
            data: JSON.stringify(data)
          });
          return await this.handleBookSoonest(session, "1");
        }
        
        const reply = formatPaginatedList({
          items: practitioners,
          formatFn: formatPhysioItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More practitioners',
          header: `Select a practitioner for ${selectedApptType.name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      const reply = formatPaginatedList({
        items: apptTypes,
        formatFn: (a, idx) => `${idx}. ${a.name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
        header: `Choose appointment type:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    if (data.selection_step === 'choose_physio' && data.practitioner_list && (text === 'm' || text === 'more')) {
      data.practitioner_page = (data.practitioner_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SOONEST,
        data: JSON.stringify(data)
      });
      return await this.handleBookSoonest(session, '');
    }

    if (data.selection_step === 'choose_physio') {
      const practitionerList = data.practitioner_list;
      const page = data.practitioner_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= practitionerList.length) {
          return 'Invalid selection. Reply with a number from the list.';
        }
        
        // Record navigation step
        if (practitionerList.length > 1) {
          data.navigation_chain.push({
            selection_step: 'choose_physio',
            had_multiple_options: true
          });
        }
        
        const selectedPhysio = practitionerList[idx];
        data.selected_physio = selectedPhysio;
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const clinics = groups
          .filter(g => g.practitioners.some(p => p.id === selectedPhysio.id))
          .map(g => ({ id: g.clinic_id, business_name: g.clinic_name }));
        data.clinic_list = clinics;
        data.clinic_page = 0;
        data.selection_step = 'choose_clinic';
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SOONEST,
          data: JSON.stringify(data)
        });
        if (!clinics.length) {
          return "No clinics found for this practitioner.";
        }
        
        // Auto-advance if only one clinic
        if (clinics.length === 1) {
          data.navigation_chain.push({
            selection_step: 'choose_clinic',
            had_multiple_options: false
          });
          await this.sessionManager.updateSession(session.id, {
            data: JSON.stringify(data)
          });
          return await this.handleBookSoonest(session, "1");
        }
        
        const reply = formatPaginatedList({
          items: clinics,
          formatFn: (c, idx) => `${idx}. ${c.business_name}`,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: `Select a clinic for ${selectedPhysio.display_name || selectedPhysio.first_name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      const reply = formatPaginatedList({
        items: practitionerList,
        formatFn: formatPhysioItem,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More practitioners',
        header: `Select a practitioner for ${data.selected_appt_type.name}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    if (data.selection_step === 'choose_clinic' && data.clinic_list && (text === 'm' || text === 'more')) {
      data.clinic_page = (data.clinic_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SOONEST,
        data: JSON.stringify(data)
      });
      return await this.handleBookSoonest(session, '');
    }

    if (data.selection_step === 'choose_clinic') {
      const clinicsList = data.clinic_list;
      const page = data.clinic_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= clinicsList.length) {
          return 'Invalid selection. Reply with a number from the list.';
        }
        
        const selectedClinic = clinicsList[idx];
        data.selected_clinic = selectedClinic;
        const today = new Date();
        const from = new Date(today.setDate(today.getDate() + 1)).toISOString().split('T')[0] + "T00:00:00Z";
        const to = new Date(today.setDate(today.getDate() + 1 + 7)).toISOString().split('T')[0] + "T23:59:59Z";
        const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: selectedClinic.id,
          from,
          to,
          practitioner_id: data.selected_physio.id
        });
        if (!slots.length) {
          return "No available slots for that combination. Please try another.";
        }
        const slotData = {
          slot_list: slots,
          slot_page: 0,
          last_selection_flow: 'soonest',
          navigation_chain: data.navigation_chain // Preserve chain
        };
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_SLOT,
          data: JSON.stringify(slotData)
        });
        const reply = formatPaginatedList({
          items: slots,
          formatFn: (slot, idx) => formatSlotItem(slot, idx, { omitClinic: true, omitPhysio: true }),
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More slots',
          header: `Slots for ${data.selected_appt_type.name} with ${data.selected_physio.display_name || data.selected_physio.first_name} at ${selectedClinic.business_name}:`
        }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
        return reply;
      }
      const reply = formatPaginatedList({
        items: clinicsList,
        formatFn: (c, idx) => `${idx}. ${c.business_name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: `Select a clinic for ${data.selected_physio.display_name || data.selected_physio.first_name}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    const apptTypes = data.appointment_type_list;
    const apptTypePage = data.appt_type_page || 0;
    const reply = formatPaginatedList({
      items: apptTypes,
      formatFn: (a, idx) => `${idx}. ${a.name}`,
      page: apptTypePage,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More types',
      header: `Choose appointment type:`
    }) + `\n\nReply with number. (0️⃣ Back)`;
    return reply;
  }

  /**
   * Book at a specific date:
   * - Step 1: Select appointment type (global list, deduped via all practitioners)
   * - Step 2: Select practitioner (filtered to those who offer that type)
   * - Step 3: Select clinic (filtered to clinics that practitioner works at)
   * - Step 4: Enter date (YYYY-MM-DD), fetch slots
   * Pagination and back navigation are handled.
   * @param {object} session - User session object
   * @param {string} message - User input text
   * @returns {Promise<string>} WhatsApp message to user
   */
  async handleBookSpecificDate(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    let text = (message || '').trim().toLowerCase();

    // Initialize navigation chain if not exists
    if (!data.navigation_chain) {
      data.navigation_chain = [];
    }

    // --- BACK/UP LOGIC ---
    if (['0', 'menu', 'back'].includes(text)) {
      // Pop from navigation chain
      if (data.navigation_chain && data.navigation_chain.length > 0) {
        const previousState = data.navigation_chain.pop();
        
        // Restore the previous state
        data.selection_step = previousState.selection_step;
        
        // Clear forward selections based on what step we're going back to
        if (previousState.selection_step === 'choose_date') {
          delete data.selected_date;
          delete data.appointment_type_list;
          delete data.appt_type_page;
          delete data.selected_appt_type;
          delete data.practitioner_list;
          delete data.practitioner_page;
          delete data.selected_physio;
          delete data.clinic_list;
          delete data.clinic_page;
          delete data.selected_clinic;
        } else if (previousState.selection_step === 'choose_type') {
          delete data.selected_appt_type;
          delete data.practitioner_list;
          delete data.practitioner_page;
          delete data.selected_physio;
          delete data.clinic_list;
          delete data.clinic_page;
          delete data.selected_clinic;
        } else if (previousState.selection_step === 'choose_physio') {
          delete data.selected_physio;
          delete data.clinic_list;
          delete data.clinic_page;
          delete data.selected_clinic;
        } else if (previousState.selection_step === 'choose_clinic') {
          delete data.selected_clinic;
        }
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
          data: JSON.stringify(data)
        });
        return await this.handleBookSpecificDate(session, '');
      }
      
      // No more items in chain, go to booking method options
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return await this.goToInteractiveMenu(session);
    }

    // --- STEP 1: SELECT DATE FIRST ---
    if (!data.selection_step) {
      data.selection_step = 'choose_date';
      data.navigation_chain = []; // Reset chain at start
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
        data: JSON.stringify(data)
      });
      return `Please enter your desired date for the appointment (YYYY-MM-DD format).\n\nExample: ${new Date(Date.now() + 86400000).toISOString().split('T')[0]}\n\n(0️⃣ Back)`;
    }

    // --- STEP 2: PROCESS DATE AND SELECT APPOINTMENT TYPE ---
    if (data.selection_step === 'choose_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return "Please enter a valid date in YYYY-MM-DD format.\n\nExample: " + 
          new Date(Date.now() + 86400000).toISOString().split('T')[0] + "\n\n(0️⃣ Back)";
      }
      
      // Validate date is in future
      const selectedDate = new Date(text + 'T00:00:00Z');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (selectedDate <= today) {
        return "Please select a future date. (0️⃣ Back)";
      }
      
      // Record navigation step
      data.navigation_chain.push({
        selection_step: 'choose_date',
        had_multiple_options: false
      });
      
      data.selected_date = text;
      
      // Get all appointment types
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const allTypes = await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
      data.appointment_type_list = allTypes;
      data.appt_type_page = 0;
      data.selection_step = 'choose_type';
      
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
        data: JSON.stringify(data)
      });
      
      // Auto-advance if only one type
      if (allTypes.length === 1) {
        data.navigation_chain.push({
          selection_step: 'choose_type',
          had_multiple_options: false
        });
        await this.sessionManager.updateSession(session.id, {
          data: JSON.stringify(data)
        });
        return await this.handleBookSpecificDate(session, "1");
      }
      
      const reply = formatPaginatedList({
        items: allTypes,
        formatFn: (a, idx) => `${idx}. ${a.name}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
        header: `Choose appointment type for ${text}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // --- PAGING: appointment types ---
    if (data.selection_step === 'choose_type' && data.appointment_type_list && (text === 'm' || text === 'more')) {
      data.appt_type_page = (data.appt_type_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
        data: JSON.stringify(data)
      });
      return await this.handleBookSpecificDate(session, '');
    }

    // --- STEP 3: SELECT PRACTITIONER (filtered by date availability) ---
    if (data.selection_step === 'choose_type') {
      const apptTypes = data.appointment_type_list;
      const page = data.appt_type_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= apptTypes.length) {
          return 'Invalid appointment type selection. Reply with a number from the list.';
        }
        
        // Record navigation step if multiple options
        if (apptTypes.length > 1) {
          data.navigation_chain.push({
            selection_step: 'choose_type',
            had_multiple_options: true
          });
        }
        
        const selectedApptType = apptTypes[idx];
        data.selected_appt_type = selectedApptType;
        
        // Get practitioners who offer this type AND have availability on the selected date
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const allPractitioners = await getPractitionersForType(groups, this.clinikoAPI, selectedApptType.id);
        
        // Filter practitioners by those who have slots on the selected date
        const from = data.selected_date + "T00:00:00Z";
        const to = data.selected_date + "T23:59:59Z";
        const availablePractitioners = [];
        
        for (const practitioner of allPractitioners) {
          // Check if this practitioner has any slots on the selected date
          let hasSlots = false;
          for (const group of groups) {
            if (group.practitioners.some(p => p.id === practitioner.id)) {
              try {
                const slots = await this.clinikoAPI.getAvailableTimes({
                  practitioner_id: practitioner.id,
                  business_id: group.clinic_id,
                  appt_type: selectedApptType.id,
                  from,
                  to
                });
                if (slots && slots.length > 0) {
                  hasSlots = true;
                  break;
                }
              } catch (e) {
                // Continue checking other clinics
              }
            }
          }
          if (hasSlots) {
            availablePractitioners.push(practitioner);
          }
        }
        
        if (!availablePractitioners.length) {
          return `No practitioners available for ${selectedApptType.name} on ${data.selected_date}. Please try another date or type. (0️⃣ Back)`;
        }
        
        data.practitioner_list = availablePractitioners;
        data.practitioner_page = 0;
        data.selection_step = 'choose_physio';
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
          data: JSON.stringify(data)
        });
        
        // Auto-advance if only one practitioner
        if (availablePractitioners.length === 1) {
          data.navigation_chain.push({
            selection_step: 'choose_physio',
            had_multiple_options: false
          });
          await this.sessionManager.updateSession(session.id, {
            data: JSON.stringify(data)
          });
          return await this.handleBookSpecificDate(session, "1");
        }
        
        const reply = formatPaginatedList({
          items: availablePractitioners,
          formatFn: formatPhysioItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More practitioners',
          header: `Practitioners available for ${selectedApptType.name} on ${data.selected_date}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      
      const reply = formatPaginatedList({
        items: apptTypes,
        formatFn: (a, idx) => `${idx}. ${a.name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
        header: `Choose appointment type for ${data.selected_date}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // --- PAGING: practitioners ---
    if (data.selection_step === 'choose_physio' && data.practitioner_list && (text === 'm' || text === 'more')) {
      data.practitioner_page = (data.practitioner_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
        data: JSON.stringify(data)
      });
      return await this.handleBookSpecificDate(session, '');
    }

    // --- STEP 4: SELECT CLINIC (filtered by practitioner and date) ---
    if (data.selection_step === 'choose_physio') {
      const practitionerList = data.practitioner_list;
      const page = data.practitioner_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= practitionerList.length) {
          return 'Invalid selection. Reply with a number from the list.';
        }
        
        // Record navigation step if multiple options
        if (practitionerList.length > 1) {
          data.navigation_chain.push({
            selection_step: 'choose_physio',
            had_multiple_options: true
          });
        }
        
        const selectedPhysio = practitionerList[idx];
        data.selected_physio = selectedPhysio;
        
        // Find clinics where this practitioner works AND has slots on the selected date
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const from = data.selected_date + "T00:00:00Z";
        const to = data.selected_date + "T23:59:59Z";
        const availableClinics = [];
        
        for (const group of groups) {
          if (group.practitioners.some(p => p.id === selectedPhysio.id)) {
            // Check if there are slots at this clinic for this practitioner on this date
            try {
              const slots = await this.clinikoAPI.getAvailableTimes({
                practitioner_id: selectedPhysio.id,
                business_id: group.clinic_id,
                appt_type: data.selected_appt_type.id,
                from,
                to
              });
              if (slots && slots.length > 0) {
                availableClinics.push({ 
                  id: group.clinic_id, 
                  business_name: group.clinic_name 
                });
              }
            } catch (e) {
              // Continue checking other clinics
            }
          }
        }
        
        if (!availableClinics.length) {
          return `No clinics available for ${selectedPhysio.display_name || selectedPhysio.first_name} on ${data.selected_date}. (0️⃣ Back)`;
        }
        
        data.clinic_list = availableClinics;
        data.clinic_page = 0;
        data.selection_step = 'choose_clinic';
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
          data: JSON.stringify(data)
        });
        
        // Auto-advance if only one clinic
        if (availableClinics.length === 1) {
          data.navigation_chain.push({
            selection_step: 'choose_clinic',
            had_multiple_options: false
          });
          await this.sessionManager.updateSession(session.id, {
            data: JSON.stringify(data)
          });
          return await this.handleBookSpecificDate(session, "1");
        }
        
        const reply = formatPaginatedList({
          items: availableClinics,
          formatFn: (c, idx) => `${idx}. ${c.business_name}`,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: `Clinics where ${selectedPhysio.display_name || selectedPhysio.first_name} is available on ${data.selected_date}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      
      const reply = formatPaginatedList({
        items: practitionerList,
        formatFn: formatPhysioItem,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More practitioners',
        header: `Practitioners available for ${data.selected_appt_type.name} on ${data.selected_date}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // --- PAGING: clinics ---
    if (data.selection_step === 'choose_clinic' && data.clinic_list && (text === 'm' || text === 'more')) {
      data.clinic_page = (data.clinic_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
        data: JSON.stringify(data)
      });
      return await this.handleBookSpecificDate(session, '');
    }

    // --- STEP 5: GET SLOTS (we already know they exist) ---
    if (data.selection_step === 'choose_clinic') {
      const clinicsList = data.clinic_list;
      const page = data.clinic_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= clinicsList.length) {
          return 'Invalid selection. Reply with a number from the list.';
        }
        
        const selectedClinic = clinicsList[idx];
        data.selected_clinic = selectedClinic;
        
        // Fetch slots for that date, practitioner, clinic, and appointment type
        const from = data.selected_date + "T00:00:00Z";
        const to = data.selected_date + "T23:59:59Z";
        const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: data.selected_clinic.id,
          from,
          to,
          practitioner_id: data.selected_physio.id
        });
        
        // Filter for the selected appointment type
        const filteredSlots = slots.filter(s => s.appointment_type_id === data.selected_appt_type.id);
        
        if (!filteredSlots.length) {
          return "No slots available for that selection. Please try another option. (0️⃣ Back)";
        }
        
        const slotData = {
          slot_list: filteredSlots,
          slot_page: 0,
          last_selection_flow: 'date',
          navigation_chain: data.navigation_chain // Preserve the chain
        };
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_SLOT,
          data: JSON.stringify(slotData)
        });
        
        const reply = formatPaginatedList({
          items: filteredSlots,
          formatFn: (slot, idx) => formatSlotItem(slot, idx, { omitClinic: true, omitPhysio: true }),
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More slots',
          header: `Slots for ${data.selected_appt_type.name} with ${data.selected_physio.display_name || data.selected_physio.first_name} at ${data.selected_clinic.business_name} on ${data.selected_date}:`
        }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
        return reply;
      }
      
      const reply = formatPaginatedList({
        items: clinicsList,
        formatFn: (c, idx) => `${idx}. ${c.business_name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: `Clinics where ${data.selected_physio.display_name || data.selected_physio.first_name} is available on ${data.selected_date}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // --- Defensive fallback ---
    return `Please enter your desired date for the appointment (YYYY-MM-DD format).\n\nExample: ${new Date(Date.now() + 86400000).toISOString().split('T')[0]}\n\n(0️⃣ Back)`;
  }

  /**
   * Book by picking a physio directly, with up-one-step navigation and slot display cosmetics,
   * and auto-advance if only one clinic is available for a physio.
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSpecificPhysio(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    let text = (message || '').trim().toLowerCase();

    // Initialize navigation chain if not exists
    if (!data.navigation_chain) {
      data.navigation_chain = [];
    }

    // Centralized back logic
    if (['0', 'menu', 'back'].includes(text)) {
      // Pop from navigation chain
      if (data.navigation_chain && data.navigation_chain.length > 0) {
        const previousState = data.navigation_chain.pop();
        
        // Restore the previous state
        data.selection_step = previousState.selection_step;
        
        // Clear forward selections based on what step we're going back to
        if (previousState.selection_step === 'choose_physio') {
          delete data.selected_physio;
          delete data.clinic_list;
          delete data.clinic_page;
          delete data.selected_clinic;
          delete data.appt_types_for_physio;
          delete data.appt_type_page;
          delete data.selected_appt_type;
        } else if (previousState.selection_step === 'choose_clinic') {
          delete data.selected_clinic;
          delete data.appt_types_for_physio;
          delete data.appt_type_page;
          delete data.selected_appt_type;
        } else if (previousState.selection_step === 'choose_appt_type') {
          delete data.selected_appt_type;
        }
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
          data: JSON.stringify(data)
        });
        return await this.handleBookSpecificPhysio(session, '');
      }
      
      // No more items in chain, go to booking method options
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.goToInteractiveMenu(updatedSession);
    }

    // Paging logic for physios
    if (data.selection_step === 'choose_physio' && data.physio_list && (text === 'm' || text === 'more')) {
      data.physio_page = (data.physio_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
        data: JSON.stringify(data)
      });
      return await this.handleBookSpecificPhysio(session, '');
    }

    // Paging logic for clinics
    if (data.selection_step === 'choose_clinic' && data.clinic_list && (text === 'm' || text === 'more')) {
      data.clinic_page = (data.clinic_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
        data: JSON.stringify(data)
      });
      return await this.handleBookSpecificPhysio(session, '');
    }

    // Paging logic for appointment types
    if (data.selection_step === 'choose_appt_type' && data.appt_types_for_physio && (text === 'm' || text === 'more')) {
      data.appt_type_page = (data.appt_type_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
        data: JSON.stringify(data)
      });
      return await this.handleBookSpecificPhysio(session, '');
    }

    // Initial physio list
    if (!data.physio_list || !data.selection_step) {
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const physiosFetched = uniquePractitionersFromGroups(groups);
      data.physio_list = physiosFetched;
      data.physio_page = 0;
      data.selection_step = 'choose_physio';
      data.navigation_chain = []; // Reset chain at start
      
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
        data: JSON.stringify(data)
      });
      
      // Auto-advance if only one, but record it in navigation
      if (physiosFetched.length === 1) {
        // Push current state to navigation chain before auto-advancing
        data.navigation_chain.push({
          selection_step: 'choose_physio',
          had_multiple_options: false
        });
        await this.sessionManager.updateSession(session.id, {
          data: JSON.stringify(data)
        });
        return await this.handleBookSpecificPhysio(session, "1");
      }
      
      const reply = formatPaginatedList({
        items: physiosFetched,
        formatFn: formatPhysioItem,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More physios',
        header: 'Select a physiotherapist:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Physio selection
    if (data.selection_step === 'choose_physio') {
      const physioList = data.physio_list;
      const page = data.physio_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= physioList.length) {
          return 'Invalid physiotherapist selection. Reply with a number from the list.';
        }
        
        // Record in navigation chain if this was a real choice (multiple options)
        if (physioList.length > 1) {
          data.navigation_chain.push({
            selection_step: 'choose_physio',
            had_multiple_options: true
          });
        }
        
        const selectedPhysio = physioList[idx];
        data.selected_physio = selectedPhysio;
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const clinics = groups
          .filter(g => g.practitioners.some(p => p.id === selectedPhysio.id))
          .map(g => ({ id: g.clinic_id, business_name: g.clinic_name }));
        data.clinic_list = clinics;
        data.clinic_page = 0;
        
        if (!clinics.length) {
          return "No clinics found for this physiotherapist.";
        }
        
        // Auto-advance if only one clinic
        if (clinics.length === 1) {
          // Push to navigation chain before auto-advancing
          data.navigation_chain.push({
            selection_step: 'choose_clinic',
            had_multiple_options: false
          });
          
          data.selected_clinic = clinics[0];
          let apptTypes = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: selectedPhysio.id });
          apptTypes = apptTypes.filter(
            (t, i, arr) => arr.findIndex(tt => tt.id === t.id) === i
          );
          data.appt_types_for_physio = apptTypes;
          data.appt_type_page = 0;
          data.selection_step = 'choose_appt_type';
          
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
            data: JSON.stringify(data)
          });
          
          if (!apptTypes.length) {
            return "This physiotherapist has no available appointment types at this clinic. Please try another clinic.";
          }
          
          const replyText = `Only one clinic (${clinics[0].business_name}) is available for ${selectedPhysio.display_name || selectedPhysio.first_name}. Proceeding to appointment type selection.\n\n`;
          const reply = replyText + formatPaginatedList({
            items: apptTypes,
            formatFn: (a, idx) => `${idx}. ${a.name}`,
            page: 0,
            pageSize: MAX_SLOT_ITEMS,
            moreLabel: 'M. More types',
            header: `Appointment types for ${selectedPhysio.display_name || selectedPhysio.first_name} at ${clinics[0].business_name}:`
          }) + `\n\nReply with number. (0️⃣ Back)`;
          return reply;
        }
        
        data.selection_step = 'choose_clinic';
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
          data: JSON.stringify(data)
        });
        
        const reply = formatPaginatedList({
          items: clinics,
          formatFn: (c, idx) => `${idx}. ${c.business_name}`,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: `Clinics for ${selectedPhysio.display_name || selectedPhysio.first_name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      
      const reply = formatPaginatedList({
        items: physioList,
        formatFn: formatPhysioItem,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More physios',
        header: 'Select a physiotherapist:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Clinic selection
    if (data.selection_step === 'choose_clinic') {
      const clinicsList = data.clinic_list;
      const page = data.clinic_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= clinicsList.length) {
          return 'Invalid clinic selection. Reply with a number from the list.';
        }
        
        // Record in navigation chain if this was a real choice
        if (clinicsList.length > 1) {
          data.navigation_chain.push({
            selection_step: 'choose_clinic',
            had_multiple_options: true
          });
        }
        
        const selectedClinic = clinicsList[idx];
        data.selected_clinic = selectedClinic;
        let apptTypes = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: data.selected_physio.id });
        apptTypes = apptTypes.filter(
          (t, i, arr) => arr.findIndex(tt => tt.id === t.id) === i
        );
        data.appt_types_for_physio = apptTypes;
        data.appt_type_page = 0;
        data.selection_step = 'choose_appt_type';
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
          data: JSON.stringify(data)
        });

        if (!apptTypes.length) {
          return "This physiotherapist has no available appointment types at this clinic. Please try another clinic.";
        }
        
        const reply = formatPaginatedList({
          items: apptTypes,
          formatFn: (a, idx) => `${idx}. ${a.name}`,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More types',
          header: `Appointment types for ${data.selected_physio.display_name || data.selected_physio.first_name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      
      const reply = formatPaginatedList({
        items: clinicsList,
        formatFn: (c, idx) => `${idx}. ${c.business_name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: `Clinics for ${data.selected_physio.display_name || data.selected_physio.first_name}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Appointment type selection
    if (data.selection_step === 'choose_appt_type') {
      let apptTypes = data.appt_types_for_physio || [];
      apptTypes = apptTypes.filter(
        (t, i, arr) => arr.findIndex(tt => tt.id === t.id) === i
      );
      const page = data.appt_type_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= apptTypes.length) {
          return 'Invalid appointment type selection. Reply with a number from the list.';
        }
        
        const selectedApptType = apptTypes[idx];
        const today = new Date();
        const from = new Date(today.setDate(today.getDate() + 1)).toISOString().split('T')[0] + "T00:00:00Z";
        const to = new Date(today.setDate(today.getDate() + 1 + 7)).toISOString().split('T')[0] + "T23:59:59Z";
        const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: data.selected_clinic.id,
          from,
          to,
          practitioner_id: data.selected_physio.id
        });
        
        if (!slots.length) {
          return "No available slots for that appointment type and physio at this clinic. Please try another.";
        }
        
        const slotData = {
          slot_list: slots,
          slot_page: 0,
          last_selection_flow: 'physio',
          navigation_chain: data.navigation_chain // Preserve the chain
        };
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_SLOT,
          data: JSON.stringify(slotData)
        });
        
        const reply = formatPaginatedList({
          items: slots,
          formatFn: (slot, idx) => formatSlotItem(slot, idx, { omitClinic: true, omitPhysio: true }),
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More slots',
          header: `Slots for ${selectedApptType.name} with ${data.selected_physio.display_name || data.selected_physio.first_name}:`
        }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
        return reply;
      }
      
      const reply = formatPaginatedList({
        items: apptTypes,
        formatFn: (a, idx) => `${idx}. ${a.name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
        header: `Appointment types for ${data.selected_physio.display_name || data.selected_physio.first_name}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Defensive fallback
    const physioList = data.physio_list;
    const physioPage = data.physio_page || 0;
    const reply = formatPaginatedList({
      items: physioList,
      formatFn: formatPhysioItem,
      page: physioPage,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More physios',
      header: 'Select a physiotherapist:'
    }) + `\n\nReply with number. (0️⃣ Back)`;
    return reply;
  }

  /**
   * Book by picking a clinic directly, with up-one-step navigation and slot display cosmetics,
   * and auto-advance if only one physio is available for a clinic.
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSpecificClinic(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    let text = (message || '').trim().toLowerCase();

    // Initialize navigation chain if not exists
    if (!data.navigation_chain) {
      data.navigation_chain = [];
    }

    // Centralized back logic
    if (['0', 'menu', 'back'].includes(text)) {
      // Pop from navigation chain
      if (data.navigation_chain && data.navigation_chain.length > 0) {
        const previousState = data.navigation_chain.pop();
        
        // Restore the previous state
        data.selection_step = previousState.selection_step;
        
        // Clear forward selections based on what step we're going back to
        if (previousState.selection_step === 'choose_clinic') {
          delete data.selected_clinic;
          delete data.physio_list;
          delete data.physio_page;
          delete data.selected_physio;
          delete data.appt_types_for_physio;
          delete data.appt_type_page;
          delete data.selected_appt_type;
        } else if (previousState.selection_step === 'choose_physio') {
          delete data.selected_physio;
          delete data.appt_types_for_physio;
          delete data.appt_type_page;
          delete data.selected_appt_type;
        } else if (previousState.selection_step === 'choose_appt_type') {
          delete data.selected_appt_type;
        }
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
          data: JSON.stringify(data)
        });
        return await this.handleBookSpecificClinic(session, '');
      }
      
      // No more items in chain, go to booking method options
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.goToInteractiveMenu(updatedSession);
    }

    // Paging logic
    if (data.selection_step === 'choose_clinic' && data.clinic_list && (text === 'm' || text === 'more')) {
      data.clinic_page = (data.clinic_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
        data: JSON.stringify(data)
      });
      return await this.handleBookSpecificClinic(session, '');
    }
    
    if (data.selection_step === 'choose_physio' && data.physio_list && (text === 'm' || text === 'more')) {
      data.physio_page = (data.physio_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
        data: JSON.stringify(data)
      });
      return await this.handleBookSpecificClinic(session, '');
    }
    
    if (data.selection_step === 'choose_appt_type' && data.appt_types_for_physio && (text === 'm' || text === 'more')) {
      data.appt_type_page = (data.appt_type_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
        data: JSON.stringify(data)
      });
      return await this.handleBookSpecificClinic(session, '');
    }

    // Initial clinic list
    if (!data.clinic_list || !data.selection_step) {
      const clinicsFetched = await this.clinikoAPI.getClinics();
      data.clinic_list = clinicsFetched;
      data.clinic_page = 0;
      data.selection_step = 'choose_clinic';
      data.navigation_chain = []; // Reset chain at start
      
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
        data: JSON.stringify(data)
      });
      
      // Auto-advance if only one
      if (clinicsFetched.length === 1) {
        // Push current state to navigation chain before auto-advancing
        data.navigation_chain.push({
          selection_step: 'choose_clinic',
          had_multiple_options: false
        });
        await this.sessionManager.updateSession(session.id, {
          data: JSON.stringify(data)
        });
        return await this.handleBookSpecificClinic(session, "1");
      }
      
      const reply = formatPaginatedList({
        items: clinicsFetched,
        formatFn: (c, idx) => `${idx}. ${c.business_name}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: 'Select a clinic:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Clinic selection
    if (data.selection_step === 'choose_clinic') {
      const clinicsList = data.clinic_list;
      const page = data.clinic_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= clinicsList.length) {
          return 'Invalid clinic selection. Reply with a number from the list.';
        }
        
        // Record in navigation chain if this was a real choice
        if (clinicsList.length > 1) {
          data.navigation_chain.push({
            selection_step: 'choose_clinic',
            had_multiple_options: true
          });
        }
        
        const selectedClinic = clinicsList[idx];
        data.selected_clinic = selectedClinic;
        const physios = await this.clinikoAPI.getPractitionersForClinic(selectedClinic.id);
        data.physio_list = physios;
        data.physio_page = 0;
        
        if (!physios.length) {
          return "No physiotherapists found for this clinic.";
        }
        
        // Auto-advance if only one physio
        if (physios.length === 1) {
          // Push to navigation chain before auto-advancing
          data.navigation_chain.push({
            selection_step: 'choose_physio',
            had_multiple_options: false
          });
          
          data.selected_physio = physios[0];
          let apptTypes = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: physios[0].id });
          apptTypes = apptTypes.filter(
            (t, i, arr) => arr.findIndex(tt => tt.id === t.id) === i
          );
          data.appt_types_for_physio = apptTypes;
          data.appt_type_page = 0;
          data.selection_step = 'choose_appt_type';
          
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
            data: JSON.stringify(data)
          });
          
          if (!apptTypes.length) {
            return "This practitioner has no available appointment types. Please try another physiotherapist.";
          }
          
          const replyText = `Only one physiotherapist (${physios[0].display_name || physios[0].first_name}) is available at ${selectedClinic.business_name}. Proceeding to appointment type selection.\n\n`;
          const reply = replyText + formatPaginatedList({
            items: apptTypes,
            formatFn: (a, idx) => `${idx}. ${a.name}`,
            page: 0,
            pageSize: MAX_SLOT_ITEMS,
            moreLabel: 'M. More types',
            header: `Appointment types for ${physios[0].display_name || physios[0].first_name} at ${selectedClinic.business_name}:`
          }) + `\n\nReply with number. (0️⃣ Back)`;
          return reply;
        }
        
        data.selection_step = 'choose_physio';
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
          data: JSON.stringify(data)
        });
        
        const reply = formatPaginatedList({
          items: physios,
          formatFn: formatPhysioItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More physios',
          header: `Physiotherapists at ${selectedClinic.business_name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      
      const reply = formatPaginatedList({
        items: clinicsList,
        formatFn: (c, idx) => `${idx}. ${c.business_name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: 'Select a clinic:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Physio selection
    if (data.selection_step === 'choose_physio') {
      const physioList = data.physio_list;
      const page = data.physio_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= physioList.length) {
          return 'Invalid physiotherapist selection. Reply with a number from the list.';
        }
        
        // Record in navigation chain if this was a real choice
        if (physioList.length > 1) {
          data.navigation_chain.push({
            selection_step: 'choose_physio',
            had_multiple_options: true
          });
        }
        
        const selectedPhysio = physioList[idx];
        data.selected_physio = selectedPhysio;
        let apptTypes = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: selectedPhysio.id });
        apptTypes = apptTypes.filter(
          (t, i, arr) => arr.findIndex(tt => tt.id === t.id) === i
        );
        data.appt_types_for_physio = apptTypes;
        data.appt_type_page = 0;
        data.selection_step = 'choose_appt_type';
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
          data: JSON.stringify(data)
        });
        
        if (!apptTypes.length) {
          return "This practitioner has no available appointment types. Please try another physiotherapist.";
        }
        
        const reply = formatPaginatedList({
          items: apptTypes,
          formatFn: (a, idx) => `${idx}. ${a.name}`,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More types',
          header: `Appointment types for ${selectedPhysio.display_name || selectedPhysio.first_name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }
      
      const reply = formatPaginatedList({
        items: physioList,
        formatFn: formatPhysioItem,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More physios',
        header: `Physiotherapists at ${data.selected_clinic.business_name}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Appointment type selection
    if (data.selection_step === 'choose_appt_type') {
      let apptTypes = data.appt_types_for_physio || [];
      apptTypes = apptTypes.filter(
        (t, i, arr) => arr.findIndex(tt => tt.id === t.id) === i
      );
      const page = data.appt_type_page || 0;
      if (!isNaN(text) && text !== '') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= apptTypes.length) {
          return 'Invalid appointment type selection. Reply with a number from the list.';
        }
        
        const selectedApptType = apptTypes[idx];
        const today = new Date();
        const from = new Date(today.setDate(today.getDate() + 1)).toISOString().split('T')[0] + "T00:00:00Z";
        const to = new Date(today.setDate(today.getDate() + 1 + 7)).toISOString().split('T')[0] + "T23:59:59Z";
        const slots = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: data.selected_clinic.id,
          from,
          to,
          practitioner_id: data.selected_physio.id
        });
        
        if (!slots.length) {
          return "No available slots for that appointment type and physio at this clinic. Please try another.";
        }
        
        const slotData = {
          slot_list: slots,
          slot_page: 0,
          last_selection_flow: 'clinic',
          navigation_chain: data.navigation_chain // Preserve the chain
        };
        
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_SLOT,
          data: JSON.stringify(slotData)
        });
        
        const reply = formatPaginatedList({
          items: slots,
          formatFn: (slot, idx) => formatSlotItem(slot, idx, { omitClinic: true, omitPhysio: true }),
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More slots',
          header: `Slots for ${selectedApptType.name} with ${data.selected_physio.display_name || data.selected_physio.first_name}:`
        }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
        return reply;
      }
      
      const reply = formatPaginatedList({
        items: apptTypes,
        formatFn: (a, idx) => `${idx}. ${a.name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
        header: `Appointment types for ${data.selected_physio.display_name || data.selected_physio.first_name}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Defensive fallback
    const clinicsList = data.clinic_list;
    const clinicPage = data.clinic_page || 0;
    const reply = formatPaginatedList({
      items: clinicsList,
      formatFn: (c, idx) => `${idx}. ${c.business_name}`,
      page: clinicPage,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More clinics',
      header: 'Select a clinic:'
    }) + `\n\nReply with number. (0️⃣ Back)`;
    return reply;
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
    let data;
    try {
      data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    } catch (e) {}
    const slots = Array.isArray(data.slot_list) ? data.slot_list : [];
    let text = (message || '').trim().toLowerCase();

    if (text === 'm' || text === 'more') {
      data.slot_page = (data.slot_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleSelectSlotState(updatedSession, '');
    }

    if (['0', 'menu', 'back'].includes(text)) {
      // Use navigation chain if available
      if (data.navigation_chain && data.navigation_chain.length > 0) {
        // Restore the entire previous flow state
        let step = data.last_selection_flow;
        if (step === 'physio') {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
            data: JSON.stringify(data)
          });
          return await this.handleBookSpecificPhysio(session, '0'); // Trigger back in that handler
        }
        if (step === 'clinic') {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
            data: JSON.stringify(data)
          });
          return await this.handleBookSpecificClinic(session, '0'); // Trigger back in that handler
        }
        if (step === 'date') {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
            data: JSON.stringify(data)
          });
          return await this.handleBookSpecificDate(session, '0'); // Trigger back in that handler
        }
        if (step === 'soonest') {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SOONEST,
            data: JSON.stringify(data)
          });
          return await this.handleBookSoonest(session, '0'); // Trigger back in that handler
        }
      }
      
      // Fallback if no navigation chain
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: null
      });
      return await this.goToInteractiveMenu(session);
    }

    // Rest of the function remains the same...
    if (!slots.length) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: null
      });
      return "Sorry, I couldn't find any available appointment slots. Please try again.";
    }
    
    const page = data.slot_page || 0;
    if (!isNaN(text) && text !== '') {
      const idx = parseInt(text, 10) - 1;
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
    
    let omitPhysio = false, omitClinic = false;
    if (data.selected_physio) omitPhysio = true;
    if (data.selected_clinic) omitClinic = true;
    const reply = formatPaginatedList({
      items: slots,
      formatFn: (slot, idx) => formatSlotItem(slot, idx, { omitPhysio, omitClinic }),
      page,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More slots',
      header: 'Available slots:'
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
