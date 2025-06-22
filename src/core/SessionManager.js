// src/core/SessionManager.js
const Logger = require('./Logger');
const DatabaseManager = require('./DatabaseManager');

class SessionManager {
    constructor(databaseManager = null) {
        this.db = databaseManager || new DatabaseManager();
        this.logger = new Logger();
        this.sessionTimeouts = new Map();
        this.defaultSessionDuration = 30; // minutes
        this.verificationTimeout = 5; // minutes
        this.maxVerificationAttempts = 3;
        
        // Conversation states
        this.states = {
            INITIAL: 'initial',
            VERIFICATION_PENDING: 'verification_pending',
            VERIFIED: 'verified',
            APPOINTMENT_BOOKING: 'appointment_booking',
            APPOINTMENT_DETAILS: 'appointment_details',
            CANCELLATION: 'cancellation',
            RESCHEDULING: 'rescheduling',
            COMPLETED: 'completed',
            ERROR: 'error'
        };

        // Start cleanup interval
        this.startCleanupInterval();
    }

    /**
     * Initialize session manager
     */
    async initialize() {
        if (!this.db.isInitialized) {
            await this.db.initialize();
        }
        this.logger.info('SessionManager initialized');
    }

    /**
     * Create or get existing session for a phone number
     */
    async getOrCreateSession(phoneNumber, forceNew = false) {
        try {
            // Normalize phone number
            const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
            
            if (!forceNew) {
                // Try to get existing active session
                const existingSession = await this.db.getSessionByPhone(normalizedPhone);
                if (existingSession) {
                    // Update last activity
                    await this.updateSessionActivity(existingSession.id);
                    this.logger.debug(`Retrieved existing session ${existingSession.id} for ${normalizedPhone}`);
                    return this.parseSession(existingSession);
                }
            }

            // Create new session
            const sessionId = await this.db.createSession(
                normalizedPhone, 
                null, 
                this.defaultSessionDuration
            );

            const session = await this.db.getSession(sessionId);
            this.logger.info(`Created new session ${sessionId} for ${normalizedPhone}`);
            
            return this.parseSession(session);
        } catch (error) {
            this.logger.error('Failed to get or create session:', error);
            throw new Error('Session creation failed');
        }
    }

    /**
     * Get session by ID
     */
    async getSession(sessionId) {
        try {
            const session = await this.db.getSession(sessionId);
            if (!session) {
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
     * Update session state and context
     */
    async updateSession(sessionId, updates = {}) {
        try {
            const allowedUpdates = [
                'patient_id', 'verification_status', 'conversation_state', 'context'
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
                throw new Error('No valid updates provided');
            }

            await this.db.updateSession(sessionId, filteredUpdates);
            this.logger.debug(`Updated session ${sessionId}:`, filteredUpdates);
            
            return await this.getSession(sessionId);
        } catch (error) {
            this.logger.error(`Failed to update session ${sessionId}:`, error);
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
                conversation_state: verified ? this.states.VERIFIED : this.states.ERROR
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
                throw new Error(`Invalid state: ${state}`);
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
        const session = await this.getSession(sessionId);
        return session && session.verification_status === 'verified';
    }

    /**
     * Check if session requires verification
     */
    requiresVerification(state) {
        const protectedStates = [
            this.states.APPOINTMENT_BOOKING,
            this.states.APPOINTMENT_DETAILS,
            this.states.CANCELLATION,
            this.states.RESCHEDULING
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
     * Update session activity timestamp
     */
    async updateSessionActivity(sessionId) {
        try {
            await this.db.updateSession(sessionId, {
                last_activity: new Date().toISOString()
            });
        } catch (error) {
            this.logger.error(`Failed to update activity for session ${sessionId}:`, error);
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
        
        // Parse context JSON
        if (session.context) {
            try {
                session.context = JSON.parse(session.context);
            } catch (error) {
                this.logger.warn(`Failed to parse context for session ${session.id}:`, error);
                session.context = {};
            }
        } else {
            session.context = {};
        }

        // Add computed properties
        session.isExpired = new Date(session.expires_at) <= new Date();
        session.isVerified = session.verification_status === 'verified';
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
        
        // Handle different country codes and formats
        if (digits.startsWith('61') && digits.length === 11) {
            // Australian format: +61xxxxxxxxx
            return `+${digits}`;
        } else if (digits.startsWith('0') && digits.length === 10) {
            // Australian domestic format: 0xxxxxxxxx -> +61xxxxxxxxx
            return `+61${digits.substring(1)}`;
        } else if (digits.length === 9) {
            // Australian without leading 0: xxxxxxxxx -> +61xxxxxxxxx
            return `+61${digits}`;
        } else if (digits.startsWith('1') && digits.length === 11) {
            // US/Canada format: +1xxxxxxxxxx
            return `+${digits}`;
        }
        
        // Default: assume it's already in international format or add +
        return digits.startsWith('+') ? digits : `+${digits}`;
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
        setInterval(async () => {
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
            [this.states.INITIAL]: [
                this.states.VERIFICATION_PENDING,
                this.states.VERIFIED,
                this.states.ERROR
            ],
            [this.states.VERIFICATION_PENDING]: [
                this.states.VERIFIED,
                this.states.ERROR,
                this.states.INITIAL
            ],
            [this.states.VERIFIED]: [
                this.states.APPOINTMENT_BOOKING,
                this.states.APPOINTMENT_DETAILS,
                this.states.CANCELLATION,
                this.states.RESCHEDULING,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.APPOINTMENT_BOOKING]: [
                this.states.APPOINTMENT_DETAILS,
                this.states.VERIFIED,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.APPOINTMENT_DETAILS]: [
                this.states.VERIFIED,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.CANCELLATION]: [
                this.states.VERIFIED,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.RESCHEDULING]: [
                this.states.APPOINTMENT_BOOKING,
                this.states.VERIFIED,
                this.states.COMPLETED,
                this.states.ERROR
            ],
            [this.states.ERROR]: [
                this.states.INITIAL,
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
            return await this.db.all(sql);
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

        this.logger.info('SessionManager closed');
    }
}

module.exports = SessionManager;
