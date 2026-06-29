/**
 * ValidationMiddleware.js
 * Comprehensive validation layer for WhatsApp Healthcare Chatbot
 * Handles request validation, data validation, business rule validation
 */

const validator = require('validator');
const Logger = require('../core/Logger');

class ValidationMiddleware {
    constructor(config = {}) {
        this.logger = new Logger('ValidationMiddleware');
        this.config = {
            maxMessageLength: config.maxMessageLength || 4096,
            maxSessionDuration: config.maxSessionDuration || 24 * 60 * 60 * 1000, // 24 hours
            allowedPhoneNumberFormats: config.allowedPhoneNumberFormats || ['E164'],
            minAppointmentNotice: config.minAppointmentNotice || 2 * 60 * 60 * 1000, // 2 hours
            maxAppointmentAdvance: config.maxAppointmentAdvance || 90 * 24 * 60 * 60 * 1000, // 90 days
            businessHours: config.businessHours || {
                start: '08:00',
                end: '18:00',
                timezone: 'Australia/Sydney'
            },
            ...config
        };

        // Initialize validation schemas
        this.initializeSchemas();
    }

    /**
     * Initialize validation schemas for different request types
     */
    initializeSchemas() {
        this.schemas = {
            webhook: {
                required: ['object', 'entry'],
                object: { type: 'string', allowed: ['whatsapp_business_account'] },
                entry: { type: 'array', minLength: 1 }
            },
            
            whatsappMessage: {
                required: ['from', 'text'],
                from: { type: 'string', format: 'phone' },
                text: { type: 'object', required: ['body'] },
                timestamp: { type: 'string', format: 'timestamp' }
            },

            appointmentBooking: {
                required: ['patientEmail', 'practitionerId', 'appointmentDate', 'appointmentTime'],
                patientEmail: { type: 'string', format: 'email' },
                practitionerId: { type: 'string', format: 'uuid' },
                appointmentDate: { type: 'string', format: 'date' },
                appointmentTime: { type: 'string', format: 'time' },
                notes: { type: 'string', maxLength: 500, optional: true }
            },

            patientVerification: {
                required: ['email', 'dateOfBirth'],
                email: { type: 'string', format: 'email' },
                dateOfBirth: { type: 'string', format: 'date' },
                phoneNumber: { type: 'string', format: 'phone', optional: true }
            },

            sessionUpdate: {
                required: ['sessionId', 'phoneNumber'],
                sessionId: { type: 'string', format: 'uuid' },
                phoneNumber: { type: 'string', format: 'phone' },
                lastActivity: { type: 'string', format: 'timestamp', optional: true }
            },

            adminQuery: {
                limit: { type: 'number', min: 1, max: 100, optional: true },
                offset: { type: 'number', min: 0, optional: true },
                startDate: { type: 'string', format: 'date', optional: true },
                endDate: { type: 'string', format: 'date', optional: true }
            }
        };
    }

    /**
     * Validate webhook payload from WhatsApp
     */
    validateWebhookPayload(req, res, next) {
        try {
            const body = req.body;

            // Basic structure validation
            if (!this.validateSchema(body, this.schemas.webhook)) {
                this.logger.warn('Invalid webhook payload structure', { body });
                return res.status(400).json({
                    error: 'Invalid webhook payload',
                    code: 'INVALID_WEBHOOK_PAYLOAD'
                });
            }

            // Validate specific WhatsApp Business Account format
            if (body.object !== 'whatsapp_business_account') {
                this.logger.warn('Invalid webhook object type', { object: body.object });
                return res.status(400).json({
                    error: 'Invalid webhook object type',
                    code: 'INVALID_OBJECT_TYPE'
                });
            }

            // Validate entry array and extract messages
            const messages = [];
            for (const entry of body.entry) {
                if (entry.changes) {
                    for (const change of entry.changes) {
                        if (change.field === 'messages' && change.value && change.value.messages) {
                            messages.push(...change.value.messages);
                        }
                    }
                }
            }

            // Validate individual messages
            for (const message of messages) {
                if (!this.validateWhatsAppMessage(message)) {
                    this.logger.warn('Invalid WhatsApp message format', { message });
                    return res.status(400).json({
                        error: 'Invalid message format',
                        code: 'INVALID_MESSAGE_FORMAT'
                    });
                }
            }

            // Add validated messages to request for easy access
            req.validatedMessages = messages;
            next();

        } catch (error) {
            this.logger.error('Webhook validation failed', error);
            res.status(400).json({
                error: 'Webhook validation failed',
                code: 'WEBHOOK_VALIDATION_ERROR'
            });
        }
    }

