// File: /src/core/ChatbotEngine.js

const ConversationService = require('../services/ConversationService.js');
const ClinikoAPI = require('../api/ClinikoAPI.js');
const { checkDatabaseHealth, checkAPIHealth } = require('../routes/health.js');
const SessionManager = require('./SessionManager');
const Logger = require('./Logger.js');
const axios = require('axios');

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
 * Main Chatbot conversation engine for WhatsApp/Cliniko integration.
 */
class ChatbotEngine {
  constructor() {
    this.sessionManager = new SessionManager();
    this.clinikoAPI = new ClinikoAPI();
    this.STATES = {
      INTRO: 'INTRO',
      VERIFY: 'VERIFY',
      MAIN_MENU: 'MAIN_MENU',
      UNVERIFIED_MENU: 'UNVERIFIED_MENU',
      BOOK_APPOINTMENT: 'BOOK_APPOINTMENT',
      CANCEL_APPOINTMENT: 'CANCEL_APPOINTMENT',
      CONFIRM_BOOK_SLOT: 'CONFIRM_BOOK_SLOT',
      CONFIRM_CANCEL: 'CONFIRM_CANCEL',
      SELECT_APPOINTMENT_TO_CANCEL: 'SELECT_APPOINTMENT_TO_CANCEL',
      RESCHEDULE_APPOINTMENT: 'RESCHEDULE_APPOINTMENT',
      SELECT_APPOINTMENT_TO_RESCHEDULE: 'SELECT_APPOINTMENT_TO_RESCHEDULE',
      CONFIRM_RESCHEDULE: 'CONFIRM_RESCHEDULE',
      VIEW_FEES: 'VIEW_FEES',
      VIEW_PHYSIOS: 'VIEW_PHYSIOS',
      VIEW_CLINICS: 'VIEW_CLINICS',
      REGISTER_PATIENT: 'REGISTER_PATIENT',
      SELECT_PHYSIO: 'SELECT_PHYSIO',
      SELECT_CLINIC_FOR_PHYSIO: 'SELECT_CLINIC_FOR_PHYSIO',
      SELECT_SLOT: 'SELECT_SLOT',
      SELECT_CLINIC: 'SELECT_CLINIC',
      SELECT_PHYSIO_FOR_CLINIC: 'SELECT_PHYSIO_FOR_CLINIC',
      SYSTEM_HEALTH: 'SYSTEM_HEALTH',
      FALLBACK: 'FALLBACK'
    };
    this.stateHandlers = {};
    this.logger = new Logger('ChatbotEngine');
    this.isInitialized = false;

    this.initializeFlows();
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
    if (!this.STATES || !this.STATES.MAIN_MENU) {
      throw new Error('STATES not initialized before calling initializeFlows()');
    }
    this.stateHandlers = {
      [this.STATES.INTRO]: this.handleIntroState.bind(this),
      [this.STATES.VERIFY]: this.handleVerifyState.bind(this),
      [this.STATES.MAIN_MENU]: this.handleMainMenuState.bind(this),
      [this.STATES.UNVERIFIED_MENU]: this.handleUnverifiedMenuState.bind(this),
      [this.STATES.BOOK_APPOINTMENT]: this.handleBookAppointmentState.bind(this),
      [this.STATES.CONFIRM_BOOK_SLOT]: this.handleConfirmBookSlotState.bind(this),
      [this.STATES.CANCEL_APPOINTMENT]: this.handleCancelAppointmentState.bind(this),
      [this.STATES.CONFIRM_CANCEL]: this.handleConfirmCancelState.bind(this),
      [this.STATES.SELECT_APPOINTMENT_TO_CANCEL]: this.handleSelectAppointmentToCancelState.bind(this),
      [this.STATES.RESCHEDULE_APPOINTMENT]: this.handleRescheduleAppointmentState.bind(this),
      [this.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE]: this.handleSelectAppointmentToRescheduleState.bind(this),
      [this.STATES.CONFIRM_RESCHEDULE]: this.handleConfirmRescheduleState.bind(this),
      [this.STATES.VIEW_FEES]: this.handleViewFeesState.bind(this),
      [this.STATES.VIEW_PHYSIOS]: this.handleViewPhysiosState.bind(this),
      [this.STATES.VIEW_CLINICS]: this.handleViewClinicsState.bind(this),
      [this.STATES.REGISTER_PATIENT]: this.handleRegisterPatientState.bind(this),
      [this.STATES.SELECT_PHYSIO]: this.handleSelectPhysioState.bind(this),
      [this.STATES.SELECT_CLINIC_FOR_PHYSIO]: this.handleSelectClinicForPhysioState.bind(this),
      [this.STATES.SELECT_SLOT]: this.handleSelectSlotState.bind(this),
      [this.STATES.SELECT_CLINIC]: this.handleSelectClinicState.bind(this),
      [this.STATES.SELECT_PHYSIO_FOR_CLINIC]: this.handleSelectPhysioForClinicState.bind(this),
      [this.STATES.SYSTEM_HEALTH]: this.handleSystemHealthCheck.bind(this),
      [this.STATES.FALLBACK]: this.handleFallbackState.bind(this)
    };
  }
  /**
   * Unified error message with menu and support info.
   * @param {object} session
   */
  async renderErrorWithMenu(session) {
    let menu = '';
    if (session && session.verified) {
      menu = await this.renderMainMenu(session);
    } else if (session) {
      menu = await this.renderUnverifiedMenu(session);
    }
    return (
      "We encountered an unexpected error processing your request. "
      + "You can continue using the menu below, or contact support if the issue persists.\n\n"
      + menu
      + "\n\nNeed help? Call us at +65 6123 4567 or email support@prohealth.com.sg"
    );
  }

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
      this.logger.info(`🧾 Message from ${phoneNumber}: "${message}"`);
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
      this.logger.info(`📌 Current state for ${phoneNumber}: ${currentState}`);
      if (!this.stateHandlers[currentState]) {
        this.logger.warn(`No handler found for state: ${currentState}`);
        return await this.handleFallbackState(session, message);
      }
      this.logger.debug(`⚙️ Invoking handler for state: ${currentState}`);
      const response = await this.stateHandlers[currentState](session, message);
      if (session.id) {
        await this.sessionManager.db.addChatHistory(session.id, message, response);
      }
      this.logger.info(`💬 Responding to ${phoneNumber}: "${response}"`);
      return response;
    } catch (error) {
      this.logger.error('handleMessage error:', error.stack || error);

      let session;
      try {
        session = await this.sessionManager.getSessionByPhoneNumber?.(phoneNumber);
      } catch {}

      if (session) {
        return await this.renderErrorWithMenu(session);
      }
      // If even session cannot be loaded, this is likely a backend/service issue.
      return (
        "We're currently experiencing a technical issue and could not start your session. "
      + "Please try again later. If the problem continues, contact us at +65 6123 4567 or email support@prohealth.com.sg"
      );
    }
  }

  // ===============================
  // MENU RENDER HELPERS
  // ===============================

  /**
   * Render the main menu for verified users.
   * @param {object} session
   */
  async renderMainMenu(session) {
    return (
      `*Main Menu*\n` +
      `1️⃣ Book Appointment based on history \n` +
      `2️⃣ Reschedule Appointment\n` +
      `3️⃣ Cancel Appointment\n` +
      `4️⃣ View Fees\n` +
      `5️⃣ View Physios\n` +
      `6️⃣ View Clinics\n` +
      `9️⃣ Logout & Clear Data\n` +
      `0️⃣ Back to Main Menu (you are already at main menu)\n\n` +
      `Please type a number or keyword.`
    );
  }

  /**
   * Render the guest (unverified) menu.
   * @param {object} session
   */
  async renderUnverifiedMenu(session) {
    return (
      `*Guest Menu*\n` +
      `1️⃣ View Fees\n` +
      `2️⃣ View Locations\n` +
      `3️⃣ Register as New Patient\n` +
      `9️⃣ Logout & Clear Data\n` +
      `0️⃣ Back to Main Menu (you are already at guest menu)\n\n` +
      `Please type a number or keyword.`
    );
  }

  // ===============================
  // MENU STATE HANDLERS
  // ===============================

  /**
   * Handle the intro state (first message).
   * @param {object} session
   * @param {string} message
   */
  async handleIntroState(session, message) {
    const text = message.trim().toLowerCase();
    // First interaction or user types 'menu'/'0'
    if (!text || ['menu', 'hi', 'hello', 'hey', '0', 'back'].includes(text)) {
      return (
        `👋 Welcome to ProHealth Chat!\n\n` +
        `Please select an option:\n` +
        `1️⃣ Existing Patient\n` +
        `2️⃣ New Patient\n\n` +
        `Reply with the number 1 or 2.`
      );
    }
    if (text === '1' || text.includes('existing')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VERIFY,
        verified: false
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleVerifyState(updatedSession, '');
    }
    if (text === '2' || text.includes('new')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.UNVERIFIED_MENU,
        verified: false
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.renderUnverifiedMenu(updatedSession);
    }
    // Invalid option
    return (
      `Sorry, I didn't understand that.\n` +
      `Are you an existing or new patient?\n` +
      `1️⃣ Existing Patient\n` +
      `2️⃣ New Patient\n\n` +
      `Reply with 1 or 2.`
    );
  }

  /**
   * Handle fallback for any unknown state or invalid input.
   * @param {object} session
   * @param {string} message
   */
  async handleFallbackState(session, message) {
    try {
      const latestSession = await this.sessionManager.getSession(session.id);
      let returnState = latestSession.conversation_state;
      if (latestSession.verified) returnState = this.STATES.MAIN_MENU;
      else if (returnState !== this.STATES.INTRO && !latestSession.verified) returnState = this.STATES.UNVERIFIED_MENU;
      await this.sessionManager.updateSession(latestSession.id, {
        conversation_state: returnState
      });
      const refreshedSession = await this.sessionManager.getSession(latestSession.id);
      if (returnState === this.STATES.INTRO) {
        return await this.handleIntroState(refreshedSession, '');
      } else if (refreshedSession.verified) {
        return `I'm sorry, I didn't understand that.\n\n` + await this.renderMainMenu(refreshedSession);
      } else {
        return `I'm sorry, I didn't understand that.\n\n` + await this.renderUnverifiedMenu(refreshedSession);
      }
    } catch (error) {
      this.logger.error('Fallback state error:', error);
      try {
        const sessionState = await this.sessionManager.getSession(session.id);
        if (sessionState) {
          return await this.renderErrorWithMenu(sessionState);
        }
      } catch (_err) {
        // fallback if session can't be loaded
      }
      return (
        "We're currently experiencing a technical issue and could not process your request. "
      + "Please try again later. If the problem continues, contact us at +65 6123 4567 or email support@prohealth.com.sg"
      );
    }
  }

  /**
   * Handle main menu for verified users.
   * @param {object} session
   * @param {string} message
   */
  async handleMainMenuState(session, message) {
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      return await this.renderMainMenu(session);
    }
    if (text === '9' || text === 'logout') {
      await this.sessionManager.deleteSession(session.id);
      return await this.handleIntroState({ phone_number: session.phone_number }, '');
    }
    let newState = this.STATES.FALLBACK;
    if (text.includes('book') || text === '1') {
      newState = this.STATES.BOOK_APPOINTMENT;
    } else if (text.includes('reschedule') || text === '2') {
      newState = this.STATES.RESCHEDULE_APPOINTMENT;
    } else if (text.includes('cancel') || text === '3') {
      newState = this.STATES.CANCEL_APPOINTMENT;
    } else if (text.includes('fees') || text.includes('rate') || text === '4') {
      newState = this.STATES.VIEW_FEES;
    } else if (text.includes('physio') || text === '5') {
      newState = this.STATES.VIEW_PHYSIOS;
    } else if (text.includes('clinic') || text === '6' || text.includes('location')) {
      newState = this.STATES.VIEW_CLINICS;
    } else if (text.includes('health') || text.includes('status')) {
      newState = this.STATES.SYSTEM_HEALTH;
    } else if (text.includes('help')) {
      return await this.renderMainMenu(session);
    }
    await this.sessionManager.updateSession(session.id, {
      conversation_state: newState
    });
    const updatedSession = await this.sessionManager.getSession(session.id);
    return await this.stateHandlers[newState](updatedSession, '');
  }

  /**
   * Handle guest/unverified menu.
   * @param {object} session
   * @param {string} message
   */
  async handleUnverifiedMenuState(session, message) {
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      return await this.renderUnverifiedMenu(session);
    }
    if (text === '9' || text === 'logout') {
      await this.sessionManager.deleteSession(session.id);
      return await this.handleIntroState({ phone_number: session.phone_number }, '');
    }
    let newState = this.STATES.FALLBACK;
    if (text.includes('fees') || text.includes('rate') || text === '1') {
      newState = this.STATES.VIEW_FEES;
    } else if (text.includes('location') || text === '2' || text.includes('clinic')) {
      newState = this.STATES.VIEW_CLINICS;
    } else if (text.includes('register') || text === '3') {
      newState = this.STATES.REGISTER_PATIENT;
    } else if (text.includes('help')) {
      return await this.renderUnverifiedMenu(session);
    }
    await this.sessionManager.updateSession(session.id, {
      conversation_state: newState
    });
    const updatedSession = await this.sessionManager.getSession(session.id);
    return await this.stateHandlers[newState](updatedSession, '');
  }

  // ===============================
  // MESSAGE HANDLERS (USER-DRIVEN TRANSITIONS)
  // ===============================

  /**
   * Handle user identity verification state.
   * @param {object} session
   * @param {string} message
   */
  async handleVerifyState(session, message) {
    try {
      const text = message.trim();
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
      const email = text.toLowerCase();
      if (!email.includes('@') || !email.includes('.')) {
        return 'That doesn\'t look like a valid email. Please enter a valid email address to proceed.';
      }
      const patient = await this.clinikoAPI.findPatientByEmail(email);
      const clearedData = { ...data };
      delete clearedData.awaiting_email;
      if (patient) {
        // Fetch latest appointment to infer preferred practitioner and appointment type
        const phoneNumber = session.phone_number;
        try {
          const latestAppt = await this.clinikoAPI.getLatestAppointmentSummaryForPatient(patient.id);
          if (latestAppt) {
            const businessId = extractIdFromClinikoRef(latestAppt.business, 'businesses');
            const practitionerId = extractIdFromClinikoRef(latestAppt.practitioner, 'practitioners');
            const appointmentTypeId = extractIdFromClinikoRef(latestAppt.appointment_type, 'appointment_types');
            const appointmentId = latestAppt.id;
            if (businessId && practitionerId && appointmentTypeId && appointmentId) {
              session.context = {
                preferred_practitioner_id: practitionerId,
                preferred_appointment_type_id: appointmentTypeId,
                preferred_business_id: businessId,
                latest_appointment_id: appointmentId
              };
              this.logger.info(`[VERIFY] Set preferred context from latest appointment for ${phoneNumber}: practitioner ${practitionerId}, type ${appointmentTypeId}`);
            }
          } else {
            this.logger.warn(`[VERIFY] No appointments found for verified patient ${phoneNumber}`);
          }
        } catch (e) {
          this.logger.error(`[VERIFY] Failed to fetch latest appointment for ${phoneNumber}:`, e.message);
        }
        await this.sessionManager.updateSession(session.id, {
          verified: true,
          patient_id: patient.id,
          conversation_state: this.STATES.MAIN_MENU,
          data: JSON.stringify(clearedData)
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        return 'Welcome back! What would you like to do today?\n\n' + await this.renderMainMenu(updatedSession);
      } else {
        await this.sessionManager.updateSession(session.id, {
          verified: false,
          conversation_state: this.STATES.UNVERIFIED_MENU,
          data: JSON.stringify(clearedData)
        });
        const updated = await this.sessionManager.getSession(session.id);
        return 'We couldn\'t find a patient with that email.\n\n' + await this.renderUnverifiedMenu(updated);
      }
    } catch (err) {
      this.logger.error('❌ [handleVerifyState] Email verification error:', err);
      return 'Unable to verify your email right now. Please try again later.\n\n' + await this.renderUnverifiedMenu(session);
    }
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
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.UNVERIFIED_MENU });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return "We need both email and phone number to complete registration.\n\n" + await this.renderUnverifiedMenu(updatedSession);
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
          conversation_state: this.STATES.MAIN_MENU,
          data: null // Clear registration data
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        return `✅ You've been registered! Welcome ${patient.first_name}.\n\n` + await this.renderMainMenu(updatedSession);
      }
    } catch (err) {
      this.logger.error("Registration error:", err);
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.UNVERIFIED_MENU,
        data: null
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return (
        "❌ Error during registration (your details could not be registered, please check spelling or try again).\n\n"
        + (await this.renderUnverifiedMenu(updatedSession))
      );
    }
  }

