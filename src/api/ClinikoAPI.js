const SendMessage = require("./SendMessage.js");
const Logger = require("../core/Logger.js");
const config = require('../config/cliniko.js');

/**
 * Cliniko API wrapper for patient, appointment, and clinic actions.
 */
class ClinikoAPI {
  constructor() {
    this.logger = new Logger("ClinikoAPI");
  }

  /**
   * Check if the Cliniko API is healthy.
   * @returns {Promise<{status: string, error?: any}>}
   */
  async healthCheck() {
    try {
      await new SendMessage("/").get();
      return { status: "ok" };
    } catch (error) {
      this.logger.error("healthCheck failed");
      return { status: "error", error };
    }
  }

  /**
   * Get all clinics shown in online bookings, excluding UWC clinics.
   * @returns {Promise<Array>}
   */
  async getClinics() {
    const params = new URLSearchParams();
    params.append('q[]', 'show_in_online_bookings:=T');
    try {
      const data = await new SendMessage(`/businesses?${params.toString()}`, {}).get();
      const clinics = data.businesses;
      const pattern = /UWC/;
      const main_clinics = clinics.filter(item => !pattern.test(item.business_name));
      return main_clinics || [];
    } catch (error) {
      this.logger.error("getClinics failed");
      return [];
    }
  }

  /**
   * Get all practitioners for a specific clinic (business).
   * @param {string} business_id
   * @returns {Promise<Array>}
   */
  async getPractitionersForClinic(business_id) {
    const params = new URLSearchParams();
    params.append('q[]', 'show_in_online_bookings:=T');
    try {
      const url = `/businesses/${business_id}/practitioners?${params.toString()}`;
      console.debug(`Fetching physios : ${url}`); 
      const practitioners = await new SendMessage(url, {}).get();
      return practitioners.practitioners || [];
    } catch (error) {
      this.logger.error(`getPractitionersForClinic failed ${error}`);
      return [];
    }
  }

  /**
   * Find a patient by email address.
   * @param {string} email
   * @returns {Promise<Object|null>}
   */
  async findPatientByEmail(email) {
    try {
      const params = new URLSearchParams();
      params.append('q[]', `email:=${email}`);
      const data = await new SendMessage(`/patients?${params.toString()}`, {}).get();
      return data.patients?.[0] || null;
    } catch (error) {
      this.logger.error(`verifyPatientByEmail failed for ${email}`);
      return null;
    }
  }

  /**
   * Get next available appointment slots for all practitioners in a business.
   * @param {Object} options
   * @param {string} options.business_id
   * @param {number} [options.maxDays]
   * @param {number} [options.maxSlots]
   * @returns {Promise<Array>}
   */
  async getNextAvailableSlotsByBusiness({ business_id, maxDays, maxSlots } = {}) {
    try {
      const results = [];
      const practitioners = await this.getPractitionersForClinic(business_id);
      for (const practitioner of practitioners || []) {
        const blocks = await this.getNextAvailableSlots({
          practitioner_id: `${practitioner.id}`,
          business_id,
        });
        if (blocks?.length) {
          results.push(...blocks);
        }
      }
      return results; 
    } catch (error) {
      this.logger.error(`getNextAvailableSlotsByBusiness failed ${error}`);
      return {};
    }
  }