    /**
     * Validate WhatsApp message format
     */
    validateWhatsAppMessage(message) {
        // Check required fields
        if (!message.from || !message.type) {
            return false;
        }

        // Validate phone number format
        if (!this.isValidPhoneNumber(message.from)) {
            return false;
        }

        // Validate message type and content
        switch (message.type) {
            case 'text':
                return message.text && message.text.body && 
                       message.text.body.length <= this.config.maxMessageLength;
            
            case 'interactive':
                return message.interactive && 
                       (message.interactive.button_reply || message.interactive.list_reply);
            
            case 'button':
                return message.button && message.button.payload;
            
            default:
                // Allow other message types but log them
                this.logger.info('Received unsupported message type', { 
                    type: message.type, 
                    from: message.from 
                });
                return true;
        }
    }

    /**
     * Validate appointment booking request
     */
    validateAppointmentBooking(req, res, next) {
        try {
            const data = req.body;

            if (!this.validateSchema(data, this.schemas.appointmentBooking)) {
                return res.status(400).json({
                    error: 'Invalid appointment booking data',
                    code: 'INVALID_BOOKING_DATA'
                });
            }

            // Additional business rule validations
            if (!this.validateAppointmentTiming(data.appointmentDate, data.appointmentTime)) {
                return res.status(400).json({
                    error: 'Invalid appointment timing',
                    code: 'INVALID_APPOINTMENT_TIMING'
                });
            }

            if (!this.validateBusinessHours(data.appointmentTime)) {
                return res.status(400).json({
                    error: 'Appointment outside business hours',
                    code: 'OUTSIDE_BUSINESS_HOURS'
                });
            }

            next();

        } catch (error) {
            this.logger.error('Appointment booking validation failed', error);
            res.status(400).json({
                error: 'Booking validation failed',
                code: 'BOOKING_VALIDATION_ERROR'
            });
        }
    }

    /**
     * Validate patient verification data
     */
    validatePatientVerification(req, res, next) {
        try {
            const data = req.body;

            if (!this.validateSchema(data, this.schemas.patientVerification)) {
                return res.status(400).json({
                    error: 'Invalid patient verification data',
                    code: 'INVALID_VERIFICATION_DATA'
                });
            }

            // Additional validation for date of birth
            const dob = new Date(data.dateOfBirth);
            const now = new Date();
            const age = (now - dob) / (365.25 * 24 * 60 * 60 * 1000);

            if (age < 0 || age > 150) {
                return res.status(400).json({
                    error: 'Invalid date of birth',
                    code: 'INVALID_DATE_OF_BIRTH'
                });
            }

            next();

        } catch (error) {
            this.logger.error('Patient verification validation failed', error);
            res.status(400).json({
                error: 'Verification validation failed',
                code: 'VERIFICATION_VALIDATION_ERROR'
            });
        }
    }

    /**
     * Validate session data
     */
    validateSession(req, res, next) {
        try {
            const sessionId = req.params.sessionId || req.body.sessionId;
            const phoneNumber = req.params.phoneNumber || req.body.phoneNumber;

            if (!sessionId || !this.isValidUUID(sessionId)) {
                return res.status(400).json({
                    error: 'Invalid session ID',
                    code: 'INVALID_SESSION_ID'
                });
            }

            if (!phoneNumber || !this.isValidPhoneNumber(phoneNumber)) {
                return res.status(400).json({
                    error: 'Invalid phone number',
                    code: 'INVALID_PHONE_NUMBER'
                });
            }

            // Add validated data to request
            req.validatedSession = { sessionId, phoneNumber };
            next();

        } catch (error) {
            this.logger.error('Session validation failed', error);
            res.status(400).json({
                error: 'Session validation failed',
                code: 'SESSION_VALIDATION_ERROR'
            });
        }
    }

