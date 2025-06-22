    /**
     * Handle patient verification state - phone-based lookup
     */
    async handlePatientVerificationState(session, message, messageId) {
        this.logger.info(`Handling patient verification for session ${session.sessionId}`);
        
        const sessionData = session.sessionData || {};
        
        // If patient already verified in session, proceed to DOB verification
        if (sessionData.patient && !sessionData.verified) {
            await this.sessionManager.updateSessionState(session.sessionId, this.STATES.DOB_VERIFICATION);
            return {
                message: this.templates.dobVerification,
                nextState: this.STATES.DOB_VERIFICATION
            };
        }
        
        // If already verified, proceed based on flow
        if (sessionData.verified) {
            return await this.routeVerifiedUser(session, sessionData.flow);
        }
        
        try {
            // Look up patient by phone number
            const patient = await this.clinikoAPI.findPatientByPhone(session.phoneNumber);
            
            if (!patient) {
                return {
                    message: "❌ We couldn't find your details in our system using this phone number.\n\nThis might mean:\n• You're registered with a different number\n• You're a new patient\n\nWould you like to:\n1️⃣ Try a different phone number\n2️⃣ Register as a new patient\n3️⃣ Contact support",
                    nextState: this.STATES.SUPPORT
                };
            }
            
            // Store patient data but don't mark as verified yet
            await this.sessionManager.updateSessionData(session.sessionId, {
                ...sessionData,
                patient: patient
            });
            
            await this.sessionManager.updateSessionState(session.sessionId, this.STATES.DOB_VERIFICATION);
            
            return {
                message: this.templates.dobVerification,
                nextState: this.STATES.DOB_VERIFICATION
            };
            
        } catch (error) {
            this.logger.error(`Patient verification error: ${error.message}`);
            return {
                message: "❌ Unable to verify your details at the moment. Please try again later or contact support.",
                nextState: this.STATES.SUPPORT
            };
        }
    }

    /**
     * Handle date of birth verification state
     */
    async handleDOBVerificationState(session, message, messageId) {
        this.logger.info(`Handling DOB verification for session ${session.sessionId}`);
        
        const sessionData = session.sessionData || {};
        const dobInput = message.trim();
        
        // Validate DOB format
        if (!this.isValidDOBFormat(dobInput)) {
            return {
                message: "Please enter your date of birth in the correct format: DD/MM/YYYY\n\nExample: 15/03/1990",
                nextState: this.STATES.DOB_VERIFICATION
            };
        }
        
        try {
            // Verify DOB matches patient record
            const patient = sessionData.patient;
            if (!patient) {
                throw new Error('Patient data not found in session');
            }
            
            const dobMatch = await this.clinikoAPI.verifyPatientDOB(patient.id, dobInput);
            
            if (!dobMatch) {
                return {
                    message: "❌ The date of birth doesn't match our records. Please try again or contact support if you believe this is an error.\n\nFormat: DD/MM/YYYY",
                    nextState: this.STATES.DOB_VERIFICATION
                };
            }
            
            // Mark as verified and proceed based on flow
            await this.sessionManager.updateSessionData(session.sessionId, {
                ...sessionData,
                verified: true
            });
            
            const flow = sessionData.flow || 'booking';
            return await this.routeVerifiedUser(session, flow);
            
        } catch (error) {
            this.logger.error(`DOB verification error: ${error.message}`);
            return {
                message: "❌ Unable to verify your details at the moment. Please try again later or contact support.",
                nextState: this.STATES.SUPPORT
            };
        }
    }

    /**
     * Route verified user based on their intended flow
     */            
            practitionerSelection: "Please select your preferred practitioner:\n\n{practitioners}\n\nReply with the number of your choice.",const Logger = require('./Logger');
const DatabaseManager = require('./DatabaseManager');
const SessionManager = require('./SessionManager');
const WhatsAppAPI = require('../api/WhatsAppAPI');
const ClinikoAPI = require('../api/ClinikoAPI');

/**
 * ChatbotEngine - Core conversation orchestrator
 * Manages conversation flows, state transitions, and business logic
 */