// ===============================
  // MENU ACTION HANDLERS: BOOKING
  // ===============================

  /**
   * Handle booking appointment flow.
   * @param {object} session
   * @param {string} message
   */
  async handleBookAppointmentState(session, message) {
    try {
      const phoneNumber = session.phone_number || session.phoneNumber;
      // Check if user is verified for booking
      if (!session.verified && !session.isVerified) {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.VERIFY
        });
        return 'You need to be a registered patient to book appointments. Let me verify your details first.';
      }
      if (!session.verified && !session.isVerified) {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.VERIFY
          });
        const updatedSession = await this.sessionManager.getSession(session.id);
        // Immediately hand over to the verification handler
        return await this.handleVerifyState(updatedSession, '');
      }
      // Always extract context at the top!
      const {
        preferred_practitioner_id,
        preferred_appointment_type_id,
        preferred_business_id
      } = session.context || {};
      if (!preferred_practitioner_id || !preferred_appointment_type_id || !preferred_business_id) {
        this.logger.warn(`[BookAppointment] Missing context for preferred practitioner, appointment type, or business for session ${session.id}`);
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.MAIN_MENU
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        return 'Sorry, we could not retrieve your booking preferences. Please choose from the physios and clinics list.\n\n' + await this.renderMainMenu(updatedSession);
      }
      // Fetch next available slots for preferred practitioner, type, and business
      const slots = await this.clinikoAPI.getNextAvailableSlots({
        practitioner_id: preferred_practitioner_id,
        business_id: preferred_business_id
      });
      if (!slots || slots.length === 0) {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.MAIN_MENU
        });
        const updatedSession = await this.sessionManager.getSession(session.id);
        return 'Sorry, no available slots at the moment. Please try again later or call us directly.\n\n' + await this.renderMainMenu(updatedSession);
      }
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      // Present the slots in a user-friendly way
      return `Here are the next available appointment slots:\n\n${slots.map((slot, index) => {
        const dt = new Date(slot.slot);
        return `${index + 1}. ${slot.practitioner_name} — ${slot.appointment_type_name}\n   ${dt.toLocaleString()}`;
        }).join('\n')}\n\nTo book any of these slots, please call us directly or visit our website.\n\n` + await this.renderMainMenu(updatedSession);
    } catch (error) {
      this.logger.error('Booking error:', error && error.stack ? error.stack : JSON.stringify(error));
      await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.MAIN_MENU
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return 'Could not fetch appointment slots right now. Please try again later.\n\n' + await this.renderMainMenu(updatedSession);
    }
  }

  /**
   * Handle slot selection and confirmation for booking.
   * @param {object} session
   * @param {string} message
   */
  async handleSelectSlotState(session, message) {
    const text = message.trim().toLowerCase();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    if (['0', 'menu', 'back'].includes(text)) {
      // Go back to previous step
      if (data.physio_list_for_clinic && data.selected_clinic) {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_PHYSIO_FOR_CLINIC,
          data: JSON.stringify(data)
        });
        const physios = data.physio_list_for_clinic || [];
        const displayText = physios.map((p, idx) => {
          const name = p.display_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
          return `${idx + 1}. ${name}${p.specialization ? ' - ' + p.specialization : ''}`;
        }).join('\n');
        return `Physiotherapists at ${data.selected_clinic.business_name}:\n\n${displayText}\n\nPlease reply with the number of the physiotherapist to see their available slots.\n\n0️⃣ Back to Main Menu`;
      } else {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_CLINIC_FOR_PHYSIO,
          data: JSON.stringify(data)
        });
        const selectedPhysio = data.selected_physio;
        const clinics = data.attached_clinics || [];
        let clinicText = clinics.map((c, idx) =>
          `${idx + 1}. ${c.business_name}`
        ).join('\n');
        const name = `${selectedPhysio.first_name || ''} ${selectedPhysio.last_name || ''}`.trim() || selectedPhysio.display_name;
        return `Please select a clinic for ${name}:\n\n${clinicText}\n\n0️⃣ Back to Main Menu`;
      }
    }
    const slots = data.slot_list || [];
    const index = parseInt(message, 10) - 1;
    if (!slots[index]) {
      return 'Invalid selection. Please reply with the number of a slot from the list.\n\n0️⃣ Back to Main Menu';
    }
    const pickedSlot = slots[index];
    data.picked_slot = pickedSlot;
    await this.sessionManager.updateSession(session.id, {
      data: JSON.stringify(data),
      conversation_state: this.STATES.CONFIRM_BOOK_SLOT
    });
    const dt = new Date(pickedSlot.slot);
    return `You selected:\n${pickedSlot.practitioner_name} — ${pickedSlot.appointment_type_name}\n${dt.toLocaleString()}\n\nType "yes" to confirm, or "0" to go back.`;
  }

  /**
   * Handle confirmation of booking slot.
   * @param {object} session
   * @param {string} message
   */
  async handleConfirmBookSlotState(session, message) {
    const text = message.trim().toLowerCase();
    // Fetch fresh session (to get updated patient_id, etc.)
    const latestSession = await this.sessionManager.getSession(session.id);
    let data = typeof latestSession.data === 'string' ? JSON.parse(latestSession.data || '{}') : (latestSession.data || {});
    if (['0', 'menu', 'back'].includes(text)) {
      // Go back to slot selection
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      // Re-show slots
      const slots = data.slot_list || [];
      const slotText = slots.map((slot, idx) => {
        const dt = new Date(slot.slot);
        return `${idx + 1}. ${slot.practitioner_name} — ${slot.appointment_type_name}\n   ${dt.toLocaleString()}`;
      }).join('\n');
      const selectedPhysio = data.selected_physio;
      const selectedClinic = data.selected_clinic;
      const physioName = selectedPhysio && (`${selectedPhysio.first_name || ''} ${selectedPhysio.last_name || ''}`.trim() || selectedPhysio.display_name);
      return `Available slots for ${physioName} at ${selectedClinic?.business_name || ''}:\n\n${slotText}\n\nPlease reply with the number to pick a slot, or 0️⃣ Back to Main Menu.`;
    }
    if (text === 'yes') {
      // Book the appointment via API
      const patient_id = latestSession.patient_id;
      const slot = data.picked_slot;
      if (!patient_id || !slot) {
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU });
        return 'Cannot proceed with booking. Please start again.\n\n' + await this.renderMainMenu(session);
      }
      this.logger.info('Booking slot object:', JSON.stringify(slot));
      const result = await this.clinikoAPI.bookAppointment({
        patient_id,
        practitioner_id: slot.practitioner_id,
        business_id: slot.business_id,
        appointment_type_id: slot.appointment_type_id,
        starts_at: slot.slot
      });
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU });
      const updatedSession = await this.sessionManager.getSession(session.id);
      if (result.success) {
        return `✅ Your appointment is booked for:\n${slot.practitioner_name} — ${slot.appointment_type_name}\n${new Date(slot.slot).toLocaleString()}\n\n` + await this.renderMainMenu(updatedSession);
      } else {
        return `❌ Could not book your appointment. ${result.message || ''}\n\n` + await this.renderMainMenu(updatedSession);
      }
    }
    return 'Please type "yes" to confirm booking, or "0" to go back.';
  }

  // ===============================
  // MENU ACTION HANDLERS: CANCELLING
  // ===============================

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
      return 'You need to be a registered patient to cancel appointments. Let me verify your details first.';
    }
    // Fetch all future appointments
    const appts = await this.clinikoAPI.getBookingsByPatientId(patient_id);
    const futureAppts = appts.filter(a => new Date(a.starts_at) > new Date());
    if (!futureAppts.length) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU
      });
      return 'No upcoming appointments found to cancel.\n\n' + await this.renderMainMenu(session);
    }
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.cancel_appt_list = futureAppts;
    if (futureAppts.length === 1) {
      // Only one appointment, ask for confirmation
      data.selected_cancel_appt = futureAppts[0];
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.CONFIRM_CANCEL,
        data: JSON.stringify(data)
      });
      const appt = futureAppts[0];
      const dt = new Date(appt.starts_at).toLocaleString();
      let practitioner = 'Practitioner';
      if (appt.practitioner) {
        if (appt.practitioner.first_name || appt.practitioner.last_name) {
          practitioner = `${appt.practitioner.first_name || ''} ${appt.practitioner.last_name || ''}`.trim();
        } else if (appt.practitioner.display_name) {
          practitioner = appt.practitioner.display_name;
        }
      }
      const apptType = (appt.appointment_type && appt.appointment_type.name) ? appt.appointment_type.name : 'Appointment';
      return `You have one upcoming appointment:\n\n${practitioner} — ${apptType}\n${dt}\n\nType "yes" to confirm cancellation, or "0" to go back.`;
    } else {
      // Multiple, show list and prompt to pick one
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_APPOINTMENT_TO_CANCEL,
        data: JSON.stringify(data)
      });
      const listText = futureAppts.map((appt, idx) => {
        const dt = new Date(appt.starts_at).toLocaleString();
        return `${idx + 1}. ${appt.practitioner?.display_name || 'Practitioner'} — ${appt.appointment_type?.name}\n   ${dt}`;
      }).join('\n');
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
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU });
      return await this.renderMainMenu(session);
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !appts[idx]) {
      return 'Invalid selection. Please reply with the number of the appointment you want to cancel, or "0" to go back.';
    }
    data.selected_cancel_appt = appts[idx];
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.CONFIRM_CANCEL,
      data: JSON.stringify(data)
    });
    const appt = appts[idx];
    const dt = new Date(appt.starts_at).toLocaleString();
    return `You selected:\n${appt.practitioner?.display_name || 'Practitioner'} — ${appt.appointment_type?.name}\n${dt}\n\nType "yes" to confirm cancellation, or "0" to go back.`;
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
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU });
      return await this.renderMainMenu(session);
    }
    if (text === 'yes') {
      const appt = data.selected_cancel_appt;
      if (!appt?.id) {
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU });
        return 'Could not find the selected appointment. Please try again.\n\n' + await this.renderMainMenu(session);
      }
      const result = await this.clinikoAPI.cancelSpecificAppointment(appt.id);
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU, data: null });
      if (result.success) {
        return `✅ Your appointment has been canceled.\n\n` + await this.renderMainMenu(session);
      } else {
        return `❌ Could not cancel your appointment. ${result.message || ''}\n\n` + await this.renderMainMenu(session);
      }
    }
    return 'Please type "yes" to confirm cancellation, or "0" to go back.';
  }

  // ===============================
  // MENU ACTION HANDLERS: RESCHEDULING
  // ===============================

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
      return 'You need to be a registered patient to reschedule appointments. Let me verify your details first.';
    }
    // Fetch all future appointments
    const appts = await this.clinikoAPI.getBookingsByPatientId(patient_id);
    const futureAppts = appts.filter(a => new Date(a.starts_at) > new Date());
    if (!futureAppts.length) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU
      });
      return 'No upcoming appointments found to reschedule.\n\n' + await this.renderMainMenu(session);
    }
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.reschedule_appt_list = futureAppts;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE,
      data: JSON.stringify(data)
    });
    const listText = futureAppts.map((appt, idx) => {
      let practitioner = 'Practitioner';
      if (appt.practitioner) {
        if (appt.practitioner.first_name || appt.practitioner.last_name) {
          practitioner = `${appt.practitioner.first_name || ''} ${appt.practitioner.last_name || ''}`.trim();
        } else if (appt.practitioner.display_name) {
          practitioner = appt.practitioner.display_name;
        }
      }
      const apptType = (appt.appointment_type && appt.appointment_type.name) ? appt.appointment_type.name : 'Appointment';
      const dt = new Date(appt.starts_at).toLocaleString();
      return `${idx + 1}. ${practitioner} — ${apptType}\n   ${dt}`;
    }).join('\n');
    return `Your upcoming appointments:\n\n${listText}\n\nPlease reply with the number of the appointment you want to reschedule, or "0" to go back.`;
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
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU });
      return await this.renderMainMenu(session);
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !appts[idx]) {
      return 'Invalid selection. Please reply with the number of the appointment you want to reschedule, or "0" to go back.';
    }
    const appt = appts[idx];
    data.selected_reschedule_appt = appt;
    const business_id = extractIdFromClinikoRef(appt.business, 'businesses');
    const practitioner_id = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const appointment_type_id = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    if (!business_id || !practitioner_id || !appointment_type_id) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU,
        data: null
      });
      return (
        'Sorry, this appointment does not have enough information to find available slots for rescheduling. ' +
        'Please contact our clinic for assistance, or try a different appointment.\n\n' +
        await this.renderMainMenu(session)
      );
    }
    // Fetch available times for same physio, clinic, and appointment type
    const availableTimes = await this.clinikoAPI.getAvailableTimes({
      practitioner_id,
      business_id,
      appt_type: appointment_type_id
    });
    if (!availableTimes.length) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU,
        data: null
      });
      return 'Sorry, there are no available slots for this practitioner at this clinic for this appointment type. Please try again later.\n\n' + await this.renderMainMenu(session);
    }
    data.available_times = availableTimes;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.CONFIRM_RESCHEDULE,
      data: JSON.stringify(data)
    });
    const slotList = availableTimes.map((slot, i) =>
      `${i + 1}. ${new Date(slot.appointment_start).toLocaleString()}`
    ).join('\n');
    let practitioner = 'Practitioner';
    if (appt.practitioner) {
      if (appt.practitioner.first_name || appt.practitioner.last_name) {
        practitioner = `${appt.practitioner.first_name || ''} ${appt.practitioner.last_name || ''}`.trim();
      } else if (appt.practitioner.display_name) {
        practitioner = appt.practitioner.display_name;
      }
    }
    const apptType = (appt.appointment_type && appt.appointment_type.name) ? appt.appointment_type.name : 'Appointment';
    const dt = new Date(appt.starts_at).toLocaleString();
    return `You selected to reschedule:\n${practitioner} — ${apptType}\n${dt}\n\nPlease choose a new slot:\n\n${slotList}\n\nReply with the number of your chosen slot, or "0" to go back.`;
  }

  /**
   * Handle confirmation of rescheduling.
   * @param {object} session
   * @param {string} message
   */
  async handleConfirmRescheduleState(session, message) {
    const text = message.trim();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    if (['0', 'menu', 'back'].includes(text.toLowerCase())) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU, data: null });
      return await this.renderMainMenu(session);
    }
    const availableTimes = data.available_times || [];
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !availableTimes[idx]) {
      return 'Invalid slot selection. Please reply with the number of your chosen slot, or "0" to go back.';
    }
    const slot = availableTimes[idx];
    const appt = data.selected_reschedule_appt;
    if (!appt?.id) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU, data: null });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.renderMainMenu(session);
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
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU, data: null });
      return 'Could not retrieve all necessary details for rescheduling. Please try again or contact the clinic.\n\n' + await this.renderMainMenu(session);
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
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.MAIN_MENU, data: null });
    if (result.success) {
      return `✅ Your appointment has been rescheduled to:\n${new Date(payload.starts_at).toLocaleString()}\n\n` + await this.renderMainMenu(session);
    } else {
      return `❌ Could not reschedule your appointment. ${result.message || ''}\n\n` + await this.renderMainMenu(session);
    }
  }

  // ===============================
  // MENU ACTION HANDLERS: VIEWING INFO
  // ===============================

  /**
   * Handle viewing fees for clinics.
   * @param {object} session
   * @param {string} message
   */
  async handleViewFeesState(session, message) {
    try {
      const feesByClinic = `
💰 *Fee Structure by Clinic*

🏥 *Prohealth Physiofocus Pte Ltd*
• Initial: SGD 180
• Follow-up: SGD 150
• Specialties: Musculoskeletal, Sports, Post-Surgical Rehab

🏥 *Prohealth In Touch Physiotherapy*
• Initial: SGD 190
• Follow-up: SGD 160
• Specialties: Neurological, Vestibular, Geriatric

🏥 *UWC East*
• Initial: SGD 170
• Follow-up: SGD 140
• Specialties: Paediatric, School-based Sports Injuries

🏥 *UWC Dover*
• Initial: SGD 175
• Follow-up: SGD 145
• Specialties: Adolescent Care, Postural, Musculoskeletal
      `.trim();
      const newState = session.verified ? this.STATES.MAIN_MENU : this.STATES.UNVERIFIED_MENU;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: newState
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      const nextHandler = this.stateHandlers[newState];
      const menuMessage = await nextHandler(updatedSession, '');
      return `${feesByClinic}\n\n${menuMessage}`;
    } catch (error) {
      this.logger.error('Fees error:', {
        error: error?.message || String(error),
        stack: error?.stack
      });
      return `Unable to fetch fee details right now. Please call us directly.\n\n` + await this.renderMainMenu(session);
    }
  }

  /**
   * Handle viewing clinics for both verified and unverified users.
   * @param {object} session
   * @param {string} message
   */
  async handleViewClinicsState(session, message) {
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      const newState = session.verified ? this.STATES.MAIN_MENU : this.STATES.UNVERIFIED_MENU;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: newState
      });
      return session.verified
        ? await this.renderMainMenu(session)
        : await this.renderUnverifiedMenu(session);
    }
    try {
      const clinics = await this.clinikoAPI.getClinics();
      if (!clinics.length) {
        return 'Unable to fetch locations right now.\n\n' +
          (session.verified ? await this.renderMainMenu(session) : await this.renderUnverifiedMenu(session));
      }
      const displayText = clinics.map((c, idx) =>
        `${idx + 1}. ${c.business_name}\n   ${c.street_address_1}`
      ).join('\n');
      if (session.verified) {
        let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
        data.clinic_list = clinics;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.SELECT_CLINIC,
          data: JSON.stringify(data)
        });
        return `Here are our clinics:\n\n${displayText}\n\nPlease reply with the number of a clinic to see its physiotherapists.\n\n0️⃣ Back to Main Menu`;
      } else {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.UNVERIFIED_MENU
        });
        return `Here are our clinic locations:\n\n${displayText}\n\n${await this.renderUnverifiedMenu(session)}`;
      }
    } catch (err) {
      return 'Unable to fetch locations right now.\n\n' +
        (session.verified ? await this.renderMainMenu(session) : await this.renderUnverifiedMenu(session));
    }
  }

  /**
   * Handle user selection of a clinic (from list), showing physios for that clinic.
   * @param {object} session
   * @param {string} message
   */
  async handleSelectClinicState(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const clinics = data.clinic_list || [];
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU,
        data: null
      });
      return await this.renderMainMenu(session);
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !clinics[idx]) {
      return 'Invalid clinic selection. Please reply with a number from the clinics list, or 0️⃣ to go back.';
    }
    const selectedClinic = clinics[idx];
    // Get physios for this clinic
    const physios = await this.clinikoAPI.getPhysiosByClinic(selectedClinic.id);
    if (!physios || physios.length === 0) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU,
        data: null
      });
      return `No physiotherapists found for ${selectedClinic.business_name}.\n\n` + await this.renderMainMenu(session);
    }
    data.selected_clinic = selectedClinic;
    data.physio_list_for_clinic = physios;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_PHYSIO_FOR_CLINIC,
      data: JSON.stringify(data)
    });
    const displayText = physios.map((p, idx) => {
      const name = p.display_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
      return `${idx + 1}. ${name}${p.specialization ? ' - ' + p.specialization : ''}`;
    }).join('\n');
    return `Physiotherapists at ${selectedClinic.business_name}:\n\n${displayText}\n\nPlease reply with the number of the physiotherapist to see their available slots.\n\n0️⃣ Back to Main Menu`;
  }

  /**
   * Handle user selection of a physio for a chosen clinic, showing their available slots.
   * @param {object} session
   * @param {string} message
   */
  async handleSelectPhysioForClinicState(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const physios = data.physio_list_for_clinic || [];
    const selectedClinic = data.selected_clinic;
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      // Go back to clinic selection
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_CLINIC,
        data: JSON.stringify(data)
      });
      const clinics = data.clinic_list || [];
      const displayText = clinics.map((c, idx) =>
        `${idx + 1}. ${c.business_name}\n   ${c.street_address_1}`
      ).join('\n');
      return `Here are our clinics:\n\n${displayText}\n\nPlease reply with the number of a clinic to see its physiotherapists.\n\n0️⃣ Back to Main Menu`;
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !physios[idx]) {
      return 'Invalid selection. Please reply with a number from the physiotherapist list, or 0️⃣ to go back.';
    }
    const selectedPhysio = physios[idx];
    // Get next available slots for this physio at this clinic
    const slots = await this.clinikoAPI.getNextAvailableSlots({
      practitioner_id: selectedPhysio.id,
      business_id: selectedClinic.id
    });
    if (!slots || slots.length === 0) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU,
        data: null
      });
      return `No available slots for ${selectedPhysio.display_name || selectedPhysio.first_name} at ${selectedClinic.business_name}.\n\n` + await this.renderMainMenu(session);
    }
    data.selected_physio = selectedPhysio;
    data.slot_list = slots;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_SLOT,
      data: JSON.stringify(data)
    });
    const slotText = slots.map((slot, idx) => {
      const dt = new Date(slot.slot);
      return `${idx + 1}. ${slot.practitioner_name} — ${slot.appointment_type_name}\n   ${dt.toLocaleString()}`;
    }).join('\n');
    return `Available slots for ${selectedPhysio.display_name || (selectedPhysio.first_name + ' ' + selectedPhysio.last_name)} at ${selectedClinic.business_name}:\n\n${slotText}\n\nPlease reply with the number to pick a slot, or 0️⃣ Back to Main Menu.`;
  }

  /**
   * Handle viewing all physiotherapists (shows list, then lets user select one for slot viewing).
   * @param {object} session
   * @param {string} message
   */
  async handleViewPhysiosState(session, message) {
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU
      });
      return await this.renderMainMenu(session);
    }
    const physios = await this.clinikoAPI.getAllPhysios();
    if (!physios || physios.length === 0) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU
      });
      return 'Unable to fetch physiotherapists right now.\n\n' + await this.renderMainMenu(session);
    }
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.physio_list = physios;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_PHYSIO,
      data: JSON.stringify(data)
    });
    const displayText = physios.map((p, idx) => {
      const name = p.display_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
      return `${idx + 1}. ${name}${p.specialization ? ' - ' + p.specialization : ''}`;
    }).join('\n');
    return `Our physiotherapists:\n\n${displayText}\n\nPlease reply with the number of a physiotherapist to see their clinics.\n\n0️⃣ Back to Main Menu`;
  }

  /**
   * Handle user selecting a physiotherapist from the list, showing their clinics.
   * @param {object} session
   * @param {string} message
   */
  async handleSelectPhysioState(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const physios = data.physio_list || [];
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU,
        data: null
      });
      return await this.renderMainMenu(session);
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !physios[idx]) {
      return 'Invalid physiotherapist selection. Please reply with a number from the list, or 0️⃣ to go back.';
    }
    const selectedPhysio = physios[idx];
    // Get clinics for this physio
    const clinics = await this.clinikoAPI.getClinicsByPhysio(selectedPhysio.id);
    if (!clinics || clinics.length === 0) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU,
        data: null
      });
      return `No clinics found for ${selectedPhysio.display_name || selectedPhysio.first_name}.\n\n` + await this.renderMainMenu(session);
    }
    data.selected_physio = selectedPhysio;
    data.attached_clinics = clinics;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_CLINIC_FOR_PHYSIO,
      data: JSON.stringify(data)
    });
    let clinicText = clinics.map((c, idx) =>
      `${idx + 1}. ${c.business_name}`
    ).join('\n');
    const name = `${selectedPhysio.first_name || ''} ${selectedPhysio.last_name || ''}`.trim() || selectedPhysio.display_name;
    return `Please select a clinic for ${name}:\n\n${clinicText}\n\n0️⃣ Back to Main Menu`;
  }

  /**
   * Handle user selecting a clinic for a specific physio, then show their available slots there.
   * @param {object} session
   * @param {string} message
   */
  async handleSelectClinicForPhysioState(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const clinics = data.attached_clinics || [];
    const selectedPhysio = data.selected_physio;
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_PHYSIO,
        data: JSON.stringify(data)
      });
      const physios = data.physio_list || [];
      const displayText = physios.map((p, idx) => {
        const name = p.display_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
        return `${idx + 1}. ${name}${p.specialization ? ' - ' + p.specialization : ''}`;
      }).join('\n');
      return `Our physiotherapists:\n\n${displayText}\n\nPlease reply with the number of a physiotherapist to see their clinics.\n\n0️⃣ Back to Main Menu`;
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !clinics[idx]) {
      return 'Invalid clinic selection. Please reply with a number from the list, or 0️⃣ to go back.';
    }
    const selectedClinic = clinics[idx];
    // Get next available slots for this physio at this clinic
    const slots = await this.clinikoAPI.getNextAvailableSlots({
      practitioner_id: selectedPhysio.id,
      business_id: selectedClinic.id
    });
    if (!slots || slots.length === 0) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU,
        data: null
      });
      return `No available slots for ${selectedPhysio.display_name || selectedPhysio.first_name} at ${selectedClinic.business_name}.\n\n` + await this.renderMainMenu(session);
    }
    data.selected_clinic = selectedClinic;
    data.slot_list = slots;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_SLOT,
      data: JSON.stringify(data)
    });
    const slotText = slots.map((slot, idx) => {
      const dt = new Date(slot.slot);
      return `${idx + 1}. ${slot.practitioner_name} — ${slot.appointment_type_name}\n   ${dt.toLocaleString()}`;
    }).join('\n');
    const physioName = selectedPhysio.display_name || (`${selectedPhysio.first_name || ''} ${selectedPhysio.last_name || ''}`.trim());
    return `Available slots for ${physioName} at ${selectedClinic.business_name}:\n\n${slotText}\n\nPlease reply with the number to pick a slot, or 0️⃣ Back to Main Menu.`;
  }

  // ===============================
  // MISCELLANEOUS: SYSTEM HEALTH & UTILITIES
  // ===============================

  /**
   * Check system health (database and API) and show to user.
   * @param {object} session
   * @param {string} message
   */
  async handleSystemHealthCheck(session, message) {
    try {
      const dbStatus = await checkDatabaseHealth();
      const apiStatus = await checkAPIHealth();
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU
      });
      return `System Status:\n• Database: ${dbStatus ? 'Healthy' : 'Issues detected'}\n• API: ${apiStatus ? 'Healthy' : 'Issues detected'}\n\n` + await this.renderMainMenu(session);
    } catch (error) {
      this.logger.error('Health check error:', error);
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.MAIN_MENU
      });
      return 'Health check failed. Please try again later.\n\n' + await this.renderMainMenu(session);
    }
  }

  /**
   * Utility method to get session stats.
   */
  async getSessionStats() {
    try {
      return await this.sessionManager.getSessionStats();
    } catch (error) {
      this.logger.error('Failed to get session stats:', error);
      return null;
    }
  }

  /**
   * Clean up the chatbot engine, closing sessions and freeing resources.
   */
  async cleanup() {
    try {
      await this.sessionManager.close();
      this.logger.info('ChatbotEngine cleanup completed');
    } catch (error) {
      this.logger.error('Error during cleanup:', error);
    }
  }
}

module.exports = ChatbotEngine;