    /**
     * Validate admin query parameters
     */
    validateAdminQuery(req, res, next) {
        try {
            const query = req.query;

            if (!this.validateSchema(query, this.schemas.adminQuery)) {
                return res.status(400).json({
                    error: 'Invalid query parameters',
                    code: 'INVALID_QUERY_PARAMS'
                });
            }

            // Validate date range if provided
            if (query.startDate && query.endDate) {
                const start = new Date(query.startDate);
                const end = new Date(query.endDate);

                if (start >= end) {
                    return res.status(400).json({
                        error: 'Start date must be before end date',
                        code: 'INVALID_DATE_RANGE'
                    });
                }

                // Limit query range to prevent performance issues
                const daysDiff = (end - start) / (24 * 60 * 60 * 1000);
                if (daysDiff > 365) {
                    return res.status(400).json({
                        error: 'Query range too large (max 365 days)',
                        code: 'QUERY_RANGE_TOO_LARGE'
                    });
                }
            }

            next();

        } catch (error) {
            this.logger.error('Admin query validation failed', error);
            res.status(400).json({
                error: 'Query validation failed',
                code: 'QUERY_VALIDATION_ERROR'
            });
        }
    }

    /**
     * Generic schema validation
     */
    validateSchema(data, schema) {
        try {
            // Check required fields
            for (const field of schema.required || []) {
                if (!(field in data)) {
                    this.logger.warn(`Missing required field: ${field}`);
                    return false;
                }
            }

            // Validate each field
            for (const [field, rules] of Object.entries(schema)) {
                if (field === 'required') continue;

                const value = data[field];

                // Skip optional fields that are not present
                if (rules.optional && !(field in data)) {
                    continue;
                }

                if (!this.validateField(value, rules, field)) {
                    return false;
                }
            }

            return true;

        } catch (error) {
            this.logger.error('Schema validation error', error);
            return false;
        }
    }

    /**
     * Validate individual field
     */
    validateField(value, rules, fieldName) {
        // Type validation
        if (rules.type) {
            if (!this.validateType(value, rules.type)) {
                this.logger.warn(`Invalid type for field ${fieldName}`, { 
                    value, 
                    expectedType: rules.type 
                });
                return false;
            }
        }

        // Format validation
        if (rules.format) {
            if (!this.validateFormat(value, rules.format)) {
                this.logger.warn(`Invalid format for field ${fieldName}`, { 
                    value, 
                    expectedFormat: rules.format 
                });
                return false;
            }
        }

        // Length validations
        if (rules.minLength && value.length < rules.minLength) {
            return false;
        }
        if (rules.maxLength && value.length > rules.maxLength) {
            return false;
        }

        // Numeric validations
        if (rules.min && value < rules.min) {
            return false;
        }
        if (rules.max && value > rules.max) {
            return false;
        }

        // Allowed values
        if (rules.allowed && !rules.allowed.includes(value)) {
            return false;
        }

        return true;
    }

    /**
     * Validate data type
     */
    validateType(value, type) {
        switch (type) {
            case 'string':
                return typeof value === 'string';
            case 'number':
                return typeof value === 'number' && !isNaN(value);
            case 'boolean':
                return typeof value === 'boolean';
            case 'array':
                return Array.isArray(value);
            case 'object':
                return typeof value === 'object' && value !== null && !Array.isArray(value);
            default:
                return true;
        }
    }

    /**
     * Validate data format
     */
    validateFormat(value, format) {
        if (typeof value !== 'string') return false;

        switch (format) {
            case 'email':
                return validator.isEmail(value);
            case 'phone':
                return this.isValidPhoneNumber(value);
            case 'uuid':
                return this.isValidUUID(value);
            case 'date':
                return validator.isDate(value);
            case 'time':
                return this.isValidTime(value);
            case 'timestamp':
                return validator.isISO8601(value);
            default:
                return true;
        }
    }

