// src/core/SessionManager.js
const Logger = require('./Logger');
const DatabaseManager = require('./DatabaseManager');

class SessionManager {
    constructor(databaseManager = null) {
        this.db = databaseManager || new DatabaseManager();
        this.logger = new Logger('SessionManager');
        this.sessionTimeouts = new Map();
        this.defaultSessionDuration = 30; // minutes
        this.verificationTimeout = 5; // minutes
        this.maxVerificationAttempts = 3;
        
        // Conversation states - aligned with ChatbotEngine
        this.states = {
            VERIFY: 'VERIFY',
            MAIN_MENU: 'MAIN_MENU',
            UNVERIFIED_MENU: 'UNVERIFIED_MENU', // Add missing state
            BOOK_APPOINTMENT: 'BOOK_APPOINTMENT',
            CANCEL_APPOINTMENT: 'CANCEL_APPOINTMENT',
            RESCHEDULE_APPOINTMENT: 'RESCHEDULE_APPOINTMENT',
            REGISTER_PATIENT: 'REGISTER_PATIENT',
            VIEW_FEES: 'VIEW_FEES',
            VIEW_PHYSIOS: 'VIEW_PHYSIOS',
            SYSTEM_HEALTH: 'SYSTEM_HEALTH',
            FALLBACK: 'FALLBACK',
            // Additional states for internal use
            VERIFICATION_PENDING: 'verification_pending',
            VERIFIED: 'verified',
            ERROR: 'error',
            COMPLETED: 'completed'
        };

    }

    /**
     * Initialize session manager
     */
    async initialize() {
        try {
            if (!this.db.isInitialized) {
                await this.db.initialize();
            }
            this.startCleanupInterval();
            this.logger.info('SessionManager initialized');
        } catch (error) {
            this.logger.error('Failed to initialize SessionManager:', error);
            throw error;
        }
    }

    /** 
     * Create or get existing session for a phone number D
     * Minimal additions:
     * - When a new session is created (because none active), seed region and verification from the most recent prior session for that phone (even if expired).
     * - No change to flows or endpoints; uses existing DB and context JSON.
     */
    async getOrCreateSession(phoneNumber, forceNew = false) {
      try {
        // Normalize phone number
        const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
        if (!normalizedPhone) {
          throw new Error('Invalid phone number provided');
        }

        if (!forceNew) {
          // Try to get existing active session
          const existingSession = await this.db.getSessionByPhone(normalizedPhone);
          if (existingSession && !this.isSessionExpired(existingSession)) {
            if (existingSession && existingSession.conversation_state === 'initial') {
              await this.updateSession(existingSession.id, { conversation_state: 'INTRO' });
              existingSession.conversation_state = 'INTRO';
            }
            // Update last activity safely - but don't fail if it doesn't work
            await this.updateSessionActivity(existingSession.id);
            this.logger.debug(`Retrieved existing session ${existingSession.id} for ${normalizedPhone}`);
            return this.parseSession(existingSession);
          }
        }

        // No active session: create new
        const sessionId = await this.db.createSession(
          normalizedPhone,
          null,
          this.defaultSessionDuration
        );
        if (!sessionId) {
          throw new Error('Failed to create session - no session ID returned');
        }

        // Small delay to ensure DB consistency
        await new Promise(resolve => setTimeout(resolve, 10));
        let session = await this.db.getSession(sessionId);
        if (!session) {
          throw new Error(`Session ${sessionId} was created but cannot be retrieved`);
        }

        this.logger.info(`Created new session ${sessionId} for ${normalizedPhone}`);

        // Seed new session with persistent attributes from the latest prior session (even if expired)
        try {
          const priorRows = await this.db.query(
            `SELECT * FROM sessions WHERE phone_number = ? ORDER BY last_activity DESC, created_at DESC LIMIT 1`,
            [normalizedPhone]
          );
          const prior = Array.isArray(priorRows) ? priorRows[0] : null;

          if (prior && prior.id !== sessionId) {
            // Parse prior context JSON
            let priorContext = {};
            try {
              priorContext = prior.context && typeof prior.context === 'string'
                ? JSON.parse(prior.context)
                : (prior.context || {});
            } catch {
              priorContext = {};
            }

            // Build seed updates
            const seedUpdates = {};
            const newContext = {};

            // Preserve region if available
            if (priorContext && priorContext.region) {
              newContext.region = priorContext.region;
            }

            // If prior was verified, carry over verification flags
            // We consider both the boolean 'verified' and the 'verification_status'
            const wasVerified = (prior.verified === 1) || prior.verification_status === 'verified';
            if (wasVerified) {
              seedUpdates.verified = 1;
              seedUpdates.verification_status = 'verified';
            }

            // Carry patient_id if present
            if (prior.patient_id) {
              seedUpdates.patient_id = prior.patient_id;
            }

            // Only write context if we actually have additions
            if (Object.keys(newContext).length > 0) {
              seedUpdates.context = {
                ...(session.context && typeof session.context !== 'string' ? session.context : {}),
                ...newContext
              };
            }

            if (Object.keys(seedUpdates).length > 0) {
              await this.updateSession(sessionId, seedUpdates);
              // re-fetch the session row for accurate parse
              session = await this.db.getSession(sessionId);
            }
          }
        } catch (seedErr) {
          this.logger.warn('Seeding new session from prior session failed (non-fatal):', seedErr?.message || seedErr);
        }

        // Return parsed session
        return this.parseSession(session);
      } catch (error) {
        this.logger.error('Failed to get or create session:', error);
        throw new Error('Session creation failed: ' + error.message);
      }
    }

