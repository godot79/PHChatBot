// ClinikoAPI.js - Cliniko Healthcare System API Integration
const axios = require('axios');

class ClinikoAPI {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.subdomain = config.subdomain;
        this.baseURL = `https://api.${this.subdomain}.cliniko.com/v1`;
        this.userAgent = config.userAgent || 'WhatsApp-Healthcare-Bot/1.0';
        
        // Initialize axios instance
        this.client = axios.create({
            baseURL: this.baseURL,
            headers: {
                'User-Agent': this.userAgent,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            auth: {
                username: this.apiKey,
                password: '' // Cliniko uses API key as username, empty password
            },
            timeout: 30000
        });

        // Rate limiting tracking (Cliniko: 5000 requests per hour)
        this.rateLimitTracker = {
            requests: 0,
            resetTime: Date.now() + 3600000, // 1 hour
            maxRequests: 5000
        };
    }

    // Rate limiting check
    checkRateLimit() {
        const now = Date.now();
        if (now > this.rateLimitTracker.resetTime) {
            this.rateLimitTracker.requests = 0;
            this.rateLimitTracker.resetTime = now + 3600000;
        }

        if (this.rateLimitTracker.requests >= this.rateLimitTracker.maxRequests) {
            throw new Error('Cliniko API rate limit exceeded');
        }
        
        this.rateLimitTracker.requests++;
    }

    // Handle API response and rate limiting headers
    handleResponse(response) {
        if (response.headers['x-ratelimit-remaining']) {
            this.rateLimitTracker.requests = this.rateLimitTracker.maxRequests - 
                parseInt(response.headers['x-ratelimit-remaining']);
        }
        return response.data;
    }

    // PATIENT MANAGEMENT
    