    /**
     * Validate phone number format
     */
    isValidPhoneNumber(phone) {
        // Remove spaces and special characters
        const cleaned = phone.replace(/[\s\-\(\)]/g, '');
        
        // Check E164 format (starts with + and has 7-15 digits)
        return validator.isMobilePhone(phone, 'any', { strictMode: false }) ||
               /^\+[1-9]\d{6,14}$/.test(cleaned);
    }

    /**
     * Validate UUID format
     */
    isValidUUID(uuid) {
        return validator.isUUID(uuid, 4);
    }

    /**
     * Validate time format (HH:MM)
     */
    isValidTime(time) {
        return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time);
    }

    /**
     * Validate appointment timing (not in the past, within booking window)
     */
    validateAppointmentTiming(date, time) {
        try {
            const appointmentDateTime = new Date(`${date}T${time}`);
            const now = new Date();

            // Check if appointment is in the past
            if (appointmentDateTime <= now) {
                this.logger.warn('Appointment time is in the past', { 
                    appointmentDateTime: appointmentDateTime.toISOString() 
                });
                return false;
            }

            // Check minimum notice period
            const timeDiff = appointmentDateTime - now;
            if (timeDiff < this.config.minAppointmentNotice) {
                this.logger.warn('Appointment notice period too short', { 
                    timeDiff, 
                    minNotice: this.config.minAppointmentNotice 
                });
                return false;
            }

            // Check maximum advance booking
            if (timeDiff > this.config.maxAppointmentAdvance) {
                this.logger.warn('Appointment too far in advance', { 
                    timeDiff, 
                    maxAdvance: this.config.maxAppointmentAdvance 
                });
                return false;
            }

            return true;

        } catch (error) {
            this.logger.error('Appointment timing validation error', error);
            return false;
        }
    }

    /**
     * Validate appointment is within business hours
     */
    validateBusinessHours(time) {
        try {
            const [hours, minutes] = time.split(':').map(Number);
            const appointmentMinutes = hours * 60 + minutes;

            const [startHours, startMins] = this.config.businessHours.start.split(':').map(Number);
            const startMinutes = startHours * 60 + startMins;

            const [endHours, endMins] = this.config.businessHours.end.split(':').map(Number);
            const endMinutes = endHours * 60 + endMins;

            if (appointmentMinutes < startMinutes || appointmentMinutes >= endMinutes) {
                this.logger.warn('Appointment outside business hours', { 
                    time, 
                    businessHours: this.config.businessHours 
                });
                return false;
            }

            return true;

        } catch (error) {
            this.logger.error('Business hours validation error', error);
            return false;
        }
    }

    /**
     * Validate message content for inappropriate content
     */
    validateMessageContent(content) {
        if (!content || typeof content !== 'string') {
            return false;
        }

        // Check length
        if (content.length > this.config.maxMessageLength) {
            this.logger.warn('Message too long', { length: content.length });
            return false;
        }

        // Basic content filtering (expand as needed)
        const prohibitedPatterns = [
            /\b(spam|scam|fraud)\b/i,
            /\b(viagra|cialis|pharmacy)\b/i,
            /\b(bitcoin|crypto|investment)\b/i,
            /<script/i,
            /javascript:/i
        ];

        for (const pattern of prohibitedPatterns) {
            if (pattern.test(content)) {
                this.logger.warn('Prohibited content detected', { 
                    content: content.substring(0, 100) + '...' 
                });
                return false;
            }
        }

        return true;
    }

    /**
     * Validate session timeout
     */
    validateSessionTimeout(lastActivity) {
        if (!lastActivity) return false;

        const lastActivityTime = new Date(lastActivity);
        const now = new Date();
        const timeDiff = now - lastActivityTime;

        if (timeDiff > this.config.maxSessionDuration) {
            this.logger.info('Session timeout exceeded', { 
                lastActivity: lastActivityTime.toISOString(),
                timeDiff 
            });
            return false;
        }

        return true;
    }

    /**
     * Validate practitioner availability
     */
    async validatePractitionerAvailability(practitionerId, date, time) {
        // This would typically check against a database or external API
        // For now, implement basic validation
        try {
            if (!this.isValidUUID(practitionerId)) {
                return false;
            }

            // Check if it's a weekend (basic check)
            const appointmentDate = new Date(date);
            const dayOfWeek = appointmentDate.getDay();
            
            if (dayOfWeek === 0 || dayOfWeek === 6) { // Sunday or Saturday
                this.logger.warn('Appointment requested on weekend', { date, dayOfWeek });
                return false;
            }

            return true;

        } catch (error) {
            this.logger.error('Practitioner availability validation error', error);
            return false;
        }
    }

    /**
     * Validate file upload (if supporting file uploads)
     */
    validateFileUpload(file) {
        if (!file) return false;

        // Check file size (10MB limit)
        if (file.size > 10 * 1024 * 1024) {
            this.logger.warn('File too large', { size: file.size });
            return false;
        }

        // Check file type
        const allowedTypes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'application/pdf',
            'text/plain'
        ];

        if (!allowedTypes.includes(file.mimetype)) {
            this.logger.warn('Invalid file type', { mimetype: file.mimetype });
            return false;
        }

        // Check filename
        if (!/^[a-zA-Z0-9._-]+$/.test(file.originalname)) {
            this.logger.warn('Invalid filename', { filename: file.originalname });
            return false;
        }

        return true;
    }

    /**
     * Create validation error response
     */
    createValidationError(field, message, code) {
        return {
            error: `Validation failed for field: ${field}`,
            message,
            code,
            field,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Middleware to validate request parameters
     */
    validateParams(schema) {
        return (req, res, next) => {
            try {
                if (!this.validateSchema(req.params, schema)) {
                    return res.status(400).json({
                        error: 'Invalid request parameters',
                        code: 'INVALID_PARAMS'
                    });
                }
                next();
            } catch (error) {
                this.logger.error('Parameter validation failed', error);
                res.status(400).json({
                    error: 'Parameter validation failed',
                    code: 'PARAM_VALIDATION_ERROR'
                });
            }
        };
    }

    /**
     * Middleware to validate request body
     */
    validateBody(schema) {
        return (req, res, next) => {
            try {
                if (!this.validateSchema(req.body, schema)) {
                    return res.status(400).json({
                        error: 'Invalid request body',
                        code: 'INVALID_BODY'
                    });
                }
                next();
            } catch (error) {
                this.logger.error('Body validation failed', error);
                res.status(400).json({
                    error: 'Body validation failed',
                    code: 'BODY_VALIDATION_ERROR'
                });
            }
        };
    }

    /**
     * Middleware to validate query parameters
     */
    validateQuery(schema) {
        return (req, res, next) => {
            try {
                if (!this.validateSchema(req.query, schema)) {
                    return res.status(400).json({
                        error: 'Invalid query parameters',
                        code: 'INVALID_QUERY'
                    });
                }
                next();
            } catch (error) {
                this.logger.error('Query validation failed', error);
                res.status(400).json({
                    error: 'Query validation failed',
                    code: 'QUERY_VALIDATION_ERROR'
                });
            }
        };
    }

    /**
     * Get validation summary for debugging
     */
    getValidationSummary() {
        return {
            schemas: Object.keys(this.schemas),
            config: {
                maxMessageLength: this.config.maxMessageLength,
                maxSessionDuration: this.config.maxSessionDuration,
                businessHours: this.config.businessHours,
                minAppointmentNotice: this.config.minAppointmentNotice,
                maxAppointmentAdvance: this.config.maxAppointmentAdvance
            },
            supportedFormats: [
                'email', 'phone', 'uuid', 'date', 'time', 'timestamp'
            ]
        };
    }
}

module.exports = ValidationMiddleware ;