    /**
     * Get session by ID
     */
    async getSession(sessionId) {
        try {
            if (!sessionId) {
                return null;
            }

            const session = await this.db.getSession(sessionId);
            if (!session) {
                return null;
            }
            
            // Check if session is expired
            if (this.isSessionExpired(session)) {
                this.logger.debug(`Session ${sessionId} is expired`);
                return null;
            }
            
            await this.updateSessionActivity(sessionId);
            return this.parseSession(session);
        } catch (error) {
            this.logger.error(`Failed to get session ${sessionId}:`, error);
            return null;
        }
    }

    /**
     * Get session by phone number
     */
    async getSessionByPhone(phoneNumber) {
        try {
            const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
            if (!normalizedPhone) {
                return null;
            }

            const session = await this.db.getSessionByPhone(normalizedPhone);
            if (!session) {
                return null;
            }
            
            // Check if session is expired
            if (this.isSessionExpired(session)) {
                this.logger.debug(`Session ${session.id} is expired for phone ${normalizedPhone}`);
                return null;
            }
            
            await this.updateSessionActivity(session.id);
            return this.parseSession(session);
        } catch (error) {
            this.logger.error(`Failed to get session by phone ${phoneNumber}:`, error);
            return null;
        }
    }

    /**
     * Check if session is expired
     */
    isSessionExpired(session) {
        if (!session || !session.expires_at) {
            return true;
        }
        return new Date(session.expires_at) <= new Date();
    }