    // Get all patients
    async getPatients(params = {}) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get('/patients', { params });
            console.log('Patients retrieved:', response.data.patients?.length || 0);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error getting patients:', error.response?.data || error.message);
            throw error;
        }
    }

    // Get patient by ID
    async getPatient(patientId) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get(`/patients/${patientId}`);
            console.log('Patient retrieved:', response.data.id);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error getting patient:', error.response?.data || error.message);
            throw error;
        }
    }

    // Search patients by phone number
    async findPatientByPhone(phoneNumber) {
        this.checkRateLimit();
        
        // Clean phone number (remove + and spaces)
        const cleanPhone = phoneNumber.replace(/[\+\s\-\(\)]/g, '');
        
        try {
            const response = await this.client.get('/patients', {
                params: {
                    q: cleanPhone,
                    per_page: 50
                }
            });
            
            const patients = response.data.patients || [];
            
            // Find exact match by phone number
            const matchedPatient = patients.find(patient => {
                const patientPhone = (patient.phone_number || '').replace(/[\+\s\-\(\)]/g, '');
                const patientMobile = (patient.mobile_phone_number || '').replace(/[\+\s\-\(\)]/g, '');
                return patientPhone.includes(cleanPhone) || patientMobile.includes(cleanPhone) ||
                       cleanPhone.includes(patientPhone) || cleanPhone.includes(patientMobile);
            });
            
            if (matchedPatient) {
                console.log('Patient found by phone:', matchedPatient.id);
                return matchedPatient;
            }
            
            console.log('No patient found with phone:', phoneNumber);
            return null;
        } catch (error) {
            console.error('Error finding patient by phone:', error.response?.data || error.message);
            throw error;
        }
    }

    // Create new patient
    async createPatient(patientData) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.post('/patients', patientData);
            console.log('Patient created:', response.data.id);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error creating patient:', error.response?.data || error.message);
            throw error;
        }
    }

    // Update patient
    async updatePatient(patientId, patientData) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.put(`/patients/${patientId}`, patientData);
            console.log('Patient updated:', response.data.id);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error updating patient:', error.response?.data || error.message);
            throw error;
        }
    }

    // APPOINTMENT MANAGEMENT

    // Get appointments
    async getAppointments(params = {}) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get('/appointments', { params });
            console.log('Appointments retrieved:', response.data.appointments?.length || 0);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error getting appointments:', error.response?.data || error.message);
            throw error;
        }
    }

    // Get patient appointments
    async getPatientAppointments(patientId, params = {}) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get('/appointments', {
                params: {
                    patient_id: patientId,
                    ...params
                }
            });
            console.log('Patient appointments retrieved:', response.data.appointments?.length || 0);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error getting patient appointments:', error.response?.data || error.message);
            throw error;
        }
    }

    // Get upcoming appointments for patient
    async getUpcomingAppointments(patientId, days = 30) {
        const today = new Date();
        const futureDate = new Date();
        futureDate.setDate(today.getDate() + days);

        return await this.getPatientAppointments(patientId, {
            starts_at_from: today.toISOString(),
            starts_at_to: futureDate.toISOString(),
            per_page: 50
        });
    }

    // Create appointment
    async createAppointment(appointmentData) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.post('/appointments', appointmentData);
            console.log('Appointment created:', response.data.id);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error creating appointment:', error.response?.data || error.message);
            throw error;
        }
    }

    // Update appointment
    async updateAppointment(appointmentId, appointmentData) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.put(`/appointments/${appointmentId}`, appointmentData);
            console.log('Appointment updated:', response.data.id);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error updating appointment:', error.response?.data || error.message);
            throw error;
        }
    }

    // Cancel appointment
    async cancelAppointment(appointmentId, reason = 'Cancelled by patient') {
        this.checkRateLimit();
        
        try {
            const response = await this.client.put(`/appointments/${appointmentId}`, {
                cancellation_reason: reason,
                cancelled_at: new Date().toISOString()
            });
            console.log('Appointment cancelled:', response.data.id);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error cancelling appointment:', error.response?.data || error.message);
            throw error;
        }
    }

    // PRACTITIONER MANAGEMENT

    // Get practitioners
    async getPractitioners(params = {}) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get('/practitioners', { params });
            console.log('Practitioners retrieved:', response.data.practitioners?.length || 0);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error getting practitioners:', error.response?.data || error.message);
            throw error;
        }
    }

    // Get practitioner by ID
    async getPractitioner(practitionerId) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get(`/practitioners/${practitionerId}`);
            console.log('Practitioner retrieved:', response.data.id);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error getting practitioner:', error.response?.data || error.message);
            throw error;
        }
    }

    // APPOINTMENT TYPE MANAGEMENT

    // Get appointment types
    async getAppointmentTypes(params = {}) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get('/appointment_types', { params });
            console.log('Appointment types retrieved:', response.data.appointment_types?.length || 0);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error getting appointment types:', error.response?.data || error.message);
            throw error;
        }
    }

    // AVAILABILITY MANAGEMENT

    // Get available times
    async getAvailableTimes(practitionerId, appointmentTypeId, params = {}) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get('/available_times', {
                params: {
                    practitioner_id: practitionerId,
                    appointment_type_id: appointmentTypeId,
                    ...params
                }
            });
            console.log('Available times retrieved:', response.data.available_times?.length || 0);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error getting available times:', error.response?.data || error.message);
            throw error;
        }
    }

    // Get next available appointments
    async getNextAvailableSlots(practitionerId, appointmentTypeId, days = 14, limit = 10) {
        const today = new Date();
        const futureDate = new Date();
        futureDate.setDate(today.getDate() + days);

        return await this.getAvailableTimes(practitionerId, appointmentTypeId, {
            from: today.toISOString().split('T')[0],
            to: futureDate.toISOString().split('T')[0],
            per_page: limit
        });
    }

    // BUSINESS MANAGEMENT

    // Get businesses
    async getBusinesses(params = {}) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get('/businesses', { params });
            console.log('Businesses retrieved:', response.data.businesses?.length || 0);
            return this.handleResponse(response);
        } catch (error) {
            console.error('Error getting businesses:', error.response?.data || error.message);
            throw error;
        }
    }

    // HEALTHCARE-SPECIFIC UTILITIES

    // Format appointment for WhatsApp
    formatAppointmentForWhatsApp(appointment) {
        const startTime = new Date(appointment.starts_at);
        const endTime = new Date(appointment.ends_at);
        
        return {
            id: appointment.id,
            dateTime: startTime.toLocaleString(),
            date: startTime.toLocaleDateString(),
            time: startTime.toLocaleTimeString(),
            duration: `${(endTime - startTime) / (1000 * 60)} minutes`,
            practitioner: appointment.practitioner?.name || 'Unknown',
            appointmentType: appointment.appointment_type?.name || 'Appointment',
            status: appointment.cancelled_at ? 'Cancelled' : 'Scheduled',
            notes: appointment.notes || ''
        };
    }

    // Check if appointment is in next 24 hours
    isAppointmentSoon(appointment, hours = 24) {
        const appointmentTime = new Date(appointment.starts_at);
        const now = new Date();
        const hoursFromNow = new Date(now.getTime() + (hours * 60 * 60 * 1000));
        
        return appointmentTime >= now && appointmentTime <= hoursFromNow;
    }

    // Get patient's next appointment
    async getPatientNextAppointment(patientId) {
        try {
            const appointments = await this.getPatientAppointments(patientId, {
                starts_at_from: new Date().toISOString(),
                per_page: 1,
                sort: 'starts_at'
            });
            
            return appointments.appointments?.[0] || null;
        } catch (error) {
            console.error('Error getting patient next appointment:', error.message);
            return null;
        }
    }

    // Create quick appointment booking
    async bookAppointment(patientId, practitionerId, appointmentTypeId, startTime, notes = '') {
        const appointmentData = {
            patient_id: patientId,
            practitioner_id: practitionerId,
            appointment_type_id: appointmentTypeId,
            starts_at: startTime,
            notes: notes,
            booking_ip_address: '127.0.0.1' // Required by Cliniko
        };

        return await this.createAppointment(appointmentData);
    }

    // Send appointment reminder data
    async getAppointmentReminderData(appointmentId) {
        this.checkRateLimit();
        
        try {
            const response = await this.client.get(`/appointments/${appointmentId}`, {
                params: {
                    include: 'patient,practitioner,appointment_type,business'
                }
            });
            
            const appointment = response.data;
            
            return {
                patient: appointment.patient,
                practitioner: appointment.practitioner,
                appointmentType: appointment.appointment_type,
                business: appointment.business,
                appointment: appointment,
                formatted: this.formatAppointmentForWhatsApp(appointment)
            };
        } catch (error) {
            console.error('Error getting appointment reminder data:', error.response?.data || error.message);
            throw error;
        }
    }

    // Get rate limit stats
    getRateLimitStats() {
        return {
            requestsUsed: this.rateLimitTracker.requests,
            maxRequests: this.rateLimitTracker.maxRequests,
            resetTime: this.rateLimitTracker.resetTime,
            remaining: this.rateLimitTracker.maxRequests - this.rateLimitTracker.requests
        };
    }

    // Validate patient data
    validatePatientData(patientData) {
        const required = ['first_name', 'last_name'];
        const missing = required.filter(field => !patientData[field]);
        
        if (missing.length > 0) {
            throw new Error(`Missing required patient fields: ${missing.join(', ')}`);
        }

        // Validate phone number format
        if (patientData.phone_number || patientData.mobile_phone_number) {
            const phoneRegex = /^[\+]?[1-9][\d\s\-\(\)]{7,15}$/;
            const phone = patientData.phone_number || patientData.mobile_phone_number;
            if (!phoneRegex.test(phone)) {
                throw new Error('Invalid phone number format');
            }
        }

        return true;
    }

    // Validate appointment data
    validateAppointmentData(appointmentData) {
        const required = ['patient_id', 'practitioner_id', 'appointment_type_id', 'starts_at'];
        const missing = required.filter(field => !appointmentData[field]);
        
        if (missing.length > 0) {
            throw new Error(`Missing required appointment fields: ${missing.join(', ')}`);
        }

        // Validate date format
        if (appointmentData.starts_at) {
            const date = new Date(appointmentData.starts_at);
            if (isNaN(date.getTime())) {
                throw new Error('Invalid appointment start time format');
            }
            
            // Check if appointment is in the past
            if (date < new Date()) {
                throw new Error('Appointment cannot be scheduled in the past');
            }
        }

        return true;
    }
}

module.exports = ClinikoAPI;
