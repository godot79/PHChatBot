// src/api/ClinikoAPI.js
const axios = require('axios');
const Logger = require('../utils/Logger');

class ClinikoAPI {
  constructor(apiKey, subdomain) {
    this.apiKey = apiKey;
    this.subdomain = subdomain;
    this.baseURL = `https://${subdomain}.cliniko.com/api/v1`;
    this.logger = new Logger('ClinikoAPI');

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'WhatsApp-Physio-Chatbot/2.0.0'
      },
      timeout: 30000
    });

    // Add request/response interceptors for logging
    this.client.interceptors.request.use(
      (config) => {
        this.logger.debug('Cliniko API Request:', {
          method: config.method,
          url: config.url,
          params: config.params
        });
        return config;
      },
      (error) => {
        this.logger.error('Cliniko API Request Error:', error);
        return Promise.reject(error);
      }
    );

    this.client.interceptors.response.use(
      (response) => {
        this.logger.debug('Cliniko API Response:', {
          status: response.status,
          url: response.config.url,
          dataCount: Array.isArray(response.data) ? response.data.length : 'single'
        });
        return response;
      },
      (error) => {
        this.logger.error('Cliniko API Response Error:', {
          status: error.response?.status,
          url: error.config?.url,
          message: error.message,
          data: error.response?.data
        });
        return Promise.reject(error);
      }
    );
  }

  // Patient methods
  async searchPatients(searchTerm) {
    try {
      const response = await this.client.get('/patients', {
        params: {
          q: searchTerm,
          per_page: 50
        }
      });

      return response.data.patients || [];
    } catch (error) {
      this.logger.error('Failed to search patients:', error);
      throw new Error('Failed to search patients in Cliniko');
    }
  }

  async getPatient(patientId) {
    try {
      const response = await this.client.get(`/patients/${patientId}`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      this.logger.error('Failed to get patient:', error);
      throw new Error('Failed to retrieve patient from Cliniko');
    }
  }

  async createPatient(patientData) {
    try {
      const response = await this.client.post('/patients', patientData);
      this.logger.info(`Patient created: ${response.data.id}`);
      return response.data;
    } catch (error) {
      this.logger.error('Failed to create patient:', error);
      throw new Error('Failed to create patient in Cliniko');
    }
  }

  async updatePatient(patientId, patientData) {
    try {
      const response = await this.client.put(`/patients/${patientId}`, patientData);
      this.logger.info(`Patient updated: ${patientId}`);
      return response.data;
    } catch (error) {
      this.logger.error('Failed to update patient:', error);
      throw new Error('Failed to update patient in Cliniko');
    }
  }

  async findPatientByPhone(phoneNumber) {
    try {
      // Clean phone number for search
      const cleanedPhone = phoneNumber.replace(/\D/g, '');
      const searchTerms = [
        cleanedPhone,
        `+${cleanedPhone}`,
        cleanedPhone.substring(1), // Remove country code
        cleanedPhone.slice(-10) // Last 10 digits
      ];

      for (const term of searchTerms) {
        const patients = await this.searchPatients(term);
        if (patients.length > 0) {
          // Find exact match
          const exactMatch = patients.find(patient => {
            const patientPhone = patient.mobile_phone_number?.replace(/\D/g, '') || '';
            return patientPhone.includes(cleanedPhone.slice(-10)) || 
                   cleanedPhone.includes(patientPhone.slice(-10));
          });
          
          if (exactMatch) {
            return exactMatch;
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error('Failed to find patient by phone:', error);
      return null;
    }
  }

  // Practitioner methods
  async getPractitioners() {
    try {
      const response = await this.client.get('/practitioners', {
        params: {
          per_page: 100
        }
      });

      return response.data.practitioners || [];
    } catch (error) {
      this.logger.error('Failed to get practitioners:', error);
      throw new Error('Failed to retrieve practitioners from Cliniko');
    }
  }

  async getPractitioner(practitionerId) {
    try {
      const response = await this.client.get(`/practitioners/${practitionerId}`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      this.logger.error('Failed to get practitioner:', error);
      throw new Error('Failed to retrieve practitioner from Cliniko');
    }
  }

  // Appointment methods
  async getAppointments(params = {}) {
    try {
      const defaultParams = {
        per_page: 100,
        sort: 'starts_at'
      };

      const response = await this.client.get('/appointments', {
        params: { ...defaultParams, ...params }
      });

      return response.data.appointments || [];
    } catch (error) {
      this.logger.error('Failed to get appointments:', error);
      throw new Error('Failed to retrieve appointments from Cliniko');
    }
  }

  async getAppointment(appointmentId) {
    try {
      const response = await this.client.get(`/appointments/${appointmentId}`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      this.logger.error('Failed to get appointment:', error);
      throw new Error('Failed to retrieve appointment from Cliniko');
    }
  }

  async createAppointment(appointmentData) {
    try {
      const response = await this.client.post('/appointments', appointmentData);
      this.logger.info(`Appointment created: ${response.data.id}`);
      return response.data;
    } catch (error) {
      this.logger.error('Failed to create appointment:', error);
      throw new Error('Failed to create appointment in Cliniko');
    }
  }

  async updateAppointment(appointmentId, appointmentData) {
    try {
      const response = await this.client.put(`/appointments/${appointmentId}`, appointmentData);
      this.logger.info(`Appointment updated: ${appointmentId}`);
      return response.data;
    } catch (error) {
      this.logger.error('Failed to update appointment:', error);
      throw new Error('Failed to update appointment in Cliniko');
    }
  }

  async cancelAppointment(appointmentId, reason = 'Cancelled via WhatsApp') {
    try {
      const response = await this.client.delete(`/appointments/${appointmentId}`, {
        data: { cancellation_reason: reason }
      });
      this.logger.info(`Appointment cancelled: ${appointmentId}`);
      return response.data;
    } catch (error) {
      this.logger.error('Failed to cancel appointment:', error);
      throw new Error('Failed to cancel appointment in Cliniko');
    }
  }

  async getPatientAppointments(patientId, params = {}) {
    try {
      const defaultParams = {
        patient_id: patientId,
        per_page: 50,
        sort: 'starts_at'
      };

      return await this.getAppointments({ ...defaultParams, ...params });
    } catch (error) {
      this.logger.error('Failed to get patient appointments:', error);
      throw new Error('Failed to retrieve patient appointments from Cliniko');
    }
  }

  async getAppointmentsForDate(date) {
    try {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);

      const params = {
        starts_at_from: startDate.toISOString(),
        starts_at_to: endDate.toISOString(),
        per_page: 200
      };

      return await this.getAppointments(params);
    } catch (error) {
      this.logger.error('Failed to get appointments for date:', error);
      throw new Error('Failed to retrieve appointments for date from Cliniko');
    }
  }

  // Available times methods
  async getAvailableTimes(practitionerId, date, appointmentTypeId) {
    try {
      const response = await this.client.get('/available_times', {
        params: {
          practitioner_id: practitionerId,
          date: date,
          appointment_type_id: appointmentTypeId
        }
      });

      return response.data.available_times || [];
    } catch (error) {
      this.logger.error('Failed to get available times:', error);
      throw new Error('Failed to retrieve available times from Cliniko');
    }
  }

  // Appointment types methods
  async getAppointmentTypes() {
    try {
      const response = await this.client.get('/appointment_types', {
        params: {
          per_page: 100
        }
      });

      return response.data.appointment_types || [];
    } catch (error) {
      this.logger.error('Failed to get appointment types:', error);
      throw new Error('Failed to retrieve appointment types from Cliniko');
    }
  }

  async getAppointmentType(appointmentTypeId) {
    try {
      const response = await this.client.get(`/appointment_types/${appointmentTypeId}`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      this.logger.error('Failed to get appointment type:', error);
      throw new Error('Failed to retrieve appointment type from Cliniko');
    }
  }

  // Business methods
  async getBusiness() {
    try {
      const response = await this.client.get('/businesses');
      return response.data.businesses?.[0] || null;
    } catch (error) {
      this.logger.error('Failed to get business:', error);
      throw new Error('Failed to retrieve business from Cliniko');
    }
  }

  async getBusinessHours() {
    try {
      const response = await this.client.get('/business_hours');
      return response.data.business_hours || [];
    } catch (error) {
      this.logger.error('Failed to get business hours:', error);
      throw new Error('Failed to retrieve business hours from Cliniko');
    }
  }

  // Helper methods
  async findNextAvailableSlot(practitionerId, appointmentTypeId, startDate = new Date()) {
    try {
      const searchDays = 14; // Search for next 14 days
      const slots = [];

      for (let i = 0; i < searchDays; i++) {
        const searchDate = new Date(startDate);
        searchDate.setDate(startDate.getDate() + i);
        
        // Skip weekends (assuming clinic is closed)
        if (searchDate.getDay() === 0 || searchDate.getDay() === 6) {
          continue;
        }

        const availableTimes = await this.getAvailableTimes(
          practitionerId,
          searchDate.toISOString().split('T')[0],
          appointmentTypeId
        );

        if (availableTimes.length > 0) {
          slots.push({
            date: searchDate,
            times: availableTimes
          });
        }

        // Return first 5 days with availability
        if (slots.length >= 5) {
          break;
        }
      }

      return slots;
    } catch (error) {
      this.logger.error('Failed to find next available slot:', error);
      throw new Error('Failed to find available appointment slots');
    }
  }

  async validateAppointmentSlot(practitionerId, appointmentTypeId, dateTime) {
    try {
      const date = new Date(dateTime).toISOString().split('T')[0];
      const availableTimes = await this.getAvailableTimes(practitionerId, date, appointmentTypeId);
      
      const requestedTime = new Date(dateTime).toISOString();
      return availableTimes.some(slot => slot.starts_at === requestedTime);
    } catch (error) {
      this.logger.error('Failed to validate appointment slot:', error);
      return false;
    }
  }

  // Utility methods
  formatPatientName(patient) {
    return `${patient.first_name} ${patient.last_name}`.trim();
  }

  formatAppointmentDateTime(appointment) {
    const date = new Date(appointment.starts_at);
    return {
      date: date.toLocaleDateString(),
      time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      datetime: date
    };
  }

  formatPractitionerName(practitioner) {
    return `${practitioner.first_name} ${practitioner.last_name}`.trim();
  }

  // Health check
  async healthCheck() {
    try {
      await this.getBusiness();
      return true;
    } catch (error) {
      this.logger.error('Cliniko API health check failed:', error);
      return false;
    }
  }

  // Rate limiting awareness
  async withRateLimit(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error.response?.status === 429) {
        // Rate limited - wait and retry
        const retryAfter = error.response.headers['retry-after'] || 60;
        this.logger.warn(`Rate limited, waiting ${retryAfter} seconds`);
        
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        return await operation();
      }
      throw error;
    }
  }

  // Error handling with specific Cliniko error codes
  handleClinikoError(error) {
    if (error.response?.data?.errors) {
      const errors = error.response.data.errors;
      const errorMessages = errors.map(err => err.message || err).join(', ');
      throw new Error(`Cliniko API Error: ${errorMessages}`);
    }
    
    switch (error.response?.status) {
      case 401:
        throw new Error('Cliniko API authentication failed - check API key');
      case 403:
        throw new Error('Cliniko API access forbidden - insufficient permissions');
      case 404:
        throw new Error('Cliniko resource not found');
      case 422:
        throw new Error('Cliniko API validation error - invalid data provided');
      case 429:
        throw new Error('Cliniko API rate limit exceeded');
      case 500:
        throw new Error('Cliniko API server error');
      default:
        throw new Error(`Cliniko API error: ${error.message}`);
    }
  }
}

module.exports = ClinikoAPI;