    /**
     * Update session state and context
     */
    async updateSession(sessionId, updates = {}) {
        try {
            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const allowedUpdates = [
                'patient_id', 'verification_status', 'conversation_state', 'context', 'verified', "data"
            ];

            const filteredUpdates = {};
            for (const [key, value] of Object.entries(updates)) {
                if (allowedUpdates.includes(key)) {
                    if (key === 'context' && typeof value === 'object') {
                        filteredUpdates[key] = JSON.stringify(value);
                    } else {
                        filteredUpdates[key] = value;
                    }
                }
            }

            if (Object.keys(filteredUpdates).length === 0) {
                this.logger.warn(`No valid updates provided for session ${sessionId}`);
                return await this.getSession(sessionId);
            }

            const result = await this.db.updateSession(sessionId, filteredUpdates);
            if (result === 0) {
                this.logger.warn(`No session found to update with ID ${sessionId}`);
                return null;
            }

            this.logger.debug(`Updated session ${sessionId}:`, filteredUpdates);
            return await this.getSession(sessionId);
        } catch (error) {
            this.logger.error(`Failed to update session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Save session - handles both session objects and phone number lookups
     */
    async saveSession(session) {
        try {
            if (!session) {
                throw new Error('Session object is required');
            }

            // Handle different input types
            let sessionToSave;
            let sessionId;

            if (typeof session === 'string') {
                // If it's a phone number, get the session first
                const phoneNumber = this.normalizePhoneNumber(session);
                sessionToSave = await this.getSessionByPhone(phoneNumber);
                if (!sessionToSave) {
                    throw new Error(`No session found for phone number: ${phoneNumber}`);
                }
                sessionId = sessionToSave.id;
            } else if (session.id) {
                // If it's a session object with ID
                sessionId = session.id;
                sessionToSave = session;
            } else if (session.phone_number || session.phoneNumber) {
                // If it's a session object without ID, try to find by phone
                const phoneNumber = this.normalizePhoneNumber(session.phone_number || session.phoneNumber);
                const existingSession = await this.getSessionByPhone(phoneNumber);
                if (existingSession) {
                    sessionId = existingSession.id;
                    sessionToSave = { ...existingSession, ...session };
                } else {
                    throw new Error(`No session found for phone number: ${phoneNumber}`);
                }
            } else {
                throw new Error('Session must have either id or phone_number');
            }

            // Prepare updates
            const updates = {};
            
            // Map common session properties
            if (sessionToSave.verified !== undefined) {
                updates.verified = sessionToSave.verified ? 1 : 0;
            }
            if (sessionToSave.state) {
                updates.conversation_state = sessionToSave.state;
            }
            if (sessionToSave.conversation_state) {
                updates.conversation_state = sessionToSave.conversation_state;
            }
            if (sessionToSave.context) {
                updates.context = sessionToSave.context;
            }
            if (sessionToSave.patient_id) {
                updates.patient_id = sessionToSave.patient_id;
            }
            if (sessionToSave.verification_status) {
                updates.verification_status = sessionToSave.verification_status;
            }

            return await this.updateSession(sessionId, updates);
        } catch (error) {
            this.logger.error('Failed to save session:', error);
            throw error;
        }
    }

    /**
     * Start patient verification process
     */
    async startVerification(sessionId, patientData) {
        try {
            const updates = {
                patient_id: patientData.id,
                verification_status: 'pending',
                conversation_state: this.states.VERIFICATION_PENDING,
                context: {
                    patient_name: `${patientData.first_name} ${patientData.last_name}`,
                    verification_attempts: 0,
                    verification_started: new Date().toISOString()
                }
            };

            await this.updateSession(sessionId, updates);
            
            // Set verification timeout
            this.setVerificationTimeout(sessionId);
            
            this.logger.info(`Started verification for session ${sessionId}, patient ${patientData.id}`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to start verification for session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Complete patient verification
     */
    async completeVerification(sessionId, verified = true) {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            const updates = {
                verification_status: verified ? 'verified' : 'failed',
                conversation_state: verified ? this.states.VERIFIED : this.states.ERROR,
                verified: verified ? 1 : 0
            };

            if (verified) {
                // Update context to remove verification data
                const context = session.context || {};
                delete context.verification_attempts;
                updates.context = context;
            }

            await this.updateSession(sessionId, updates);
            
            // Clear verification timeout
            this.clearVerificationTimeout(sessionId);
            
            this.logger.info(`Verification ${verified ? 'completed' : 'failed'} for session ${sessionId}`);
            return verified;
        } catch (error) {
            this.logger.error(`Failed to complete verification for session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Handle verification attempt (e.g., date of birth check)
     */
    async handleVerificationAttempt(sessionId, success = false) {
        try {
            const session = await this.getSession(sessionId);
            if (!session || session.verification_status !== 'pending') {
                throw new Error('Invalid session state for verification');
            }

            const context = session.context || {};
            const attempts = (context.verification_attempts || 0) + 1;

            if (success) {
                return await this.completeVerification(sessionId, true);
            }

            if (attempts >= this.maxVerificationAttempts) {
                await this.completeVerification(sessionId, false);
                return false;
            }

            // Update attempt count
            context.verification_attempts = attempts;
            await this.updateSession(sessionId, { context });
            
            this.logger.debug(`Verification attempt ${attempts} failed for session ${sessionId}`);
            return null; // Continue verification process
        } catch (error) {
            this.logger.error(`Failed to handle verification attempt for session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Set conversation state
     */
    async setState(sessionId, state, context = null) {
        try {
            if (!Object.values(this.states).includes(state)) {
                this.logger.warn(`Invalid state: ${state}, using FALLBACK instead`);
                state = this.states.FALLBACK;
            }

            const updates = { conversation_state: state };
            if (context) {
                updates.context = context;
            }

            await this.updateSession(sessionId, updates);
            this.logger.debug(`Set state ${state} for session ${sessionId}`);
            
            return await this.getSession(sessionId);
        } catch (error) {
            this.logger.error(`Failed to set state for session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Add context data to session
     */
    async addContext(sessionId, contextData) {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            const existingContext = session.context || {};
            const newContext = { ...existingContext, ...contextData };

            await this.updateSession(sessionId, { context: newContext });
            this.logger.debug(`Added context to session ${sessionId}:`, contextData);
            
            return newContext;
        } catch (error) {
            this.logger.error(`Failed to add context to session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Get context data from session
     */
    async getContext(sessionId, key = null) {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                return null;
            }

            const context = session.context || {};
            return key ? context[key] : context;
        } catch (error) {
            this.logger.error(`Failed to get context from session ${sessionId}:`, error);
            return null;
        }
    }

    /**
     * Check if session is verified
     */
    async isVerified(sessionId) {
        try {
            const session = await this.getSession(sessionId);
            return session && (session.verification_status === 'verified' || session.verified);
        } catch (error) {
            this.logger.error(`Failed to check verification status for session ${sessionId}:`, error);
            return false;
        }
    }

    /**
     * Check if session requires verification
     */
    requiresVerification(state) {
        const protectedStates = [
            this.states.BOOK_APPOINTMENT,
            this.states.CANCEL_APPOINTMENT,
            this.states.RESCHEDULE_APPOINTMENT
        ];
        return protectedStates.includes(state);
    }

    /**
     * Extend session expiration
     */
    async extendSession(sessionId, additionalMinutes = 30) {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            const currentExpiry = new Date(session.expires_at);
            const newExpiry = new Date(currentExpiry.getTime() + additionalMinutes * 60 * 1000);

            await this.db.updateSession(sessionId, {
                expires_at: newExpiry.toISOString()
            });

            this.logger.debug(`Extended session ${sessionId} by ${additionalMinutes} minutes`);
            return newExpiry;
        } catch (error) {
            this.logger.error(`Failed to extend session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * End session
     */
    async endSession(sessionId, reason = 'completed') {
        try {
            await this.setState(sessionId, this.states.COMPLETED, { end_reason: reason });
            await this.db.deleteSession(sessionId);
            
            this.clearVerificationTimeout(sessionId);
            this.logger.info(`Ended session ${sessionId}, reason: ${reason}`);
            
            return true;
        } catch (error) {
            this.logger.error(`Failed to end session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Update session activity timestamp - FIXED with better error handling
     */
    async updateSessionActivity(sessionId) {
        try {
            if (!sessionId) {
                this.logger.warn('Cannot update activity: sessionId is required');
                return false;
            }

            // First check if session exists
            const session = await this.db.getSession(sessionId);
            if (!session) {
                this.logger.warn(`Cannot update activity: session ${sessionId} not found`);
                return false;
            }

            // Check if session is expired before updating
            if (this.isSessionExpired(session)) {
                this.logger.debug(`Session ${sessionId} is expired, skipping activity update`);
                return false;
            }

            // Update last_activity AND extend expires_at (sliding window).
            // This prevents an active session from expiring mid-flow (e.g. mid-booking).
            // The window resets on every message, so the session stays alive as long as
            // the user keeps interacting — it only expires after a full period of inactivity.
            const timestamp = new Date().toISOString();
            const newExpiry = new Date(Date.now() + this.defaultSessionDuration * 60 * 1000).toISOString();
            const result = await this.db.updateSession(sessionId, {
                last_activity: timestamp,
                expires_at: newExpiry
            });

            if (result === 0) {
                this.logger.warn(`No rows updated for session activity ${sessionId}`);
                return false;
            }

            this.logger.debug(`Updated activity for session ${sessionId}, expires ${newExpiry}`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to update activity for session ${sessionId}:`, {
                error: error.message,
                stack: error.stack
            });
            return false;
        }
    }

    /**
     * Set verification timeout
     */
    setVerificationTimeout(sessionId) {
        this.clearVerificationTimeout(sessionId);
        
        const timeout = setTimeout(async () => {
            try {
                const session = await this.getSession(sessionId);
                if (session && session.verification_status === 'pending') {
                    await this.completeVerification(sessionId, false);
                    this.logger.info(`Verification timeout for session ${sessionId}`);
                }
            } catch (error) {
                this.logger.error(`Error handling verification timeout for ${sessionId}:`, error);
            }
        }, this.verificationTimeout * 60 * 1000);

        this.sessionTimeouts.set(sessionId, timeout);
    }

    /**
     * Clear verification timeout
     */
    clearVerificationTimeout(sessionId) {
        const timeout = this.sessionTimeouts.get(sessionId);
        if (timeout) {
            clearTimeout(timeout);
            this.sessionTimeouts.delete(sessionId);
        }
    }

    /**
     * Parse session data from database
     */
    parseSession(sessionData) {
        if (!sessionData) return null;

        const session = { ...sessionData };

        // Normalize phone number properties
        if (!session.phoneNumber && session.phone_number) {
            session.phoneNumber = session.phone_number;
        }
        if (!session.phone_number && session.phoneNumber) {
            session.phone_number = session.phoneNumber;
        }

        // Normalize verification status
        if (!session.verificationStatus && session.verification_status) {
            session.verificationStatus = session.verification_status;
        }

        // Normalize legacy state values from old schema (DEFAULT 'initial' → 'INTRO')
        if (session.conversation_state === 'initial') {
            session.conversation_state = 'INTRO';
        }

        // Map conversation_state to state for compatibility
        if (!session.state && session.conversation_state) {
            session.state = session.conversation_state;
        }

        // Normalize verified field
        if (session.verified === undefined && session.verification_status === 'verified') {
            session.verified = true;
        } else if (typeof session.verified === 'number') {
            session.verified = session.verified === 1;
        }

        // Parse context JSON
        if (session.context && typeof session.context === 'string') {
            try {
                session.context = JSON.parse(session.context);
            } catch (error) {
                this.logger.warn(`Failed to parse context for session ${session.id}:`, error);
                session.context = {};
            }
        } else if (!session.context) {
            session.context = {};
        }

        // Computed properties
        session.isExpired = this.isSessionExpired(session);
        session.isVerified = session.verification_status === 'verified' || session.verified;
        session.timeRemaining = Math.max(0, new Date(session.expires_at) - new Date());

        return session;
    }
    
    /**
     * Normalize phone number to consistent format
     */
    normalizePhoneNumber(phoneNumber) {
        if (!phoneNumber) return null;
        
        // Remove all non-digit characters
        const digits = phoneNumber.replace(/\D/g, '');
        
        // Validate minimum length
        if (digits.length < 10) {
            this.logger.warn(`Invalid phone number length: ${digits.length} digits`);
            return null;
        }
        
        // Handle different country codes and formats
        if (digits.startsWith('91') && digits.length === 12) {
            // Indian format: +91xxxxxxxxxx
            return `+${digits}`;
        } else if (digits.startsWith('0') && digits.length === 11) {
            // Indian domestic format: 0xxxxxxxxxx -> +91xxxxxxxxxx
            return `+91${digits.substring(1)}`;
        } else if (digits.startsWith('65') && digits.length === 10) {
            // Singapore format: 65xxxxxxxx (CC 65 + 8-digit local)
            return `+${digits}`;
        } else if (digits.length === 10) {
            // Indian without leading 0: xxxxxxxxxx -> +91xxxxxxxxxx
            return `+91${digits}`;
        } else if (digits.startsWith('61') && digits.length === 11) {
            // Australian format: +61xxxxxxxxx
            return `+${digits}`;
        } else if (digits.startsWith('1') && digits.length === 11) {
            // US/Canada format: +1xxxxxxxxxx
            return `+${digits}`;
        }
        
        // Default: assume it's already in international format or add +
        return digits.startsWith('+') ? phoneNumber : `+${digits}`;
    }

    /**
     * Get session statistics
     */
    async getSessionStats() {
        try {
            const stats = await this.db.getStats();
            const timeouts = this.sessionTimeouts.size;
            
            return {
                ...stats,
                active_timeouts: timeouts,
                states: this.states
            };
        } catch (error) {
            this.logger.error('Failed to get session stats:', error);
            throw error;
        }
    }

    /**
     * Start cleanup interval for expired sessions
     */
    startCleanupInterval() {
        // Clean up expired sessions every 10 minutes
        this.cleanupInterval = setInterval(async () => {
            try {
                const cleaned = await this.db.cleanupExpiredSessions();
                if (cleaned > 0) {
                    this.logger.info(`Cleaned up ${cleaned} expired sessions`);
                }
            } catch (error) {
                this.logger.error('Session cleanup failed:', error);
            }
        }, 10 * 60 * 1000);

        this.logger.debug('Started session cleanup interval');
    }

    /**
     * Validate session state transition
     */
    validateStateTransition(currentState, newState) {
        const validTransitions = {
            [this.states.VERIFY]: [
                this.states.VERIFICATION_PENDING,
                this.states.VERIFIED,
                this.states.MAIN_MENU,
                this.states.UNVERIFIED_MENU,
                this.states.VIEW_FEES,
                this.states.VIEW_PHYSIOS,
                this.states.ERROR
            ],
            [this.states.VERIFICATION_PENDING]: [
                this.states.VERIFIED,
                this.states.ERROR,
                this.states.VERIFY
            ],
            [this.states.VERIFIED]: [
                this.states.MAIN_MENU,
                this.states.BOOK_APPOINTMENT,
                this.states.CANCEL_APPOINTMENT,
                this.states.RESCHEDULE_APPOINTMENT,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.MAIN_MENU]: [
                this.states.BOOK_APPOINTMENT,
                this.states.CANCEL_APPOINTMENT,
                this.states.RESCHEDULE_APPOINTMENT,
                this.states.REGISTER_PATIENT,
                this.states.VIEW_FEES,
                this.states.VIEW_PHYSIOS,
                this.states.SYSTEM_HEALTH,
                this.states.FALLBACK,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.UNVERIFIED_MENU]: [
                this.states.VIEW_FEES,
                this.states.VIEW_PHYSIOS,
                this.states.REGISTER_PATIENT,
                this.states.FALLBACK,
                this.states.ERROR
            ],
            [this.states.BOOK_APPOINTMENT]: [
                this.states.MAIN_MENU,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.CANCEL_APPOINTMENT]: [
                this.states.MAIN_MENU,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.RESCHEDULE_APPOINTMENT]: [
                this.states.MAIN_MENU,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.REGISTER_PATIENT]: [
                this.states.MAIN_MENU,
                this.states.UNVERIFIED_MENU,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.VIEW_FEES]: [
                this.states.MAIN_MENU,
                this.states.UNVERIFIED_MENU,
                this.states.REGISTER_PATIENT,
                this.states.ERROR
            ],
            [this.states.VIEW_PHYSIOS]: [
                this.states.MAIN_MENU,
                this.states.UNVERIFIED_MENU,
                this.states.REGISTER_PATIENT,
                this.states.ERROR
            ],
            [this.states.SYSTEM_HEALTH]: [
                this.states.MAIN_MENU,
                this.states.ERROR
            ],
            [this.states.FALLBACK]: [
                this.states.MAIN_MENU,
                this.states.UNVERIFIED_MENU,
                this.states.ERROR
            ],
            [this.states.ERROR]: [
                this.states.VERIFY,
                this.states.MAIN_MENU,
                this.states.UNVERIFIED_MENU,
                this.states.COMPLETED
            ],
            [this.states.COMPLETED]: []
        };

        const allowedStates = validTransitions[currentState] || [];
        return allowedStates.includes(newState);
    }

    /**
     * Handle session error
     */
    async handleSessionError(sessionId, error, context = {}) {
        try {
            const errorContext = {
                ...context,
                error_message: error.message,
                error_timestamp: new Date().toISOString()
            };

            await this.setState(sessionId, this.states.ERROR, errorContext);
            this.logger.error(`Session ${sessionId} error:`, error);
        } catch (updateError) {
            this.logger.error(`Failed to update session error state for ${sessionId}:`, updateError);
        }
    }

    /**
     * Get all active sessions for monitoring
     */
    async getActiveSessions() {
        try {
            const sql = `
                SELECT id, phone_number, verification_status, conversation_state, 
                       created_at, last_activity, expires_at
                FROM sessions 
                WHERE expires_at > datetime('now')
                ORDER BY last_activity DESC
            `;
            return await this.db.query(sql);
        } catch (error) {
            this.logger.error('Failed to get active sessions:', error);
            throw error;
        }
    }

    /**
     * Cleanup and close
     */
    async close() {
        // Clear all timeouts
        for (const timeout of this.sessionTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.sessionTimeouts.clear();

        // Close database connection
        if (this.db && typeof this.db.close === 'function') {
            await this.db.close();
        }

        this.logger.info('SessionManager closed');
    }

    /**
     * Delete a session by sessionId
     */
    async deleteSession(sessionId) {
        try {
            await this.db.deleteSession(sessionId);
            this.clearVerificationTimeout(sessionId);
            this.logger.info(`Deleted session ${sessionId}`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to delete session ${sessionId}:`, error);
            throw error;
        }
    }
    /**
     * Delete a session and all related data (chat history, verification codes).
     * @param {string} sessionId - The session ID to delete.
     * @returns {Promise<number>} - Number of session rows deleted (0 or 1).
     */
    async deleteSessionAndData(sessionId) {
        this.logger.debug(`[deleteSessionAndData] Called for session: ${sessionId}`);
        // Get session to find phone number for verification codes
        const session = await this.getSession(sessionId);
        if (!session) {
            this.logger.warn(`[deleteSessionAndData] Session not found: ${sessionId}`);
            return 0;
        }
        const phoneNumber = session.phone_number;

        // Delete chat history (use DatabaseManager.query)
        await this.db.query(
            `DELETE FROM chat_history WHERE session_id = ?`,
            [sessionId]
        );
        this.logger.debug(`[deleteSessionAndData] Deleted chat history for session: ${sessionId}`);

        // Delete verification codes for this phone number (use DatabaseManager.query)
        if (phoneNumber) {
            await this.db.query(
                `DELETE FROM verification_codes WHERE phone_number = ?`,
                [phoneNumber]
            );
            this.logger.debug(`[deleteSessionAndData] Deleted verification codes for phone: ${phoneNumber}`);
        }

        // Delete the session itself (use DatabaseManager.deleteSession)
        const deleted = await this.db.deleteSession(sessionId);
        this.logger.debug(`[deleteSessionAndData] Deleted session row: ${sessionId}`);
        return deleted;
    }

    /**
     * Extract region/country from phone number.
     * -------------------------------------------------------------
     * Handles international (+NN / 00NN) and local formats.
     * - Recognizes prefixes: +65/+852/+91/+63 and domestic formats.
     * - Handles 0065… , 0091… , 0063… equivalents.
     * - Differentiates HK vs SG by prefix when ambiguous 8‑digit number.
     * -------------------------------------------------------------
     * @param {string} phoneNumber
     * @returns {{region:'HK'|'SG'|'IN'|'PH'|undefined, countryCode:string|undefined, nationalNumber:string|undefined}}
     */
    getRegionFromPhoneNumber(phoneNumber) {
      if (!phoneNumber) return { region: undefined, countryCode: undefined, nationalNumber: undefined };
      const digits = phoneNumber.replace(/\D/g, '');

      // Normalize 00‑prefixed numbers to + form
      const normalized = digits.startsWith('00') ? digits.slice(2) : digits;

      // ---- India 🇮🇳 ----
      if (normalized.startsWith('91') && normalized.length >= 12) {
        return { region: 'IN', countryCode: '91', nationalNumber: normalized.slice(-10) };
      }
      // 0XXXXXXXXXX (11 digits, local)
      if (/^0\d{10}$/.test(digits)) {
        return { region: 'IN', countryCode: '91', nationalNumber: digits.slice(-10) };
      }
      if (/^\d{10}$/.test(digits)) {
        return { region: 'IN', countryCode: '91', nationalNumber: digits };
      }

      // ---- Philippines 🇵🇭 ----
      if (normalized.startsWith('63') && (normalized.length === 12 || normalized.length === 11)) {
        return { region: 'PH', countryCode: '63', nationalNumber: normalized.slice(2) };
      }
      // Local 09XXXXXXXXX (11 digits)
      if (/^09\d{9}$/.test(digits)) {
        return { region: 'PH', countryCode: '63', nationalNumber: digits.slice(1) };
      }

      // ---- Singapore 🇸🇬 ----
      if (normalized.startsWith('65') && normalized.length >= 10) {
        return { region: 'SG', countryCode: '65', nationalNumber: normalized.slice(-8) };
      }
      // Local 8‑digit not starting with 0 or 1
      if (/^[89]\d{7}$/.test(digits)) {
        return { region: 'SG', countryCode: '65', nationalNumber: digits };
      }

      // ---- Hong Kong 🇭🇰 ----
      if (normalized.startsWith('852') && normalized.length >= 11) {
        return { region: 'HK', countryCode: '852', nationalNumber: normalized.slice(-8) };
      }
      // Local 8‑digit starting with 5‑9 but not 0
      if (/^[5-9]\d{7}$/.test(digits)) {
        return { region: 'HK', countryCode: '852', nationalNumber: digits };
      }

      // fallback — or SG if FORCE_REGION_SG is set (only reaches here when no prefix matched)
      if (process.env.FORCE_REGION_SG === 'true') {
        this.logger.debug('[getRegionFromPhoneNumber] No country prefix matched; falling back to SG via FORCE_REGION_SG', { phoneNumber });
        const national = digits ? digits.slice(-8) : undefined;
        return { region: 'SG', countryCode: '65', nationalNumber: national };
      }
      return { region: undefined, countryCode: undefined, nationalNumber: undefined };
    }
    
}

module.exports = SessionManager;
