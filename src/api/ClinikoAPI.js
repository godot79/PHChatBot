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
          maxDays,
          maxSlots,
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
   * Adds explicit URL logging and structured error context to help diagnose malformed queries.
   *
   * @param {Object} options
   * @param {string} options.practitioner_id
   * @param {string} options.business_id
   * @param {string} options.appt_type
   * @param {string} [options.from] - ISO date (YYYY-MM-DD or full ISO). If absent, uses tomorrow.
   * @param {string} [options.to]   - ISO date (YYYY-MM-DD or full ISO). If absent, uses tomorrow + config.maxSlotDays.
   * @returns {Promise<Array>}
   */
  async getAvailableTimes({ practitioner_id, business_id, appt_type, from, to }) {
    const params = new URLSearchParams();
    const today = new Date();

    if (from) {
      // Accept either YYYY-MM-DD or full ISO; Cliniko endpoint expects a date (YYYY-MM-DD).
      const fromDateOnly = /^\d{4}-\d{2}-\d{2}/.test(from) ? from.slice(0, 10) : new Date(from).toISOString().split('T')[0];
      params.append('from', fromDateOnly);
    } else {
      const fromDate = new Date(today.setDate(today.getDate() + 1)).toISOString().split('T')[0];
      params.append('from', fromDate);
    }

    if (to) {
      const toDateOnly = /^\d{4}-\d{2}-\d{2}/.test(to) ? to.slice(0, 10) : new Date(to).toISOString().split('T')[0];
      params.append('to', toDateOnly);
    } else {
      const maxDaysToSearch = parseInt(config.maxSlotDays ?? 5);
      const toDate = new Date(today.setDate(today.getDate() + 1 + maxDaysToSearch)).toISOString().split('T')[0];
      params.append('to', toDate);
    }

    const queryString = params.toString();
    const url = `/businesses/${business_id}/practitioners/${practitioner_id}/appointment_types/${appt_type}/available_times?${queryString}`;
    // Explicitly log the full URL so malformed params are obvious
    this.logger.debug(`GET ${url}`, { method: 'GET', endpoint: url });

    try {
      const result = await new SendMessage(url, {}).get();
      console.info(`Total slots : ${result.total_entries}`);
      console.info(result.available_times?.[0]);
      return result.available_times || [];
    } catch (err) {
      // Safer, structured logging with full context
      const safeMsg = (err && (err.message || err.status || err.code)) || 'unknown_error';
      this.logger.error('getAvailabileTimes failed', {
        error: safeMsg,
        endpoint: url,
        params: {
          practitioner_id,
          business_id,
          appt_type,
          from: params.get('from'),
          to: params.get('to')
        }
      });
      // Preserve original behavior: rethrow to let callers decide
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
      // Check if this business is a UWC clinic and skip if so
      const businessObj = await this.getBusinessById(business_id);
      if (businessObj && /UWC/i.test(businessObj.business_name)) {
        this.logger.warn(`Skipping UWC clinic slots: ${businessObj.business_name}`);
        return [];
      }

      const results = [];
      const maxDaysToSearch = parseInt(maxDays ?? config.maxSlotDays ?? 5);
      const maxSlotsTotal = parseInt(maxSlots ?? config.maxSlotCount ?? 5);
      const today = new Date();
      const fromDate = new Date(today.setDate(today.getDate() + 1)).toISOString().split('T')[0];
      const toDate = new Date(today.setDate(today.getDate() + 1 + maxDaysToSearch)).toISOString().split('T')[0];

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
          const businessName = businessObj?.business_name || '';
          if (!/UWC/i.test(businessName)) {
            const tempObjects = slicedSlots.map(block => ({
              practitioner_id,
              business_id,
              business_name: businessName,
              practitioner_name: practitionerName,
              appointment_type_id: appointmentType.id,
              appointment_type_name: appointmentType.name,
              slot: block.appointment_start || block.start_time || block.starts_at
            }));
            results.push(...tempObjects);
          }
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
  async getBookingsByPatientIdOld(patientId) {
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
   * List individual appointments for a patient within an optional time window.
   * Supports active, cancelled, or both. Returns merged, de-duplicated, sorted rows.
   *
   * @param {string} patientId
   * @param {Object} [opts]
   * @param {'past'|'future'|'all'} [opts.when='future']
   * @param {string} [opts.fromISO]  // inclusive
   * @param {string} [opts.toISO]    // exclusive
   * @param {number} [opts.perPage=100] // will be clamped to [1..100]
   * @param {'active'|'cancelled'|'both'|'none'} [opts.statusMode='both']
   * @returns {Promise<Array>} individual_appointments[]
   */
  async getBookingsByPatientId(patientId, opts = {}) {
    try {
      const when = String(opts.when || 'future').toLowerCase();
      const perPage = Math.max(1, Math.min(100, Number.isFinite(opts.perPage) ? opts.perPage : 100)); // Cliniko max = 100
      const statusMode = String(opts.statusMode || 'both').toLowerCase();
      const nowISO = new Date().toISOString();

      const buildParams = (cancelMode) => {
        const p = new URLSearchParams();
        p.append('q[]', `patient_id:=${patientId}`);

        if (when === 'past') {
          const toISO = opts.toISO || nowISO;
          const fromISO = opts.fromISO || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          p.append('q[]', `starts_at:>=${fromISO}`);
          p.append('q[]', `starts_at:<${toISO}`);
          p.append('sort', 'starts_at:desc');
        } else if (when === 'future') {
          const fromISO = opts.fromISO || nowISO;
          if (opts.toISO) p.append('q[]', `starts_at:<${opts.toISO}`);
          p.append('q[]', `starts_at:>=${fromISO}`);
          p.append('sort', 'starts_at:asc');
        } else { // 'all'
          if (opts.fromISO) p.append('q[]', `starts_at:>=${opts.fromISO}`);
          if (opts.toISO)   p.append('q[]', `starts_at:<${opts.toISO}`);
          p.append('sort', 'starts_at:asc');
        }

        // cancelled_at operators per Cliniko:
        //   '?'  => IS NOT NULL  (cancelled)
        //   '!?' => IS NULL      (active)
        if (cancelMode === 'cancelled') p.append('q[]', 'cancelled_at:?');
        if (cancelMode === 'active')    p.append('q[]', 'cancelled_at:!?');

        p.append('per_page', String(perPage));
        return p;
      };

      const fetchOne = async (cancelMode) => {
        const params = buildParams(cancelMode);
        const url = `/individual_appointments?${params.toString()}`;
        this.logger.debug(url);
        const data = await new SendMessage(url, {}).get();
        return (data && data.individual_appointments) ? data.individual_appointments : [];
      };

      let rows = [];
      if (statusMode === 'both') {
        // Sequential to avoid transient 4xx surfacing as double-fail
        const active = await fetchOne('active').catch(() => {
          this.logger.error(`getBookingsByPatientId(active) failed for ${patientId}`);
          return [];
        });
        const cancelled = await fetchOne('cancelled').catch(() => {
          this.logger.error(`getBookingsByPatientId(cancelled) failed for ${patientId}`);
          return [];
        });
        const map = new Map();
        for (const r of [...active, ...cancelled]) map.set(r.id, r);
        rows = Array.from(map.values());
      } else if (statusMode === 'active') {
        rows = await fetchOne('active');
      } else if (statusMode === 'cancelled') {
        rows = await fetchOne('cancelled');
      } else {
        rows = await fetchOne('none');
      }
      // Deterministic sort
      rows.sort((a, b) => {
        const da = new Date(a.starts_at).getTime();
        const db = new Date(b.starts_at).getTime();
        return (when === 'past') ? (db - da) : (da - db);
      });

      return rows;
    } catch (error) {
      this.logger.error(`getBookingsByPatientId failed for ${patientId}`, { error: error?.response?.status || error?.message });
      return [];
    }
  }
  async getBookingsByPatientId(patientId, opts = {}) {
    try {
      const when = String(opts.when || 'future').toLowerCase();
      const perPage = Math.max(1, Math.min(100, Number.isFinite(opts.perPage) ? opts.perPage : 100)); // Cliniko max = 100
      const statusMode = String(opts.statusMode || 'both').toLowerCase();
      const nowISO = new Date().toISOString();

      const buildParams = (cancelMode) => {
        const p = new URLSearchParams();
        p.append('q[]', `patient_id:=${patientId}`);

        if (when === 'past') {
          const toISO = opts.toISO || nowISO;
          const fromISO = opts.fromISO || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          p.append('q[]', `starts_at:>=${fromISO}`);
          p.append('q[]', `starts_at:<${toISO}`);
          p.append('sort', 'starts_at:desc');
        } else if (when === 'future') {
          const fromISO = opts.fromISO || nowISO;
          if (opts.toISO) p.append('q[]', `starts_at:<${opts.toISO}`);
          p.append('q[]', `starts_at:>=${fromISO}`);
          p.append('sort', 'starts_at:asc');
        } else { // 'all'
          if (opts.fromISO) p.append('q[]', `starts_at:>=${opts.fromISO}`);
          if (opts.toISO)   p.append('q[]', `starts_at:<${opts.toISO}`);
          p.append('sort', 'starts_at:asc');
        }

        // cancelled_at operators per Cliniko:
        //   '?'  => IS NOT NULL  (cancelled)
        //   '!?' => IS NULL      (active)
        if (cancelMode === 'cancelled') p.append('q[]', 'cancelled_at:?');
        if (cancelMode === 'active')    p.append('q[]', 'cancelled_at:!?');

        p.append('per_page', String(perPage));
        return p;
      };

      const fetchOne = async (cancelMode) => {
        const params = buildParams(cancelMode);
        const url = `/individual_appointments?${params.toString()}`;
        this.logger.debug(url);
        const data = await new SendMessage(url, {}).get();
        return (data && data.individual_appointments) ? data.individual_appointments : [];
      };

      let rows = [];
      if (statusMode === 'both') {
        // Sequential to avoid transient 4xx surfacing as double-fail
        const active = await fetchOne('active').catch(() => {
          this.logger.error(`getBookingsByPatientId(active) failed for ${patientId}`);
          return [];
        });
        const cancelled = await fetchOne('cancelled').catch(() => {
          this.logger.error(`getBookingsByPatientId(cancelled) failed for ${patientId}`);
          return [];
        });
        const map = new Map();
        for (const r of [...active, ...cancelled]) map.set(r.id, r);
        rows = Array.from(map.values());
      } else if (statusMode === 'active') {
        rows = await fetchOne('active');
      } else if (statusMode === 'cancelled') {
        rows = await fetchOne('cancelled');
      } else {
        rows = await fetchOne('none');
      }

      // Deterministic sort
      rows.sort((a, b) => {
        const da = new Date(a.starts_at).getTime();
        const db = new Date(b.starts_at).getTime();
        return (when === 'past') ? (db - da) : (da - db);
      });

      return rows;
    } catch (error) {
      this.logger.error(`getBookingsByPatientId failed for ${patientId}`, { error: error?.response?.status || error?.message });
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

  /**
   * Get all practitioners grouped by clinic, including clinic name and id.
   * Returns an array of objects each containing clinic_id, clinic_name, and practitioners[].
   * This eliminates the need for an extra clinics fetch in handlers.
   * @returns {Promise<Array<{clinic_id: string, clinic_name: string, practitioners: Array<Object>}>}
   */
  async getPractitionersByClinic() {
    const params = new URLSearchParams();
    params.append('q[]', 'show_in_online_bookings:=T');
    try {
      const clinics = await this.getClinics();
      const grouped = [];

      for (const clinic of clinics) {
        const url = `/businesses/${clinic.id}/practitioners?${params.toString()}`;
        console.debug(`Fetching physios : ${url}`); 
        const practitioners = await new SendMessage(url, {}).get();

        grouped.push({
          clinic_id: clinic.id,
          clinic_name: clinic.business_name,
          practitioners: practitioners.practitioners || []
        });
      }
      return grouped;
    } catch (error) {
      this.logger.error("getPractitionersByClinic failed : ${error}");
      return [];
    }
  }

  /**
   * Get available slots for a business (and optionally a practitioner) within a date range.
   * Returns an array of slots, each containing practitioner, appointment type, and slot info.
   * Now logs validated date window and inner GET URLs for each combination to detect malformed queries.
   *
   * @param {Object} options
   * @param {string} options.business_id - Clinic/business ID
   * @param {string} options.from - ISO start datetime or date (e.g. '2024-08-10T00:00:00Z' or '2024-08-10')
   * @param {string} options.to - ISO end datetime or date (e.g. '2024-08-10T23:59:59Z' or '2024-08-10')
   * @param {string} [options.practitioner_id] - (Optional) Practitioner ID to filter
   * @returns {Promise<Array>} Array of slots: [{ practitioner_id, practitioner_name, appointment_type_id, appointment_type_name, slot }]
   */
  async getAvailableSlotsByBusinessAndDate({ business_id, from, to, practitioner_id }) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    try {
      if (!business_id || !from || !to) throw new Error('Missing required parameters.');
      // Normalize to YYYY-MM-DD for window validation
      const fromDateOnly = /^\d{4}-\d{2}-\d{2}/.test(from) ? from.slice(0, 10) : new Date(from).toISOString().split('T')[0];
      const toDateOnly = /^\d{4}-\d{2}-\d{2}/.test(to) ? to.slice(0, 10) : new Date(to).toISOString().split('T')[0];

      const fromDate = new Date(`${fromDateOnly}T00:00:00Z`);
      const toDate = new Date(`${toDateOnly}T00:00:00Z`);
      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) throw new Error('Invalid date format.');
      if ((toDate - fromDate) / DAY_MS > 7) throw new Error('Date range must not exceed 7 days.');

      // Log validated window
      this.logger.debug('getAvailableSlotsByBusinessAndDate window', {
        business_id,
        from: fromDateOnly,
        to: toDateOnly
      });

      // Skip UWC clinics
      const businessObj = await this.getBusinessById(business_id);
      if (businessObj && /UWC/i.test(businessObj.business_name)) {
        this.logger.warn(`Skipping UWC clinic slots: ${businessObj.business_name}`);
        return [];
      }

      let practitioners = [];
      if (practitioner_id) {
        const all = await this.getPractitionersForClinic(business_id);
        practitioners = all.filter(p => `${p.id}` === `${practitioner_id}`);
        if (!practitioners.length) throw new Error('Practitioner not found for this clinic.');
      } else {
        practitioners = await this.getPractitionersForClinic(business_id);
      }

      let allSlots = [];
      for (const practitioner of practitioners) {
        const apptTypes = await this.getAppointmentTypes({ practitioner_id: practitioner.id });
        for (const apptType of apptTypes) {
          let slots = [];
          try {
            // Build the exact inner URL we expect getAvailableTimes to call (for log visibility)
            const innerParams = new URLSearchParams();
            innerParams.append('from', fromDateOnly);
            innerParams.append('to', toDateOnly);
            const innerUrl = `/businesses/${business_id}/practitioners/${practitioner.id}/appointment_types/${apptType.id}/available_times?${innerParams.toString()}`;
            this.logger.debug(`Inner GET ${innerUrl}`, {
              endpoint: innerUrl,
              practitioner_id: practitioner.id,
              appt_type: apptType.id,
              business_id,
              from: fromDateOnly,
              to: toDateOnly
            });

            // Call through the official method (keeps behavior identical)
            slots = await this.getAvailableTimes({
              practitioner_id: practitioner.id,
              business_id,
              appt_type: apptType.id,
              from: fromDateOnly,
              to: toDateOnly,
            });
          } catch (slotErr) {
            const safeMsg = (slotErr && (slotErr.message || slotErr.status || slotErr.code)) || 'unknown_error';
            // Log the failed inner query with full context
            this.logger.error('Slot fetch failed', {
              error: safeMsg,
              practitioner_id: practitioner.id,
              appt_type: apptType.id,
              business_id,
              from: fromDateOnly,
              to: toDateOnly
            });
          }

          if (slots.length) {
            const businessName = businessObj?.business_name || '';
            if (!/UWC/i.test(businessName)) {
              allSlots.push(...slots.map(slot => ({
                practitioner_id: practitioner.id,
                practitioner_name: practitioner.display_name || `${practitioner.first_name} ${practitioner.last_name}`.trim(),
                appointment_type_id: apptType.id,
                appointment_type_name: apptType.name,
                business_id: business_id,
                business_name: businessName,
                slot: slot.appointment_start || slot.start_time || slot.starts_at,
              })));
            }
          }
        }
      }

      return allSlots;
    } catch (error) {
      this.logger && this.logger.error && this.logger.error(`getAvailableSlotsByBusinessAndDate failed`, {
        business_id,
        from,
        to,
        practitioner_id: practitioner_id || null,
        error: error?.message || error?.status || error?.code || 'unknown_error'
      });
      return [];
    }
  }

  /**
   * Fetch a practitioner by ID from the Cliniko API.
   * @param {string|number} practitionerId - The practitioner ID.
   * @returns {Promise<Object|null>} Practitioner object (or null if not found).
   */
  async getPractitionerById(practitionerId) {
    if (!practitionerId) {
      this.logger.error("getPractitionerById: practitionerId is required");
      return null;
    }
    try {
      const url = `/practitioners/${practitionerId}`;
      const result = await new SendMessage(url,{}).get();
      return result || null;
    } catch (error) {
      this.logger.error(`getPractitionerById failed for ${practitionerId}: ${error}`);
      return null;
    }
  }

  /**
   * Fetch a appointment type by ID from the Cliniko API.
   * @param {string|number} appointmentTypeId - The appointment type ID.
   * @returns {Promise<Object|null>} Appointment type object (or null if not found).
   */
  async getAppointmentTypeById(appointmentTypeId) {
    if (!appointmentTypeId) {
      this.logger.error("getAppointmentTypeById: appointmentTypeId is required");
      return null;
    }
    try {
      const url = `/appointment_types/${appointmentTypeId}`;
      const result = await new SendMessage(url, {}).get();
      return result || null;
    } catch (error) {
      this.logger.error(`getAppointmentTypeById failed for ${appointmentTypeId}: ${error}`);
      return null;
    }
  }

  /**
   * Fetch a business (clinic) by ID from the Cliniko API.
   * @param {string|number} businessId - The business/clinic ID.
   * @returns {Promise<Object|null>} Business object (or null if not found).
   */
  async getBusinessById(businessId) {
    if (!businessId) {
      this.logger.error("getBusinessById: businessId is required");
      return null;
    }
    try {
      const url = `/businesses/${businessId}`;
      const result = await new SendMessage(url, {}).get();
      console.log('[DEBUG getBusinessById result]', result);
      // The response IS the business object, NOT { business: ... }
      if (result && result.id) {
        return result;
      }
      this.logger.warn(`No business found for businessId=${businessId}`);
      return null;
    } catch (error) {
      this.logger.error(`getBusinessById failed for ${businessId}: ${error}`);
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
  async DeprecatedgetPractitionersByClinic() {
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