  /**
   * Get availability blocks for a practitioner and/or business.
   * @param {Object} options
   * @param {string} [options.practitioner_id]
   * @param {string} [options.business_id]
   * @param {string} [options.from]
   * @param {string} [options.to]
   * @returns {Promise<Array>}
   */
  async getAvailabilityBlocks({ practitioner_id, business_id, from, to }) {
    const params = new URLSearchParams();
    if (practitioner_id) params.append('practitioner_id', practitioner_id);
    if (business_id) params.append('business_id', business_id);
    if (from) params.append('from', from);
    if (to) params.append('to', to);

    const url = `/available_blocks?${params.toString()}`;
    console.debug(`Fetching availability blocks: ${url}`);

    try {
      const result = await new SendMessage('/availability_blocks', { params }).get();
      console.info(result.availability_blocks[0]);
      return result.availability_blocks || [];
    } catch (err) {
      this.logger.error(`getAvailabilityBlocks failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get available times for a practitioner, business, and appointment type.
   * @param {Object} options
   * @param {string} options.practitioner_id
   * @param {string} options.business_id
   * @param {string} options.appt_type
   * @param {string} [options.from]
   * @param {string} [options.to]
   * @returns {Promise<Array>}
   */
  async getAvailableTimes({ practitioner_id, business_id, appt_type, from, to }) {
    const params = new URLSearchParams();
    const today = new Date();

    if (from) {
      params.append('from', from);
    } else {
      const fromDate = new Date(today.setDate(today.getDate() + 1)).toISOString().split('T')[0];
      params.append('from', fromDate);
    }
    if (to) {
      params.append('to', to);
    } else {
      const maxDaysToSearch = parseInt(config.maxSlotDays ?? 5);
      const toDate = new Date(today.setDate(today.getDate() + maxDaysToSearch)).toISOString().split('T')[0];
      params.append('to', toDate);
    }

    const url = `/businesses/${business_id}/practitioners/${practitioner_id}/appointment_types/${appt_type}/available_times?${params.toString()}`;
    console.debug(`Fetching availabile times: ${url}`);

    try {
      const result = await new SendMessage(url, {}).get();
      console.info(`Total slots : ${result.total_entries}`);
      console.info(result.available_times[0]);
      return result.available_times || [];
    } catch (err) {
      this.logger.error(`getAvailabileTimes failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get appointment types for a practitioner (only those enabled for online booking).
   * @param {Object} options
   * @param {string} options.practitioner_id
   * @returns {Promise<Array>}
   */
  async getAppointmentTypes({ practitioner_id }) {
    const params = new URLSearchParams();
    params.append('q[]', 'show_in_online_bookings:=T');
    const url = `/practitioners/${practitioner_id}/appointment_types?${params.toString()}`;
    console.debug(`Fetching appointment types: ${url}`);

    try {
      const result = await new SendMessage(url, {}).get();
      const allTypes = result.appointment_types;
      const onlineBookingTypes = allTypes.filter(type => type.show_in_online_bookings === true);
      console.log(`Filtered to ${onlineBookingTypes.length} types that show in online bookings`);
      return onlineBookingTypes || [];
    } catch (err) {
      this.logger.error(`getAppointmentTypes failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get next available slots for a specific practitioner and business.
   * @param {Object} options
   * @param {string} options.practitioner_id
   * @param {string} options.business_id
   * @param {number} [options.maxDays]
   * @param {number} [options.maxSlots]
   * @returns {Promise<Array>}
   */
  async getNextAvailableSlots({ practitioner_id, business_id, maxDays, maxSlots } = {}) {
    try {
      const results = [];
      const maxDaysToSearch = parseInt(maxDays ?? config.maxSlotDays ?? 5);
      const maxSlotsTotal = parseInt(maxSlots ?? config.maxSlotCount ?? 5);
      const today = new Date();
      const fromDate = new Date(today.setDate(today.getDate() + 1)).toISOString().split('T')[0];
      const toDate = new Date(today.setDate(today.getDate() + maxDaysToSearch)).toISOString().split('T')[0];

      let practitionerObj = { display_name: "" };
      try {
        const practitioners = await this.getPractitionersForClinic(business_id);
        practitionerObj = practitioners.find(p => `${p.id}` === `${practitioner_id}`) || { display_name: "" };
      } catch (e) {
        this.logger.warn(`Could not fetch practitioner info for id=${practitioner_id}`);
      }

      const practitionerName = [practitionerObj.first_name, practitionerObj.last_name].filter(Boolean).join(' ') ||
        practitionerObj.display_name ||
        `Practitioner ${practitioner_id}`;

      const appointmentTypes = await this.getAppointmentTypes({ practitioner_id });
      for (const appointmentType of appointmentTypes || []) {
        const blocks = await this.getAvailableTimes({
          practitioner_id,
          business_id,
          appt_type: `${appointmentType.id}`,
          from: fromDate,
          to: toDate
        });
        if (blocks?.length) {
          const slicedSlots = blocks.slice(0, maxSlotsTotal);
          const tempObjects = slicedSlots.map(block => ({
            practitioner_id,
            business_id,
            practitioner_name: practitionerName,
            appointment_type_id: appointmentType.id,
            appointment_type_name: appointmentType.name,
            slot: block.appointment_start || block.start_time || block.starts_at
          }));
          results.push(...tempObjects);
        }
      }
      return results;
    } catch (error) {
      this.logger.error(`getNextAvailableSlots failed : ${error}`);
      return [];
    }
  }

  /**
   * Register a new patient in Cliniko.
   * @param {Object} patient - Patient object with required fields
   * @returns {Promise<Object>} Cliniko API response
   */
  async registerNewPatient(patient) {
    try {
      const payload = { patient };
      this.logger.info("📨 Creating Cliniko patient:", payload);
      const response = await new SendMessage("/patients").post(patient);
      this.logger.info("✅ Patient registered in Cliniko", { id: response?.patient?.id });
      return response;
    } catch (error) {
      this.logger.error("❌ registerNewPatient failed", error);
      throw error;
    }
  }

  /**
   * Book an individual appointment in Cliniko.
   * @param {Object} options
   * @param {string} options.patient_id
   * @param {string} options.practitioner_id
   * @param {string} options.business_id
   * @param {string} options.appointment_type_id
   * @param {string} options.starts_at - ISO date string
   * @param {string} [options.ends_at]
   * @returns {Promise<{success: boolean, appointment?: Object, message?: string}>}
   */
  async bookAppointment({ patient_id, practitioner_id, business_id, appointment_type_id, starts_at, ends_at }) {
    try {
      if (!patient_id || !practitioner_id || !business_id || !appointment_type_id || !starts_at) {
        this.logger.error("bookAppointment: Missing required field", {
          patient_id, practitioner_id, business_id, appointment_type_id, starts_at, ends_at
        });
        return { success: false, message: 'Missing required field for booking.' };
      }
      const payload = {
        appointment_type_id: appointment_type_id.toString(),
        business_id: business_id.toString(),
        patient_id: patient_id.toString(),
        practitioner_id: practitioner_id.toString(),
        starts_at,
      };
      if (ends_at) payload.ends_at = ends_at;
      this.logger.info(`Creating individual appointment:`, payload);
      const response = await new SendMessage(`/individual_appointments`).post(payload);
      this.logger.info(`Individual appointment booked:`, response?.id);
      return { success: true, appointment: response };
    } catch (error) {
      this.logger.error(`bookAppointment failed: ${error}`);
      return { success: false, message: 'Failed to book appointment.' };
    }
  }

  /**
   * List individual appointments for a patient.
   * @param {string} patientId
   * @returns {Promise<Array>}
   */
  async getBookingsByPatientId(patientId) {
    try {
      const params = new URLSearchParams();
      params.append('q[]', `patient_id:=${patientId}`);
      params.append('sort', 'starts_at:asc');
      params.append('per_page', 20);
      const data = await new SendMessage(`/individual_appointments?${params.toString()}`, {}).get();
      return data.individual_appointments || [];
    } catch (error) {
      this.logger.error(`getBookingsByPatientId failed for ${patientId}`);
      return [];
    }
  }

  /**
   * Cancel a specific individual appointment.
   * @param {string} appointmentId
   * @returns {Promise<{success: boolean, appointmentId?: string, message?: string}>}
   */
  async cancelSpecificAppointment(appointmentId) {
    try {
      const cancelPayload = {
        cancellation_note: "Cancelled via chatbot",
        cancellation_reason: 50
      };
      await new SendMessage(`/individual_appointments/${appointmentId}/cancel`).patch(cancelPayload);
      this.logger.info(`Appointment ${appointmentId} canceled`);
      return { success: true, appointmentId };
    } catch (error) {
      this.logger.error(`cancelSpecificAppointment failed: ${error}`);
      return { success: false, message: 'Failed to cancel appointment.' };
    }
  }

  /**
   * Update an individual appointment.
   * @param {string} appointmentId
   * @param {Object} payload
   * @returns {Promise<{success: boolean, appointmentId?: string, message?: string}>}
   */
  async updateIndividualAppointment(appointmentId, payload) {
    try {
      await new SendMessage(`/individual_appointments/${appointmentId}`, {}).patch(payload);
      this.logger.info(`Appointment ${appointmentId} updated`);
      return { success: true, appointmentId };
    } catch (error) {
      this.logger.error(`updateIndividualAppointment failed: ${error}`);
      return { success: false, message: 'Failed to update appointment.' };
    }
  }

  /**
   * Get the latest appointment summary for a patient (returns IDs via links).
   * @param {string} patientId
   * @returns {Promise<Object|null>} { id, business, practitioner, appointment_type } (links objects)
   */
  async getLatestAppointmentSummaryForPatient(patientId) {
    try {
      const params = new URLSearchParams();
      params.append('q[]', `patient_id:=${patientId}`);
      params.append('sort', 'starts_at:desc');
      params.append('per_page', 1);

      const data = await new SendMessage(`/individual_appointments?${params.toString()}`, {}).get();
      const appointment = (data.individual_appointments || [])[0];
      return appointment || null;
    } catch (error) {
      this.logger.error(`getLatestAppointmentSummaryForPatient failed for ${patientId}: ${error}`);
      return null;
    }
  }

  /* ----------------------------------------------------------------------
   * Deprecated / Not Used By ChatbotEngine.js (for future clean-up/removal)
   * --------------------------------------------------------------------*/

  /**
   * Get all practitioners grouped by clinic (NOT USED).
   * @deprecated
   * @returns {Promise<Object>} Map of clinicId -> practitioners[]
   */
  async getPractitionersByClinic() {
    const params = new URLSearchParams();
    params.append('q[]', 'show_in_online_bookings:=T');
    try {
      const clinics = await this.getClinics();
      const grouped = {};
      for (const clinic of clinics) {
        const url = `/businesses/${clinic.id}/practitioners?${params.toString()}`;
        console.debug(`Fetching physios : ${url}`); 
        const practitioners = await new SendMessage(url, {}).get();
        grouped[clinic.id] = practitioners.practitioners || [];
      }
      return grouped;
    } catch (error) {
      this.logger.error("getPractitionersByClinic failed");
      return {};
    }
  }

  /**
   * Get static fees by clinic (NOT USED).
   * @deprecated
   * @returns {Object}
   */
  async getFeesByClinic() {
    return {
      "Prohealth Physiofocus Pte Ltd": [
        { service: "Initial Assessment", price: "SGD 160" },
        { service: "Follow-up Consultation", price: "SGD 140" },
      ],
      "Prohealth In Touch Physiotherapy": [
        { service: "Initial Assessment", price: "SGD 170" },
        { service: "Follow-up Consultation", price: "SGD 150" },
      ],
      "UWC East": [
        { service: "Initial Assessment", price: "SGD 180" },
        { service: "Follow-up Consultation", price: "SGD 160" },
      ],
      "UWC Dover": [
        { service: "Initial Assessment", price: "SGD 180" },
        { service: "Follow-up Consultation", price: "SGD 160" },
      ],
    };
  }

  /**
   * Cancel the latest appointment for a patient (NOT USED).
   * @deprecated
   * @param {string} patientId
   * @returns {Promise<{success: boolean, appointmentId?: string, message?: string}>}
   */
  async cancelLatestAppointment(patientId) {
    try {
      const params = new URLSearchParams();
      params.append('q[]', `patient_id:=${patientId}`);
      params.append('sort', 'starts_at:desc');
      params.append('per_page', 1);

      const data = await new SendMessage(`/individual_appointments?${params.toString()}`, {}).get();
      const appointment = (data.individual_appointments || [])[0];

      if (!appointment) {
        this.logger.info(`No appointment found for patientId: ${patientId}`);
        return { success: false, message: 'No recent appointments found.' };
      }

      const cancelPayload = {
        cancellation_reason: 50,
        cancellation_note: "Cancelled via chatbot"
      };

      await new SendMessage(`/individual_appointments/${appointment.id}/cancel`).patch(cancelPayload);

      this.logger.info(`Appointment ${appointment.id} canceled for patientId: ${patientId}`);
      return { success: true, appointmentId: appointment.id };
    } catch (error) {
      this.logger.error(`cancelLatestAppointment failed: ${error}`);
      return { success: false, message: 'Failed to cancel appointment.' };
    }
  }

  /**
   * Get all appointment types, optionally filtering by practitioner (NOT USED).
   * @deprecated
   * @param {string|null} practitionerId
   * @returns {Promise<Array>}
   */
  async getAppointmentTypesAll(practitionerId = null) {
    try {
      console.log(`Fetching appointment types${practitionerId ? ` for practitioner: ${practitionerId}` : ''}`);
      let allAppointmentTypes = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await new SendMessage('/appointment_types', { page }).get();
        allAppointmentTypes = allAppointmentTypes.concat(response.appointment_types);
        hasMore = response.links && response.links.next;
        page++;
      }

      console.log(`Total appointment types found: ${allAppointmentTypes.length}`);

      if (!practitionerId) {
        const onlineBookingTypes = allAppointmentTypes.filter(type => type.show_in_online_bookings === true);
        console.log(`Filtered to ${onlineBookingTypes.length} types that show in online bookings`);
        return onlineBookingTypes;
      }

      const practitionerAppointmentTypes = [];
      for (const appointmentType of allAppointmentTypes) {
        if (!appointmentType.show_in_online_bookings) continue;
        if (appointmentType.practitioners.links && appointmentType.practitioners.links.length > 0) {
          const isPractitionerLinked = appointmentType.practitioners.links.some(link => {
            if (typeof link === 'string') {
              return link === practitionerId;
            } else if (typeof link === 'object' && link.practitioner) {
              return link.practitioner.id === practitionerId;
            }
            return false;
          });
          if (isPractitionerLinked) practitionerAppointmentTypes.push(appointmentType);
        } else {
          console.info(`Appointment type "${appointmentType.name}" with id ${appointmentType.id} has no practitioner links`);
        }
      }

      console.info(`Found ${practitionerAppointmentTypes.length} appointment types linked to practitioner ${practitionerId}`);
      if (practitionerAppointmentTypes.length > 0) {
        console.info('Practitioner-specific appointment types:');
        practitionerAppointmentTypes.forEach(type => {
          console.log(`  - ${type.name} (ID: ${type.id})`);
        });
      }

      return practitionerAppointmentTypes;
    } catch (error) {
      console.error('Error fetching appointment types:', error);
      throw error;
    }
  }
}

module.exports = ClinikoAPI;