class ChatbotEngine {
    constructor() {
        this.logger = new Logger('ChatbotEngine');
        this.sessionManager = new SessionManager();
        this.whatsappAPI = new WhatsAppAPI();
        this.clinikoAPI = new ClinikoAPI();
        this.conversationFlows = new Map();
        
        // Initialize conversation flows
        this.initializeFlows();
        
        // Conversation states
        this.STATES = {
            INITIAL: 'initial',
            MAIN_MENU: 'main_menu',
            NEW_USER_WELCOME: 'new_user_welcome',
            PATIENT_VERIFICATION: 'patient_verification',
            DOB_VERIFICATION: 'dob_verification',
            NEW_PATIENT_REGISTRATION: 'new_patient_registration',
            SERVICES_INFO: 'services_info',
            LOCATIONS_INFO: 'locations_info',
            APPOINTMENT_BOOKING: 'appointment_booking',
            APPOINTMENT_MANAGEMENT: 'appointment_management',
            PRACTITIONER_SELECTION: 'practitioner_selection',
            DATETIME_SELECTION: 'datetime_selection',
            CONFIRMATION: 'confirmation',
            FEEDBACK: 'feedback',
            SUPPORT: 'support',
            COMPLETED: 'completed',
            ERROR: 'error'
        };
        
        // Message templates
        this.templates = {
            welcome: "🏥 Welcome to {clinicName}!\n\nI'm your virtual assistant. How can I help you today?\n\n1️⃣ Book an appointment\n2️⃣ Manage existing appointment\n3️⃣ Learn about our services\n4️⃣ Contact support\n\nReply with a number or describe what you need.",
            
            mainMenu: "How can I assist you?\n\n1️⃣ Book new appointment\n2️⃣ Reschedule appointment\n3️⃣ Cancel appointment\n4️⃣ View appointment details\n5️⃣ Learn about our services\n6️⃣ Contact support\n\nReply with a number.",
            
            newUserWelcome: "👋 Hello! I can see you're new to {clinicName}.\n\nI'd love to help you learn more about us!\n\n1️⃣ View our services & rates\n2️⃣ See our locations & hours\n3️⃣ Book your first appointment\n4️⃣ Speak to our team\n\nWhat interests you most?",
            
            patientVerification: "I'm looking up your details using your phone number...\n\nPlease wait a moment. ⏳",
            
            dobVerification: "I found your details! For security, please confirm your date of birth:\n\nFormat: DD/MM/YYYY\n\nExample: 15/03/1990",
            
            
            servicesInfo: "🏥 **Our Services & Rates**\n\n💊 **General Practice**\n• Consultation: $85\n• Health Check: $120\n• Vaccination: $35\n\n🦴 **Physiotherapy**\n• Initial Assessment: $110\n• Follow-up Session: $85\n• Sports Injury: $95\n\n🧠 **Psychology**\n• Initial Consultation: $180\n• Follow-up Session: $150\n• Group Session: $120\n\n💉 **Pathology**\n• Blood Test: $45\n• Health Screen: $125\n\n*Bulk billing available for eligible patients\n\nWould you like to:\n1️⃣ Book an appointment\n2️⃣ See our locations\n3️⃣ Return to main menu",
            
            locationsInfo: "📍 **Our Locations & Hours**\n\n🏥 **Main Clinic**\n📍 123 Health Street, Melbourne VIC\n🕐 Mon-Fri: 8:00 AM - 6:00 PM\n🕐 Saturday: 9:00 AM - 2:00 PM\n📞 (03) 1234-5678\n\n🏥 **North Branch**\n📍 456 Care Avenue, North Melbourne VIC\n🕐 Mon-Fri: 9:00 AM - 5:00 PM\n🕐 Saturday: 9:00 AM - 1:00 PM\n📞 (03) 8765-4321\n\n🚗 Free parking available at both locations\n🚌 Public transport nearby\n\nWould you like to:\n1️⃣ Book an appointment\n2️⃣ View our services\n3️⃣ Get directions\n4️⃣ Return to main menu",
            
            newPatientBooking: "🆕 **New Patient Booking**\n\nGreat! I'll help you book your first appointment.\n\nTo get started, I'll need some basic information:\n\n👤 Full Name:\n📧 Email Address:\n📅 Date of Birth (DD/MM/YYYY):\n\nPlease provide these details in separate lines.",
            
            appointmentConfirmation: "📅 Appointment Summary:\n\n👤 Patient: {patientName}\n👨‍⚕️ Practitioner: {practitionerName}\n📅 Date: {date}\n🕐 Time: {time}\n🏥 Location: {location}\n\nConfirm booking? Reply 'YES' to confirm or 'NO' to modify.",
            
            bookingSuccess: "✅ Appointment booked successfully!\n\n📅 {date} at {time}\n👨‍⚕️ with {practitionerName}\n\nYou'll receive a reminder 24 hours before your appointment.\n\nReference: #{bookingId}",
            
            error: "❌ I'm sorry, something went wrong. Please try again or contact support.\n\nError: {error}",
            
            invalidInput: "I didn't understand that. Please choose from the available options or type 'help' for assistance.",
            
            supportTransfer: "🔄 Transferring you to human support. Someone will assist you shortly.\n\nIn the meantime, you can also call us at {phone} or email {email}."
        };
    }

    /**
     * Initialize conversation flows
     */
    initializeFlows() {
        // Main conversation flow
        this.conversationFlows.set('main', {
            [this.STATES.INITIAL]: this.handleInitialState.bind(this),
            [this.STATES.MAIN_MENU]: this.handleMainMenuState.bind(this),
            [this.STATES.NEW_USER_WELCOME]: this.handleNewUserWelcomeState.bind(this),
            [this.STATES.PATIENT_VERIFICATION]: this.handlePatientVerificationState.bind(this),
            [this.STATES.DOB_VERIFICATION]: this.handleDOBVerificationState.bind(this),
            [this.STATES.NEW_PATIENT_REGISTRATION]: this.handleNewPatientRegistrationState.bind(this),
            [this.STATES.SERVICES_INFO]: this.handleServicesInfoState.bind(this),
            [this.STATES.LOCATIONS_INFO]: this.handleLocationsInfoState.bind(this),
            [this.STATES.APPOINTMENT_BOOKING]: this.handleAppointmentBookingState.bind(this),
            [this.STATES.APPOINTMENT_MANAGEMENT]: this.handleAppointmentManagementState.bind(this),
            [this.STATES.PRACTITIONER_SELECTION]: this.handlePractitionerSelectionState.bind(this),
            [this.STATES.DATETIME_SELECTION]: this.handleDateTimeSelectionState.bind(this),
            [this.STATES.CONFIRMATION]: this.handleConfirmationState.bind(this),
            [this.STATES.FEEDBACK]: this.handleFeedbackState.bind(this),
            [this.STATES.SUPPORT]: this.handleSupportState.bind(this),
            [this.STATES.ERROR]: this.handleErrorState.bind(this)
        });
    }

    /**
     * Process incoming message
     * @param {string} phoneNumber - User's phone number
     * @param {string} message - Incoming message
     * @param {string} messageId - WhatsApp message ID
     */
    async processMessage(phoneNumber, message, messageId) {
        try {
            this.logger.info(`Processing message from ${phoneNumber}: ${message}`);
            
            // Get or create session
            const session = await this.sessionManager.getOrCreateSession(phoneNumber);
            
            // Store conversation
            await this.storeConversation(phoneNumber, message, 'incoming', messageId);
            
            // Process based on current state
            const currentState = session.conversationState || this.STATES.INITIAL;
            const flowHandler = this.conversationFlows.get('main')[currentState];
            
            if (!flowHandler) {
                throw new Error(`No handler found for state: ${currentState}`);
            }
            
            // Execute flow handler
            const response = await flowHandler(session, message, messageId);
            
            // Send response
            if (response) {
                await this.sendResponse(phoneNumber, response, session);
            }
            
        } catch (error) {
            this.logger.error(`Error processing message: ${error.message}`, error);
            await this.handleError(phoneNumber, error);
        }
    }

