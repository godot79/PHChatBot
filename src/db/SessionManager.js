const crypto = require('crypto');

class SessionManager {
    constructor(databaseManager, clinikoAPI) {
        this.db = databaseManager;
        this.clinikoAPI = clinikoAPI;
        this.maxVerificationAttempts = 3;
        this.sessionDuration = 60; // minutes
        this.verificationCooldown = 5; // minutes
    }

    /**
     * Generate a unique session ID
     */
    generateSessionId() {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * Create or get existing session for a phone number
     */
    async getOrCreateSession(phoneNumber) {
        try {
            // Clean phone number (remove non-numeric characters except +)
            const cleanPhone = this.cleanPhoneNumber(phoneNumber);
            
            // Try to get existing active session
            let session = await this.db.getSession(cleanPhone);
            
            if (!session) {
                // Create new session
                const sessionId = this.generateSessionId();
                await this.db.createSession(cleanPhone, sessionId, this.sessionDuration);
                session = await this.db.getSession(cleanPhone);
                
                // Initialize context
                await this.updateSessionContext(cleanPhone, {
                    step: 'greeting',
                    lastActivity: new Date().toISOString(),
                    conversationStarted: new Date().toISOString()
                });
                
                session = await this.db.getSession(cleanPhone);
            } else {
                // Update last activity
                await this.updateSessionContext(cleanPhone, {
                    ...session.context,
                    lastActivity: new Date().toISOString()
                });
            }

            return session;
        } catch (error) {
            console.error('Error in getOrCreateSession:', error);
            throw new Error('Failed to manage session');
        }
    }

    /**
     * Clean and normalize phone number
     */
    cleanPhoneNumber(phoneNumber) {
        // Remove all non-numeric characters except +
        let cleaned = phoneNumber.replace(/[^\d+]/g, '');
        
        // If no + at start and number doesn't start with country code, add default
        if (!cleaned.startsWith('+')) {
            // Assume Australian number if no country code
            if (cleaned.startsWith('0')) {
                cleaned = '+61' + cleaned.substring(1);
            } else if (cleaned.length === 9) {
                cleaned = '+61' + cleaned;
            } else {
                cleaned = '+' + cleaned;
            }
        }
        
        return cleaned;
    }

    /**
     * Attempt to verify user with patient data
     */
    async attemptVerification(phoneNumber, verificationData) {
        try {
            const session = await this.db.getSession(phoneNumber);
            if (!session) {
                throw new Error('No active session found');
            }

            // Check if already verified
            if (session.is_verified) {
                return {
                    success: true,
                    message: 'Already verified',
                    patient: await this.db.getPatientById(session.patient_id)
                };
            }

            // Check verification attempts
            if (session.verification_attempts >= this.maxVerificationAttempts) {
                return {
                    success: false,
                    message: 'Maximum verification attempts exceeded. Please contact the clinic.',
                    lockout: true
                };
            }

            // Increment verification attempts
            await this.db.updateSession(phoneNumber, {
                verification_attempts: session.verification_attempts + 1
            });

            // Search for patient in Cliniko
            const searchResults = await this.searchPatientInCliniko(verificationData);
            
            if (searchResults.length === 0) {
                return {
                    success: false,
                    message: 'No matching patient found. Please check your details.',
                    remainingAttempts: this.maxVerificationAttempts - (session.verification_attempts + 1)
                };
            }

            // If multiple matches, try to find exact match
            let matchedPatient = null;
            if (searchResults.length === 1) {
                matchedPatient = searchResults[0];
            } else {
                // Try to find exact match based on phone number
                matchedPatient = searchResults.find(patient => 
                    this.cleanPhoneNumber(patient.phone_number) === phoneNumber
                );
                
                if (!matchedPatient) {
                    // Use first result if no exact phone match
                    matchedPatient = searchResults[0];
                }
            }

            // Verify patient details
            const verificationScore = this.calculateVerificationScore(matchedPatient, verificationData);
            
            if (verificationScore >= 0.8) {
                // Verification successful
                await this.completeVerification(phoneNumber, matchedPatient);
                
                return {
                    success: true,
                    message: 'Verification successful!',
                    patient: matchedPatient
                };
            } else {
                return {
                    success: false,
                    message: 'Patient details do not match our records. Please try again.',
                    remainingAttempts: this.maxVerificationAttempts - (session.verification_attempts + 1)
                };
            }

        } catch (error) {
            console.error('Error in attemptVerification:', error);
            return {
                success: false,
                message: 'Verification error. Please try again later.',
                error: error.message
            };
        }
    }

    /**
     * Search for patient in Cliniko API
     */
    async searchPatientInCliniko(verificationData) {
        const searchQueries = [];
        
        // Search by email if provided
        if (verificationData.email) {
            searchQueries.push({ email: verificationData.email });
        }
        
        // Search by name and DOB if provided
        if (verificationData.firstName && verificationData.lastName) {
            searchQueries.push({
                first_name: verificationData.firstName,
                last_name: verificationData.lastName
            });
        }
        
        // Search by phone number
        if (verificationData.phoneNumber) {
            searchQueries.push({ phone_number: verificationData.phoneNumber });
        }

        const allResults = [];
        
        for (const query of searchQueries) {
            try {
                const results = await this.clinikoAPI.getPatients(query);
                if (results && results.patients) {
                    allResults.push(...results.patients);
                }
            } catch (error) {
                console.error('Search query failed:', query, error);
            }
        }

        // Remove duplicates based on patient ID
        const uniqueResults = allResults.filter((patient, index, self) =>
            index === self.findIndex(p => p.id === patient.id)
        );

        return uniqueResults;
    }

    /**
     * Calculate verification score based on matching patient data
     */
    calculateVerificationScore(patient, verificationData) {
        let score = 0;
        let totalChecks = 0;

        // Phone number match (high weight)
        if (verificationData.phoneNumber && patient.phone_number) {
            totalChecks += 3;
            const cleanPatientPhone = this.cleanPhoneNumber(patient.phone_number);
            const cleanVerificationPhone = this.cleanPhoneNumber(verificationData.phoneNumber);
            if (cleanPatientPhone === cleanVerificationPhone) {
                score += 3;
            }
        }

        // Email match (high weight)
        if (verificationData.email && patient.email) {
            totalChecks += 2;
            if (patient.email.toLowerCase() === verificationData.email.toLowerCase()) {
                score += 2;
            }
        }

        // First name match
        if (verificationData.firstName && patient.first_name) {
            totalChecks += 1;
            if (patient.first_name.toLowerCase() === verificationData.firstName.toLowerCase()) {
                score += 1;
            }
        }

        // Last name match
        if (verificationData.lastName && patient.last_name) {
            totalChecks += 1;
            if (patient.last_name.toLowerCase() === verificationData.lastName.toLowerCase()) {
                score += 1;
            }
        }

        // Date of birth match (high weight)
        if (verificationData.dateOfBirth && patient.date_of_birth) {
            totalChecks += 2;
            if (patient.date_of_birth === verificationData.dateOfBirth) {
                score += 2;
            }
        }

        return totalChecks > 0 ? score / totalChecks : 0;
    }

    /**
     * Complete verification process
     */
    async completeVerification(phoneNumber, patient) {
        // Cache patient data locally
        await this.db.cachePatient({
            cliniko_id: patient.id,
            phone_number: phoneNumber,
            email: patient.email,
            first_name: patient.first_name,
            last_name: patient.last_name,
            date_of_birth: patient.date_of_birth
        });

        // Update session as verified
        await this.db.updateSession(phoneNumber, {
            is_verified: true,
            patient_id: patient.id,
            verification_attempts: 0 // Reset attempts on success
        });

        // Update session context
        await this.updateSessionContext(phoneNumber, {
            step: 'verified',
            patientName: `${patient.first_name} ${patient.last_name}`,
            verifiedAt: new Date().toISOString()
        });
    }

    /**
     * Check if user is verified
     */
    async isVerified(phoneNumber) {
        const session = await this.db.getSession(phoneNumber);
        return session && session.is_verified;
    }

    /**
     * Get verified patient data
     */
    async getVerifiedPatient(phoneNumber) {
        const session = await this.db.getSession(phoneNumber);
        if (!session || !session.is_verified || !session.patient_id) {
            return null;
        }

        // Try to get from cache first
        let patient = await this.db.getPatientById(session.patient_id);
        
        if (!patient) {
            // Fetch from Cliniko API if not in cache
            try {
                const apiPatient = await this.clinikoAPI.getPatient(session.patient_id);
                if (apiPatient) {
                    await this.db.cachePatient({
                        cliniko_id: apiPatient.id,
                        phone_number: phoneNumber,
                        email: apiPatient.email,
                        first_name: apiPatient.first_name,
                        last_name: apiPatient.last_name,
                        date_of_birth: apiPatient.date_of_birth
                    });
                    patient = apiPatient;
                }
            } catch (error) {
                console.error('Error fetching patient from API:', error);
            }
        }

        return patient;
    }

    /**
     * Update session context (conversation state)
     */
    async updateSessionContext(phoneNumber, contextUpdates) {
        const session = await this.db.getSession(phoneNumber);
        if (!session) {
            throw new Error('Session not found');
        }

        const currentContext = session.context || {};
        const newContext = { ...currentContext, ...contextUpdates };

        await this.db.updateSession(phoneNumber, { context: newContext });
        return newContext;
    }

    /**
     * Get session context
     */
    async getSessionContext(phoneNumber) {
        const session = await this.db.getSession(phoneNumber);
        return session ? (session.context || {}) : {};
    }

    /**
     * Reset verification status (for testing or admin use)
     */
    async resetVerification(phoneNumber) {
        await this.db.updateSession(phoneNumber, {
            is_verified: false,
            patient_id: null,
            verification_attempts: 0
        });

        await this.updateSessionContext(phoneNumber, {
            step: 'greeting',
            verifiedAt: null,
            patientName: null
        });
    }

    /**
     * Extend session expiry
     */
    async extendSession(phoneNumber, additionalMinutes = null) {
        const minutes = additionalMinutes || this.sessionDuration;
        const newExpiry = new Date(Date.now() + (minutes * 60 * 1000));
        
        await this.db.updateSession(phoneNumber, {
            expires_at: newExpiry.toISOString()
        });
        
        return newExpiry;
    }

    /**
     * End session
     */
    async endSession(phoneNumber) {
        await this.db.deleteSession(phoneNumber);
    }

    /**
     * Get session info for debugging/admin
     */
    async getSessionInfo(phoneNumber) {
        const session = await this.db.getSession(phoneNumber);
        if (!session) {
            return null;
        }

        return {
            sessionId: session.session_id,
            phoneNumber: session.phone_number,
            isVerified: session.is_verified,
            verificationAttempts: session.verification_attempts,
            patientId: session.patient_id,
            createdAt: session.created_at,
            updatedAt: session.updated_at,
            expiresAt: session.expires_at,
            context: session.context
        };
    }

    /**
     * Cleanup expired sessions (should be called periodically)
     */
    async cleanupExpiredSessions() {
        return await this.db.cleanupExpiredSessions();
    }

    /**
     * Validate session state before operations
     */
    async validateSession(phoneNumber) {
        const session = await this.db.getSession(phoneNumber);
        
        if (!session) {
            return { valid: false, reason: 'No session found' };
        }

        if (session.expires_at && new Date(session.expires_at) < new Date()) {
            await this.db.deleteSession(phoneNumber);
            return { valid: false, reason: 'Session expired' };
        }

        return { valid: true, session };
    }
}

module.exports = SessionManager;
