const SendMessage = require("./SendMessage.js");
const Logger = require("../core/Logger.js");
const config = require('../config/cliniko.js');
const RegionContext = require('../core/RegionContext');

// Clinics whose names match this pattern are excluded from all booking flows.
// Physiofocus SG was shut down; UWC clinics are handled by a separate contract.
const EXCLUDED_CLINIC_PATTERN = /UWC|physio\s*focus/i;

// Short-lived cache for getPractitionersByClinic(), keyed by region.
// Practitioners change rarely; 30 s collapses the 14 call sites in the engine
// to at most one real Cliniko fetch per region per request window.
const _groupsCache = new Map();
const GROUPS_CACHE_TTL_MS = 30_000;

// Same 30 s pattern for the other rarely-changing lookups that a single
// availability sweep (buildAvailablePhysiosForTypeName) re-fetches dozens of
// times for data already implied by the cached groups above.
const _apptTypesCache = new Map();          // key: `${region}:${practitioner_id}`
const _practitionersForClinicCache = new Map(); // key: `${region}:${business_id}`
const _businessByIdCache = new Map();        // key: `${region}:${business_id}`

// getAvailableTimes reflects live availability, so it gets its own longer,
// configurable TTL (config.availableTimesCacheTtlMs, default 5 min) rather
// than the 30 s lookup TTL above. Safe because bookAppointment() always
// re-validates against Cliniko at write time — a stale cached slot just
// fails cleanly there instead of risking a double-booking.
const _availableTimesCache = new Map();      // key: `${region}:${business_id}:${practitioner_id}:${appt_type}:${from}:${to}`

function _cacheGet(map, key) {
  const hit = map.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.data;
  return undefined;
}