    /**
     * Handle initial state - phone number lookup and welcome
     */
    async handleInitialState(session, message, messageId) {
        this.logger.info(`Handling initial state for session ${session.sessionId}`);
        
        try {
            // Look up patient by phone number
            const patient = await this.clinikoAPI.findPatientByPhone(session.phoneNumber);
            
            if (patient) {
                // Existing patient - store patient data and go to main menu
                await this.sessionManager.updateSessionData(session.sessionId, {
                    patient: patient,
                    existingPatient: true
                });
                
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.MAIN_MENU);
                
                const clinicName = process.env.CLINIC_NAME || 'Healthcare Clinic';
                const welcomeMessage = `👋 Welcome back ${patient.firstName}!\n\n` + 
                    this.templates.mainMenu;
                
                return {
                    message: welcomeMessage,
                    nextState: this.STATES.MAIN_MENU
                };
                
            } else {
                // New user - show new user welcome
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.NEW_USER_WELCOME);
                
                const clinicName = process.env.CLINIC_NAME || 'Healthcare Clinic';
                const newUserMessage = this.templates.newUserWelcome.replace('{clinicName}', clinicName);
                
                return {
                    message: newUserMessage,
                    nextState: this.STATES.NEW_USER_WELCOME
                };
            }
            
        } catch (error) {
            this.logger.error(`Error in initial state: ${error.message}`);
            
            // If lookup fails, treat as new user
            await this.sessionManager.updateSessionState(session.sessionId, this.STATES.NEW_USER_WELCOME);
            
            const clinicName = process.env.CLINIC_NAME || 'Healthcare Clinic';
            const newUserMessage = this.templates.newUserWelcome.replace('{clinicName}', clinicName);
            
            return {
                message: newUserMessage,
                nextState: this.STATES.NEW_USER_WELCOME
            };
        }
    }

    /**
     * Handle new user welcome state
     */
    async handleNewUserWelcomeState(session, message, messageId) {
        this.logger.info(`Handling new user welcome for session ${session.sessionId}`);
        
        const input = message.trim().toLowerCase();
        
        switch (input) {
            case '1':
            case 'services':
            case 'rates':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.SERVICES_INFO);
                return {
                    message: this.templates.servicesInfo,
                    nextState: this.STATES.SERVICES_INFO
                };
                
            case '2':
            case 'locations':
            case 'hours':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.LOCATIONS_INFO);
                return {
                    message: this.templates.locationsInfo,
                    nextState: this.STATES.LOCATIONS_INFO
                };
                
            case '3':
            case 'book':
            case 'appointment':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.NEW_PATIENT_REGISTRATION);
                return {
                    message: this.templates.newPatientBooking,
                    nextState: this.STATES.NEW_PATIENT_REGISTRATION
                };
                
            case '4':
            case 'team':
            case 'speak':
            case 'support':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.SUPPORT);
                return await this.handleSupportState(session, message, messageId);
                
            default:
                return {
                    message: "Please choose from the available options (1-4) or describe what you need.",
                    nextState: this.STATES.NEW_USER_WELCOME
                };
        }
    }

    /**
     * Handle services info state
     */
    async handleServicesInfoState(session, message, messageId) {
        this.logger.info(`Handling services info for session ${session.sessionId}`);
        
        const input = message.trim().toLowerCase();
        
        switch (input) {
            case '1':
            case 'book':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.NEW_PATIENT_REGISTRATION);
                return {
                    message: this.templates.newPatientBooking,
                    nextState: this.STATES.NEW_PATIENT_REGISTRATION
                };
                
            case '2':
            case 'locations':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.LOCATIONS_INFO);
                return {
                    message: this.templates.locationsInfo,
                    nextState: this.STATES.LOCATIONS_INFO
                };
                
            case '3':
            case 'menu':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.NEW_USER_WELCOME);
                const clinicName = process.env.CLINIC_NAME || 'Healthcare Clinic';
                return {
                    message: this.templates.newUserWelcome.replace('{clinicName}', clinicName),
                    nextState: this.STATES.NEW_USER_WELCOME
                };
                
            default:
                return {
                    message: "Please choose from the available options (1-3).",
                    nextState: this.STATES.SERVICES_INFO
                };
        }
    }

    /**
     * Handle locations info state
     */
    async handleLocationsInfoState(session, message, messageId) {
        this.logger.info(`Handling locations info for session ${session.sessionId}`);
        
        const input = message.trim().toLowerCase();
        
        switch (input) {
            case '1':
            case 'book':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.NEW_PATIENT_REGISTRATION);
                return {
                    message: this.templates.newPatientBooking,
                    nextState: this.STATES.NEW_PATIENT_REGISTRATION
                };
                
            case '2':
            case 'services':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.SERVICES_INFO);
                return {
                    message: this.templates.servicesInfo,
                    nextState: this.STATES.SERVICES_INFO
                };
                
            case '3':
            case 'directions':
                return {
                    message: "🗺️ **Directions**\n\n🏥 **Main Clinic:** https://maps.google.com/?q=123+Health+Street+Melbourne\n\n🏥 **North Branch:** https://maps.google.com/?q=456+Care+Avenue+North+Melbourne\n\nWould you like to book an appointment? Reply 'YES' or choose another option.",
                    nextState: this.STATES.LOCATIONS_INFO
                };
                
            case '4':
            case 'menu':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.NEW_USER_WELCOME);
                const clinicName = process.env.CLINIC_NAME || 'Healthcare Clinic';
                return {
                    message: this.templates.newUserWelcome.replace('{clinicName}', clinicName),
                    nextState: this.STATES.NEW_USER_WELCOME
                };
                
            case 'yes':
            case 'book':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.NEW_PATIENT_REGISTRATION);
                return {
                    message: this.templates.newPatientBooking,
                    nextState: this.STATES.NEW_PATIENT_REGISTRATION
                };
                
            default:
                return {
                    message: "Please choose from the available options (1-4).",
                    nextState: this.STATES.LOCATIONS_INFO
                };
        }
    }

    /**
     * Handle new patient registration state
     */
    async handleNewPatientRegistrationState(session, message, messageId) {
        this.logger.info(`Handling new patient registration for session ${session.sessionId}`);
        
        const sessionData = session.sessionData || {};
        const registrationData = this.parseNewPatientData(message);
        
        if (!registrationData) {
            return {
                message: "Please provide all required information:\n\n👤 Full Name:\n📧 Email Address:\n📅 Date of Birth (DD/MM/YYYY):\n\nPlease enter each on a separate line.",
                nextState: this.STATES.NEW_PATIENT_REGISTRATION
            };
        }
        
        try {
            // Create new patient in Cliniko
            const patient = await this.clinikoAPI.createPatient({
                firstName: registrationData.firstName,
                lastName: registrationData.lastName,
                email: registrationData.email,
                dateOfBirth: registrationData.dob,
                phoneNumber: session.phoneNumber
            });
            
            if (patient) {
                // Store patient data in session
                await this.sessionManager.updateSessionData(session.sessionId, {
                    ...sessionData,
                    patient: patient,
                    newPatient: true,
                    verified: true
                });
                
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.PRACTITIONER_SELECTION);
                
                return {
                    message: `✅ Welcome ${patient.firstName}! Your details have been saved.\n\nLet's book your first appointment!`,
                    nextState: this.STATES.PRACTITIONER_SELECTION
                };
            } else {
                throw new Error('Failed to create patient record');
            }
            
        } catch (error) {
            this.logger.error(`New patient registration error: ${error.message}`);
            return {
                message: "❌ Unable to save your details at the moment. Please try again or contact our support team.",
                nextState: this.STATES.SUPPORT
            };
        }
    }

    /**
     * Handle main menu state - for existing patients
     */
    async handleMainMenuState(session, message, messageId) {
        this.logger.info(`Handling main menu for session ${session.sessionId}`);
        
        const input = message.trim().toLowerCase();
        
        switch (input) {
            case '1':
            case 'book':
            case 'new appointment':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.PATIENT_VERIFICATION);
                await this.sessionManager.updateSessionData(session.sessionId, { flow: 'booking' });
                return {
                    message: this.templates.patientVerification,
                    nextState: this.STATES.PATIENT_VERIFICATION
                };
                
            case '2':
            case 'reschedule':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.PATIENT_VERIFICATION);
                await this.sessionManager.updateSessionData(session.sessionId, { flow: 'reschedule' });
                return {
                    message: this.templates.patientVerification,
                    nextState: this.STATES.PATIENT_VERIFICATION
                };
                
            case '3':
            case 'cancel':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.PATIENT_VERIFICATION);
                await this.sessionManager.updateSessionData(session.sessionId, { flow: 'cancel' });
                return {
                    message: this.templates.patientVerification,
                    nextState: this.STATES.PATIENT_VERIFICATION
                };
                
            case '4':
            case 'view':
            case 'details':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.PATIENT_VERIFICATION);
                await this.sessionManager.updateSessionData(session.sessionId, { flow: 'view' });
                return {
                    message: this.templates.patientVerification,
                    nextState: this.STATES.PATIENT_VERIFICATION
                };
                
            case '5':
            case 'services':
            case 'learn':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.SERVICES_INFO);
                return {
                    message: this.templates.servicesInfo,
                    nextState: this.STATES.SERVICES_INFO
                };
                
            case '6':
            case 'support':
            case 'help':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.SUPPORT);
                return await this.handleSupportState(session, message, messageId);
                
            default:
                // Check for natural language intent
                const intent = await this.detectIntent(message);
                if (intent) {
                    return await this.handleIntent(session, intent, message);
                }
                
                return {
                    message: this.templates.invalidInput,
                    nextState: this.STATES.MAIN_MENU
                };
        }
    }

    /**
     * Handle patient verification state
     */
    async handlePatientVerificationState(session, message, messageId) {
        this.logger.info(`Handling patient verification for session ${session.sessionId}`);
        
        const sessionData = session.sessionData || {};
        
        // Parse verification data
        const verificationData = this.parseVerificationData(message);
        
        if (!verificationData) {
            return {
                message: "Please provide both your email address and date of birth in the format:\nemail@example.com\nDD/MM/YYYY",
                nextState: this.STATES.PATIENT_VERIFICATION
            };
        }
        
        try {
            // Verify patient with Cliniko
            const patient = await this.clinikoAPI.findPatient(verificationData.email, verificationData.dob);
            
            if (!patient) {
                return {
                    message: "❌ We couldn't find your details in our system. Please check your email and date of birth, or contact our support team.",
                    nextState: this.STATES.SUPPORT
                };
            }
            
            // Store patient data in session
            await this.sessionManager.updateSessionData(session.sessionId, {
                ...sessionData,
                patient: patient,
                verified: true
            });
            
            // Route based on flow
            if (sessionData.flow === 'booking') {
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.PRACTITIONER_SELECTION);
                return await this.handlePractitionerSelectionState(session, '', messageId);
            } else {
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.APPOINTMENT_MANAGEMENT);
                return await this.handleAppointmentManagementState(session, '', messageId);
            }
            
        } catch (error) {
            this.logger.error(`Patient verification error: ${error.message}`);
            return {
                message: "❌ Unable to verify your details at the moment. Please try again later or contact support.",
                nextState: this.STATES.SUPPORT
            };
        }
    }

    /**
     * Handle practitioner selection state
     */
    async handlePractitionerSelectionState(session, message, messageId) {
        this.logger.info(`Handling practitioner selection for session ${session.sessionId}`);
        
        const sessionData = session.sessionData || {};
        
        if (!message.trim()) {
            // First time - show practitioners
            try {
                const practitioners = await this.clinikoAPI.getPractitioners();
                
                if (!practitioners || practitioners.length === 0) {
                    return {
                        message: "❌ No practitioners available at the moment. Please contact support.",
                        nextState: this.STATES.SUPPORT
                    };
                }
                
                let practitionerList = '';
                practitioners.forEach((practitioner, index) => {
                    practitionerList += `${index + 1}️⃣ ${practitioner.name}\n`;
                });
                
                // Store practitioners in session
                await this.sessionManager.updateSessionData(session.sessionId, {
                    ...sessionData,
                    practitioners: practitioners
                });
                
                return {
                    message: this.templates.practitionerSelection.replace('{practitioners}', practitionerList),
                    nextState: this.STATES.PRACTITIONER_SELECTION
                };
                
            } catch (error) {
                this.logger.error(`Error fetching practitioners: ${error.message}`);
                return {
                    message: "❌ Unable to load practitioner list. Please try again later.",
                    nextState: this.STATES.ERROR
                };
            }
        }
        
        // Process selection
        const selection = parseInt(message.trim());
        const practitioners = sessionData.practitioners || [];
        
        if (isNaN(selection) || selection < 1 || selection > practitioners.length) {
            return {
                message: `Please select a valid practitioner number (1-${practitioners.length}).`,
                nextState: this.STATES.PRACTITIONER_SELECTION
            };
        }
        
        const selectedPractitioner = practitioners[selection - 1];
        
        // Update session with selected practitioner
        await this.sessionManager.updateSessionData(session.sessionId, {
            ...sessionData,
            selectedPractitioner: selectedPractitioner
        });
        
        await this.sessionManager.updateSessionState(session.sessionId, this.STATES.DATETIME_SELECTION);
        
        return {
            message: `Great! You've selected ${selectedPractitioner.name}.\n\nNow, please let me know your preferred date and time for the appointment.\n\nExample: "Next Monday at 2 PM" or "25/12/2024 at 10:30 AM"`,
            nextState: this.STATES.DATETIME_SELECTION
        };
    }

    /**
     * Handle date/time selection state
     */
    async handleDateTimeSelectionState(session, message, messageId) {
        this.logger.info(`Handling datetime selection for session ${session.sessionId}`);
        
        const sessionData = session.sessionData || {};
        const dateTimeInput = message.trim();
        
        try {
            // Parse date/time from natural language
            const parsedDateTime = this.parseDateTimeInput(dateTimeInput);
            
            if (!parsedDateTime) {
                return {
                    message: "I couldn't understand the date/time. Please try again with format like:\n• Tomorrow at 2 PM\n• 25/12/2024 at 10:30 AM\n• Next Monday 2:30 PM",
                    nextState: this.STATES.DATETIME_SELECTION
                };
            }
            
            // Check availability
            const availability = await this.clinikoAPI.checkAvailability(
                sessionData.selectedPractitioner.id,
                parsedDateTime.date,
                parsedDateTime.time
            );
            
            if (!availability.available) {
                const suggestions = await this.clinikoAPI.getSuggestedTimes(
                    sessionData.selectedPractitioner.id,
                    parsedDateTime.date
                );
                
                let suggestionText = '';
                if (suggestions && suggestions.length > 0) {
                    suggestionText = '\n\nAvailable times:\n' + 
                        suggestions.map((time, index) => `${index + 1}. ${time}`).join('\n');
                }
                
                return {
                    message: `❌ That time slot is not available.${suggestionText}\n\nPlease choose another time or date.`,
                    nextState: this.STATES.DATETIME_SELECTION
                };
            }
            
            // Store appointment details
            await this.sessionManager.updateSessionData(session.sessionId, {
                ...sessionData,
                appointmentDateTime: parsedDateTime,
                availability: availability
            });
            
            await this.sessionManager.updateSessionState(session.sessionId, this.STATES.CONFIRMATION);
            
            // Show confirmation
            const confirmationMessage = this.templates.appointmentConfirmation
                .replace('{patientName}', sessionData.patient.name)
                .replace('{practitionerName}', sessionData.selectedPractitioner.name)
                .replace('{date}', parsedDateTime.dateFormatted)
                .replace('{time}', parsedDateTime.timeFormatted)
                .replace('{location}', availability.location || 'Main Clinic');
            
            return {
                message: confirmationMessage,
                nextState: this.STATES.CONFIRMATION
            };
            
        } catch (error) {
            this.logger.error(`DateTime selection error: ${error.message}`);
            return {
                message: "❌ Unable to process your date/time selection. Please try again.",
                nextState: this.STATES.DATETIME_SELECTION
            };
        }
    }

    /**
     * Handle confirmation state
     */
    async handleConfirmationState(session, message, messageId) {
        this.logger.info(`Handling confirmation for session ${session.sessionId}`);
        
        const sessionData = session.sessionData || {};
        const input = message.trim().toLowerCase();
        
        if (input === 'yes' || input === 'y' || input === 'confirm') {
            try {
                // Book appointment via Cliniko
                const booking = await this.clinikoAPI.bookAppointment({
                    patientId: sessionData.patient.id,
                    practitionerId: sessionData.selectedPractitioner.id,
                    dateTime: sessionData.appointmentDateTime,
                    notes: `Booked via WhatsApp chatbot - Session: ${session.sessionId}`
                });
                
                if (booking.success) {
                    // Schedule reminder
                    await this.scheduleReminder(session.phoneNumber, booking.appointmentId, sessionData.appointmentDateTime);
                    
                    // Update session to completed
                    await this.sessionManager.updateSessionState(session.sessionId, this.STATES.COMPLETED);
                    
                    const successMessage = this.templates.bookingSuccess
                        .replace('{date}', sessionData.appointmentDateTime.dateFormatted)
                        .replace('{time}', sessionData.appointmentDateTime.timeFormatted)
                        .replace('{practitionerName}', sessionData.selectedPractitioner.name)
                        .replace('{bookingId}', booking.appointmentId);
                    
                    return {
                        message: successMessage,
                        nextState: this.STATES.COMPLETED
                    };
                } else {
                    throw new Error(booking.error || 'Booking failed');
                }
                
            } catch (error) {
                this.logger.error(`Booking confirmation error: ${error.message}`);
                return {
                    message: "❌ Unable to confirm your booking. Please try again or contact support.",
                    nextState: this.STATES.ERROR
                };
            }
            
        } else if (input === 'no' || input === 'n' || input === 'modify') {
            // Go back to practitioner selection
            await this.sessionManager.updateSessionState(session.sessionId, this.STATES.PRACTITIONER_SELECTION);
            return {
                message: "Let's modify your appointment. Please select a different practitioner or time.",
                nextState: this.STATES.PRACTITIONER_SELECTION
            };
        } else {
            return {
                message: "Please reply 'YES' to confirm or 'NO' to modify your appointment.",
                nextState: this.STATES.CONFIRMATION
            };
        }
    }

    /**
     * Handle appointment management state
     */
    async handleAppointmentManagementState(session, message, messageId) {
        this.logger.info(`Handling appointment management for session ${session.sessionId}`);
        
        const sessionData = session.sessionData || {};
        
        if (!sessionData.patient) {
            return {
                message: "❌ Patient verification required.",
                nextState: this.STATES.PATIENT_VERIFICATION
            };
        }
        
        try {
            // Get patient's appointments
            const appointments = await this.clinikoAPI.getPatientAppointments(sessionData.patient.id);
            
            if (!appointments || appointments.length === 0) {
                return {
                    message: "You don't have any upcoming appointments.\n\nWould you like to book a new appointment? Reply 'YES' to book or 'NO' to return to main menu.",
                    nextState: this.STATES.MAIN_MENU
                };
            }
            
            let appointmentList = "Your upcoming appointments:\n\n";
            appointments.forEach((appointment, index) => {
                appointmentList += `${index + 1}️⃣ ${appointment.dateFormatted} at ${appointment.timeFormatted}\n   with ${appointment.practitionerName}\n\n`;
            });
            
            appointmentList += "What would you like to do?\n1️⃣ Reschedule\n2️⃣ Cancel\n3️⃣ View details\n\nReply with the number of your choice.";
            
            // Store appointments in session
            await this.sessionManager.updateSessionData(session.sessionId, {
                ...sessionData,
                appointments: appointments
            });
            
            return {
                message: appointmentList,
                nextState: this.STATES.APPOINTMENT_MANAGEMENT
            };
            
        } catch (error) {
            this.logger.error(`Appointment management error: ${error.message}`);
            return {
                message: "❌ Unable to retrieve your appointments. Please try again later.",
                nextState: this.STATES.ERROR
            };
        }
    }

    /**
     * Handle support state
     */
    async handleSupportState(session, message, messageId) {
        this.logger.info(`Handling support for session ${session.sessionId}`);
        
        const phone = process.env.SUPPORT_PHONE || '(555) 123-4567';
        const email = process.env.SUPPORT_EMAIL || 'support@clinic.com';
        
        const supportMessage = this.templates.supportTransfer
            .replace('{phone}', phone)
            .replace('{email}', email);
        
        // Mark session for human handover
        await this.sessionManager.updateSessionData(session.sessionId, {
            humanHandover: true,
            handoverReason: 'User requested support',
            handoverTime: new Date().toISOString()
        });
        
        return {
            message: supportMessage,
            nextState: this.STATES.SUPPORT
        };
    }

    /**
     * Handle error state
     */
    async handleErrorState(session, message, messageId) {
        this.logger.info(`Handling error state for session ${session.sessionId}`);
        
        // Reset to main menu after error
        await this.sessionManager.updateSessionState(session.sessionId, this.STATES.MAIN_MENU);
        
        return {
            message: "I'm sorry for the inconvenience. Let's start fresh.\n\n" + this.templates.mainMenu,
            nextState: this.STATES.MAIN_MENU
        };
    }

    /**
     * Send response to user
     */
    async sendResponse(phoneNumber, response, session) {
        try {
            const messageId = await this.whatsappAPI.sendMessage(phoneNumber, response.message);
            
            // Store outgoing message
            await this.storeConversation(phoneNumber, response.message, 'outgoing', messageId);
            
            this.logger.info(`Response sent to ${phoneNumber}: ${response.message.substring(0, 50)}...`);
            
        } catch (error) {
            this.logger.error(`Error sending response: ${error.message}`);
            throw error;
        }
    }

    /**
     * Store conversation in database
     */
    async storeConversation(phoneNumber, message, direction, messageId) {
        try {
            const query = `
                INSERT INTO conversations (phone_number, message, direction, message_id, timestamp)
                VALUES (?, ?, ?, ?, datetime('now'))
            `;
            
            await DatabaseManager.run(query, [phoneNumber, message, direction, messageId]);
            
        } catch (error) {
            this.logger.error(`Error storing conversation: ${error.message}`);
        }
    }

    /**
     * Parse verification data (email and DOB)
     */
    parseVerificationData(message) {
        const lines = message.trim().split('\n').map(line => line.trim());
        
        // Look for email and date patterns
        let email = null;
        let dob = null;
        
        for (const line of lines) {
            // Email pattern
            const emailMatch = line.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
            if (emailMatch) {
                email = emailMatch[0].toLowerCase();
            }
            
            // Date pattern (DD/MM/YYYY)
            const dobMatch = line.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
            if (dobMatch) {
                dob = dobMatch[0];
            }
        }
        
        if (email && dob) {
            return { email, dob };
        }
        
        return null;
    }

    /**
     * Parse date/time from natural language
     */
    parseDateTimeInput(input) {
        // This is a simplified parser - in production, use a library like chrono-node
        const now = new Date();
        
        // Basic patterns
        const patterns = [
            {
                regex: /tomorrow\s+at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?/i,
                handler: (match) => {
                    const tomorrow = new Date(now);
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    return this.parseTime(match[1], match[2] || '00', match[3], tomorrow);
                }
            },
            {
                regex: /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?/i,
                handler: (match) => {
                    const date = new Date(match[3], match[2] - 1, match[1]);
                    return this.parseTime(match[4], match[5] || '00', match[6], date);
                }
            },
            {
                regex: /next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at?\s*(\d{1,2}):?(\d{2})?\s*(am|pm)?/i,
                handler: (match) => {
                    const dayName = match[1].toLowerCase();
                    const targetDay = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(dayName);
                    const date = this.getNextWeekday(targetDay);
                    return this.parseTime(match[2], match[3] || '00', match[4], date);
                }
            }
        ];
        
        for (const pattern of patterns) {
            const match = input.match(pattern.regex);
            if (match) {
                return pattern.handler(match);
            }
        }
        
        return null;
    }

    /**
     * Parse time with AM/PM
     */
    parseTime(hours, minutes, ampm, date) {
        let hour = parseInt(hours);
        const minute = parseInt(minutes);
        
        if (ampm) {
            if (ampm.toLowerCase() === 'pm' && hour !== 12) {
                hour += 12;
            } else if (ampm.toLowerCase() === 'am' && hour === 12) {
                hour = 0;
            }
        }
        
        const appointmentDate = new Date(date);
        appointmentDate.setHours(hour, minute, 0, 0);
        
        return {
            date: appointmentDate.toISOString().split('T')[0],
            time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
            dateFormatted: appointmentDate.toLocaleDateString('en-AU'),
            timeFormatted: appointmentDate.toLocaleTimeString('en-AU', { 
                hour: '2-digit', 
                minute: '2-digit',
                hour12: true 
            })
        };
    }

    /**
     * Get next occurrence of a weekday
     */
    getNextWeekday(targetDay) {
        const today = new Date();
        const currentDay = today.getDay();
        const daysUntilTarget = (targetDay + 7 - currentDay) % 7;
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + (daysUntilTarget || 7));
        return targetDate;
    }

    /**
     * Detect intent from natural language
     */
    async detectIntent(message) {
        const input = message.toLowerCase();
        
        // Simple intent detection - in production, use NLP service
        const intents = {
            booking: ['book', 'appointment', 'schedule', 'reserve'],
            cancellation: ['cancel', 'cancel appointment', 'delete'],
            reschedule: ['reschedule', 'change', 'move', 'modify'],
            inquiry: ['when', 'what time', 'details', 'info'],
            support: ['help', 'support', 'problem', 'issue']
        };
        
        for (const [intent, keywords] of Object.entries(intents)) {
            if (keywords.some(keyword => input.includes(keyword))) {
                return intent;
            }
        }
        
        return null;
    }

    /**
     * Handle detected intent
     */
    async handleIntent(session, intent, message) {
        switch (intent) {
            case 'booking':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.PATIENT_VERIFICATION);
                await this.sessionManager.updateSessionData(session.sessionId, { flow: 'booking' });
                return {
                    message: this.templates.patientVerification,
                    nextState: this.STATES.PATIENT_VERIFICATION
                };
                
            case 'support':
                await this.sessionManager.updateSessionState(session.sessionId, this.STATES.SUPPORT);
                return await this.handleSupportState(session, message, null);
                
            default:
                return {
                    message: this.templates.invalidInput,
                    nextState: this.STATES.MAIN_MENU
                };
        }
    }

    /**
     * Schedule appointment reminder
     */
    async scheduleReminder(phoneNumber, appointmentId, appointmentDateTime) {
        try {
            const reminderTime = new Date(appointmentDateTime.date + 'T' + appointmentDateTime.time);
            reminderTime.setHours(reminderTime.getHours() - 24); // 24 hours before
            
            const query = `
                INSERT INTO reminders (phone_number, appointment_id, reminder_time, status)
                VALUES (?, ?, ?, 'scheduled')
            `;
            
            await DatabaseManager.run(query, [
                phoneNumber,
                appointmentId,
                reminderTime.toISOString()
            ]);
            
            this.logger.info(`Reminder scheduled for ${phoneNumber} at ${reminderTime.toISOString()}`);
            
        } catch (error) {
            this.logger.error(`Error scheduling reminder: ${error.message}`);
        }
    }

    /**
     * Handle general error
     */
    async handleError(phoneNumber, error) {
        try {
            const errorMessage = this.templates.error.replace('{error}', 'Please try again');
            
            await this.whatsappAPI.sendMessage(phoneNumber, errorMessage);
            
            // Log error details
            this.logger.error(`Error handling message from ${phoneNumber}: ${error.message}`, error);
            
            // Reset session to main menu
            const session = await this.sessionManager.getOrCreateSession(phoneNumber);
            await this.sessionManager.updateSessionState(session.sessionId, this.STATES.MAIN_MENU);
            
        } catch (sendError) {
            this.logger.error(`Failed to send error message: ${sendError.message}`);
        }
    }

    /**
     * Process reminder notifications
     * Called by scheduler/cron job
     */
    async processReminders() {
        try {
            this.logger.info('Processing scheduled reminders');
            
            const query = `
                SELECT * FROM reminders 
                WHERE status = 'scheduled' 
                AND reminder_time <= datetime('now')
                ORDER BY reminder_time ASC
                LIMIT 50
            `;
            
            const reminders = await DatabaseManager.all(query);
            
            for (const reminder of reminders) {
                try {
                    // Get appointment details
                    const appointment = await this.clinikoAPI.getAppointment(reminder.appointment_id);
                    
                    if (appointment) {
                        const reminderMessage = `🔔 Appointment Reminder\n\n` +
                            `You have an appointment tomorrow:\n` +
                            `📅 ${appointment.dateFormatted}\n` +
                            `🕐 ${appointment.timeFormatted}\n` +
                            `👨‍⚕️ with ${appointment.practitionerName}\n` +
                            `🏥 ${appointment.location}\n\n` +
                            `Please reply 'CONFIRM' to confirm your attendance or 'RESCHEDULE' if you need to change the time.`;
                        
                        await this.whatsappAPI.sendMessage(reminder.phone_number, reminderMessage);
                        
                        // Update reminder status
                        await DatabaseManager.run(
                            'UPDATE reminders SET status = ?, sent_at = datetime("now") WHERE id = ?',
                            ['sent', reminder.id]
                        );
                        
                        this.logger.info(`Reminder sent to ${reminder.phone_number} for appointment ${reminder.appointment_id}`);
                    }
                    
                } catch (reminderError) {
                    this.logger.error(`Error processing reminder ${reminder.id}: ${reminderError.message}`);
                    
                    // Mark as failed
                    await DatabaseManager.run(
                        'UPDATE reminders SET status = ?, error = ? WHERE id = ?',
                        ['failed', reminderError.message, reminder.id]
                    );
                }
            }
            
        } catch (error) {
            this.logger.error(`Error processing reminders: ${error.message}`);
        }
    }

    /**
     * Get conversation statistics
     */
    async getConversationStats(phoneNumber, days = 30) {
        try {
            const query = `
                SELECT 
                    COUNT(*) as total_messages,
                    COUNT(CASE WHEN direction = 'incoming' THEN 1 END) as incoming_messages,
                    COUNT(CASE WHEN direction = 'outgoing' THEN 1 END) as outgoing_messages,
                    MIN(timestamp) as first_message,
                    MAX(timestamp) as last_message
                FROM conversations 
                WHERE phone_number = ? 
                AND timestamp >= datetime('now', '-${days} days')
            `;
            
            const stats = await DatabaseManager.get(query, [phoneNumber]);
            return stats;
            
        } catch (error) {
            this.logger.error(`Error getting conversation stats: ${error.message}`);
            return null;
        }
    }

    /**
     * Clean up old sessions and conversations
     */
    async cleanupOldData(daysOld = 90) {
        try {
            this.logger.info(`Cleaning up data older than ${daysOld} days`);
            
            // Clean old conversations
            const conversationQuery = `
                DELETE FROM conversations 
                WHERE timestamp < datetime('now', '-${daysOld} days')
            `;
            const conversationResult = await DatabaseManager.run(conversationQuery);
            
            // Clean old completed sessions
            const sessionQuery = `
                DELETE FROM sessions 
                WHERE last_activity < datetime('now', '-${daysOld} days')
                AND conversation_state IN ('completed', 'error')
            `;
            const sessionResult = await DatabaseManager.run(sessionQuery);
            
            // Clean old processed reminders
            const reminderQuery = `
                DELETE FROM reminders 
                WHERE sent_at < datetime('now', '-${daysOld} days')
                AND status IN ('sent', 'failed')
            `;
            const reminderResult = await DatabaseManager.run(reminderQuery);
            
            this.logger.info(`Cleanup completed: ${conversationResult.changes} conversations, ${sessionResult.changes} sessions, ${reminderResult.changes} reminders deleted`);
            
        } catch (error) {
            this.logger.error(`Error during cleanup: ${error.message}`);
        }
    }

    /**
     * Export conversation history
     */
    async exportConversationHistory(phoneNumber, startDate = null, endDate = null) {
        try {
            let query = `
                SELECT 
                    c.timestamp,
                    c.direction,
                    c.message,
                    c.message_id,
                    s.conversation_state,
                    s.session_data
                FROM conversations c
                LEFT JOIN sessions s ON c.phone_number = s.phone_number
                WHERE c.phone_number = ?
            `;
            
            const params = [phoneNumber];
            
            if (startDate) {
                query += ' AND c.timestamp >= ?';
                params.push(startDate);
            }
            
            if (endDate) {
                query += ' AND c.timestamp <= ?';
                params.push(endDate);
            }
            
            query += ' ORDER BY c.timestamp ASC';
            
            const conversations = await DatabaseManager.all(query, params);
            
            return conversations;
            
        } catch (error) {
            this.logger.error(`Error exporting conversation history: ${error.message}`);
            return null;
        }
    }

    /**
     * Reset user session (admin function)
     */
    async resetUserSession(phoneNumber) {
        try {
            this.logger.info(`Resetting session for ${phoneNumber}`);
            
            // Reset session state
            await this.sessionManager.updateSessionState(
                await this.sessionManager.getSessionId(phoneNumber),
                this.STATES.INITIAL
            );
            
            // Clear session data
            await this.sessionManager.updateSessionData(
                await this.sessionManager.getSessionId(phoneNumber),
                {}
            );
            
            return true;
            
        } catch (error) {
            this.logger.error(`Error resetting session: ${error.message}`);
            return false;
        }
    }

    /**
     * Get active sessions count
     */
    async getActiveSessionsCount() {
        try {
            const query = `
                SELECT COUNT(*) as count 
                FROM sessions 
                WHERE last_activity > datetime('now', '-1 hour')
                AND conversation_state NOT IN ('completed', 'error')
            `;
            
            const result = await DatabaseManager.get(query);
            return result ? result.count : 0;
            
        } catch (error) {
            this.logger.error(`Error getting active sessions count: ${error.message}`);
            return 0;
        }
    }

    /**
     * Validate session and handle expired sessions
     */
    async validateSession(session) {
        const sessionTimeout = 30 * 60 * 1000; // 30 minutes
        const now = new Date();
        const lastActivity = new Date(session.lastActivity);
        
        if (now - lastActivity > sessionTimeout) {
            // Session expired - reset to initial state
            await this.sessionManager.updateSessionState(session.sessionId, this.STATES.INITIAL);
            await this.sessionManager.updateSessionData(session.sessionId, {});
            
            return {
                expired: true,
                message: "Your session has expired due to inactivity. Let's start fresh!\n\n" + this.templates.welcome.replace('{clinicName}', process.env.CLINIC_NAME || 'Healthcare Clinic')
            };
        }
        
        return { expired: false };
    }

    /**
     * Handle webhook verification (for WhatsApp)
     */
    verifyWebhook(mode, token, challenge) {
        const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
        
        if (mode === 'subscribe' && token === verifyToken) {
            this.logger.info('Webhook verified successfully');
            return challenge;
        }
        
        this.logger.error('Webhook verification failed');
        return null;
    }

    /**
     * Process batch messages (for high volume)
     */
    async processBatchMessages(messages) {
        const results = [];
        
        for (const message of messages) {
            try {
                await this.processMessage(
                    message.phoneNumber,
                    message.message,
                    message.messageId
                );
                results.push({ success: true, messageId: message.messageId });
            } catch (error) {
                results.push({ 
                    success: false, 
                    messageId: message.messageId, 
                    error: error.message 
                });
            }
        }
        
        return results;
    }

    /**
     * Get system health status
     */
    async getHealthStatus() {
        try {
            const activeSessions = await this.getActiveSessionsCount();
            const dbStatus = await this.checkDatabaseHealth();
            const apiStatus = await this.checkAPIHealth();
            
            return {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                activeSessions,
                database: dbStatus,
                apis: apiStatus,
                uptime: process.uptime()
            };
            
        } catch (error) {
            return {
                status: 'unhealthy',
                timestamp: new Date().toISOString(),
                error: error.message
            };
        }
    }

    /**
     * Check database health
     */
    async checkDatabaseHealth() {
        try {
            await DatabaseManager.get('SELECT 1');
            return { status: 'connected' };
        } catch (error) {
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Check API health
     */
    async checkAPIHealth() {
        const results = {};
        
        try {
            await this.whatsappAPI.checkHealth();
            results.whatsapp = { status: 'connected' };
        } catch (error) {
            results.whatsapp = { status: 'error', error: error.message };
        }
        
        try {
            await this.clinikoAPI.checkHealth();
            results.cliniko = { status: 'connected' };
        } catch (error) {
            results.cliniko = { status: 'error', error: error.message };
        }
        
        return results;
    }
}

module.exports = ChatbotEngine;