function _cacheSet(map, key, data, ttlMs) {
  map.set(key, { data, expiresAt: Date.now() + ttlMs });
}

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
   * Fetch clinics without swallowing errors. Internal use only — callers that
   * need to distinguish "confirmed zero clinics" from "fetch failed" (e.g.
   * getPractitionersByClinic(), so it doesn't cache a transient failure as a
   * real empty result) should call this instead of getClinics().
   * @returns {Promise<Array>}
   */
  async _getClinicsRaw() {
    const params = new URLSearchParams();
    params.append('q[]', 'show_in_online_bookings:=T');
    const data = await new SendMessage(`/businesses?${params.toString()}`, {}).get();
    const clinics = data.businesses;
    const main_clinics = clinics.filter(item => !EXCLUDED_CLINIC_PATTERN.test(item.business_name));
    return main_clinics || [];
  }

  /**
   * Get all clinics shown in online bookings, excluding UWC clinics.
   * @returns {Promise<Array>}
   */
  async getClinics() {
    try {
      return await this._getClinicsRaw();
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
    const cacheKey = `${RegionContext.get() || 'default'}:${business_id}`;
    const cached = _cacheGet(_practitionersForClinicCache, cacheKey);
    if (cached) return cached;

    const params = new URLSearchParams();
    params.append('q[]', 'show_in_online_bookings:=T');
    try {
      const url = `/businesses/${business_id}/practitioners?${params.toString()}`;
      console.debug(`Fetching physios : ${url}`);
      const practitioners = await new SendMessage(url, {}).get();
      const result = practitioners.practitioners || [];
      _cacheSet(_practitionersForClinicCache, cacheKey, result, GROUPS_CACHE_TTL_MS);
      return result;
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
   * Find a patient by email and DOB (YYYY-MM-DD).
   * - First tries exact email+DOB match.
   * - If DOB not provided or no match, falls back to email-only search (to preserve legacy flows).
   *
   * @param {string} email
   * @param {string|null} date_of_birth - 'YYYY-MM-DD' or null/empty to skip DOB filter
   * @returns {Promise<Object|null>}
   */
  async findPatientByEmailAndDob(email, date_of_birth) {
    const safeEmail = String(email || '').trim().toLowerCase();
    const safeDob = String(date_of_birth || '').trim();
    try {
      const params = new URLSearchParams();
      params.append('q[]', `email:=${safeEmail}`);
      if (safeDob) params.append('q[]', `date_of_birth:=${safeDob}`);
      const data = await new SendMessage(`/patients?${params.toString()}`, {}).get();

      // Exact path: with DOB filter, any row means success
      if (safeDob && Array.isArray(data?.patients) && data.patients.length > 0) {
        return data.patients[0];
      }

      // Fallback: email-only if no DOB provided or no exact match
      if (!safeDob) {
        return data.patients?.[0] || null;
      }

      // If DOB provided but no direct match was returned by API, try a lenient filter:
      // Fetch email-only and then filter client-side on DOB (in case API ignores DOB filter in some tenants)
      try {
        const p2 = new URLSearchParams();
        p2.append('q[]', `email:=${safeEmail}`);
        const d2 = await new SendMessage(`/patients?${p2.toString()}`, {}).get();
        const rows = Array.isArray(d2?.patients) ? d2.patients : [];
        const found = rows.find(r => String(r?.date_of_birth || '').slice(0,10) === safeDob);
        return found || null;
      } catch {
        return null;
      }
    } catch (error) {
      this.logger.error(`findPatientByEmailAndDob failed for ${safeEmail}/${safeDob || '—'}`);
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

    const cacheKey = `${RegionContext.get() || 'default'}:${url}`;
    const cached = _cacheGet(_availableTimesCache, cacheKey);
    if (cached) return cached;

    try {
      const result = await new SendMessage(url, {}).get();
      console.info(`Total slots : ${result.total_entries}`);
      console.info(result.available_times?.[0]);
      const output = result.available_times || [];
      _cacheSet(_availableTimesCache, cacheKey, output, config.availableTimesCacheTtlMs);
      return output;
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
    const cacheKey = `${RegionContext.get() || 'default'}:${practitioner_id}`;
    const cached = _cacheGet(_apptTypesCache, cacheKey);
    if (cached) return cached;

    const params = new URLSearchParams();
    params.append('q[]', 'show_in_online_bookings:=T');
    const url = `/practitioners/${practitioner_id}/appointment_types?${params.toString()}`;
    console.debug(`Fetching appointment types: ${url}`);

    try {
      const result = await new SendMessage(url, {}).get();
      const allTypes = result.appointment_types;
      const onlineBookingTypes = allTypes.filter(type => type.show_in_online_bookings === true);
      console.log(`Filtered to ${onlineBookingTypes.length} types that show in online bookings`);
      const output = onlineBookingTypes || [];
      _cacheSet(_apptTypesCache, cacheKey, output, GROUPS_CACHE_TTL_MS);
      return output;
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
      // Check if this business is excluded from booking (UWC, closed clinics)
      const businessObj = await this.getBusinessById(business_id);
      if (businessObj && EXCLUDED_CLINIC_PATTERN.test(businessObj.business_name)) {
        this.logger.warn(`Skipping excluded clinic slots: ${businessObj.business_name}`);
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
          if (!EXCLUDED_CLINIC_PATTERN.test(businessName)) {
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
   * List individual appointments for a patient within an optional time window.
   * Supports active, cancelled, or both. Returns merged, de-duplicated, sorted rows.
   * Past lookback defaults to 90 days when no fromISO is provided.
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
        cancellation_reason: 50,
        cancellation_note: "Cancelled via chatbot",
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
    const cacheKey = RegionContext.get() || 'default';
    const cached = _groupsCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    const params = new URLSearchParams();
    params.append('q[]', 'show_in_online_bookings:=T');
    try {
      // Use the throwing variant so a failed clinics fetch (e.g. a 429 under
      // load) skips the cache-set below instead of caching an empty result
      // for GROUPS_CACHE_TTL_MS and masking real availability underneath it.
      const clinics = await this._getClinicsRaw();
      const results = await Promise.all(
        clinics.map(async (clinic) => {
          const url = `/businesses/${clinic.id}/practitioners?${params.toString()}`;
          console.debug(`Fetching physios : ${url}`);
          const practitioners = await new SendMessage(url, {}).get();
          return {
            clinic_id: clinic.id,
            clinic_name: clinic.business_name,
            practitioners: practitioners.practitioners || []
          };
        })
      );
      _groupsCache.set(cacheKey, { data: results, expiresAt: Date.now() + GROUPS_CACHE_TTL_MS });
      return results;
    } catch (error) {
      this.logger.error(`getPractitionersByClinic failed: ${error}`);
      return [];
    }
  }

  // Test helper — clear the groups cache between test cases.
  static _clearGroupsCache() {
    _groupsCache.clear();
    _apptTypesCache.clear();
    _practitionersForClinicCache.clear();
    _businessByIdCache.clear();
    _availableTimesCache.clear();
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

      // Skip excluded clinics (UWC, closed clinics)
      const businessObj = await this.getBusinessById(business_id);
      if (businessObj && EXCLUDED_CLINIC_PATTERN.test(businessObj.business_name)) {
        this.logger.warn(`Skipping excluded clinic slots: ${businessObj.business_name}`);
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
      let hadFetchFailure = false;
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
            // This combo silently contributes zero slots below — indistinguishable
            // from a genuine zero unless a caller checks the _partial marker set
            // on the returned array (see bottom of this method).
            hadFetchFailure = true;
          }

          if (slots.length) {
            const businessName = businessObj?.business_name || '';
            if (!EXCLUDED_CLINIC_PATTERN.test(businessName)) {
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

      // Non-enumerable so it doesn't leak into JSON.stringify(session.data) or
      // change the array's shape for existing .map()/.filter()/length callers —
      // it's an opt-in signal for callers that need to distinguish "confirmed
      // zero" from "some inner fetches failed, so this count may be short."
      if (hadFetchFailure) Object.defineProperty(allSlots, '_partial', { value: true, enumerable: false, configurable: true });
      return allSlots;
    } catch (error) {
      this.logger && this.logger.error && this.logger.error(`getAvailableSlotsByBusinessAndDate failed`, {
        business_id,
        from,
        to,
        practitioner_id: practitioner_id || null,
        error: error?.message || error?.status || error?.code || 'unknown_error'
      });
      const empty = [];
      Object.defineProperty(empty, '_partial', { value: true, enumerable: false, configurable: true });
      return empty;
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
    const cacheKey = `${RegionContext.get() || 'default'}:${businessId}`;
    const cached = _cacheGet(_businessByIdCache, cacheKey);
    if (cached) return cached;

    try {
      const url = `/businesses/${businessId}`;
      const result = await new SendMessage(url, {}).get();
      console.log('[DEBUG getBusinessById result]', result);
      // The response IS the business object, NOT { business: ... }
      if (result && result.id) {
        _cacheSet(_businessByIdCache, cacheKey, result, GROUPS_CACHE_TTL_MS);
        return result;
      }
      this.logger.warn(`No business found for businessId=${businessId}`);
      return null;
    } catch (error) {
      this.logger.error(`getBusinessById failed for ${businessId}: ${error}`);
      return null;
    }
  }

  /**
   * List patient forms with optional filters.
   * Wraps GET /patient_forms according to Cliniko API (List patient forms).
   *
   * Notes:
   * - Returns an array of patient_forms (empty array on error).
   * - Supports API-documented filters via q[] plus sort, page, per_page.
   *
   * @param {Object} [opts]
   * @param {string|number} [opts.patient_id]                 - Filter by patient_id
   * @param {string|number} [opts.patient_form_template_id]   - Filter by template id
   * @param {string|number} [opts.id]                         - Filter by id
   * @param {string}        [opts.archived_at]                - date-time (ISO)
   * @param {string}        [opts.completed_at]               - date-time (ISO)
   * @param {string}        [opts.created_at]                 - date-time (ISO)
   * @param {string}        [opts.updated_at]                 - date-time (ISO)
   * @param {string}        [opts.sort]                       - e.g., 'created_at:desc'
   * @param {number}        [opts.page]                       - page number
   * @param {number}        [opts.per_page]                   - per page [1..100]
   * @returns {Promise<Array>} patient_forms[]
   */
  async getPatientForms(opts = {}) {
    try {
      const params = new URLSearchParams();

      // Filtering via q[]
      if (opts.patient_id != null) params.append('q[]', `patient_id:=${opts.patient_id}`);
      if (opts.patient_form_template_id != null) params.append('q[]', `patient_form_template_id:=${opts.patient_form_template_id}`);
      if (opts.id != null) params.append('q[]', `id:=${opts.id}`);
      if (opts.archived_at) params.append('q[]', `archived_at:=${opts.archived_at}`);
      if (opts.completed_at) params.append('q[]', `completed_at:=${opts.completed_at}`);
      if (opts.created_at) params.append('q[]', `created_at:=${opts.created_at}`);
      if (opts.updated_at) params.append('q[]', `updated_at:=${opts.updated_at}`);

      // Sort and pagination
      if (opts.sort) params.append('sort', String(opts.sort));
      if (Number.isFinite(opts.page)) params.append('page', String(opts.page));
      if (Number.isFinite(opts.per_page)) params.append('per_page', String(Math.max(1, Math.min(100, opts.per_page))));

      const url = `/patient_forms?${params.toString()}`;
      this.logger.debug(`GET ${url}`);
      const data = await new SendMessage(url, {}).get();
      return Array.isArray(data?.patient_forms) ? data.patient_forms : [];
    } catch (error) {
      this.logger.error(`getPatientForms failed: ${error?.message || error}`);
      return [];
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
