// File: /src/core/ChatbotEngine.js

const ConversationService = require('../services/ConversationService.js');
const ClinikoAPI = require('../api/ClinikoAPI.js');
const { checkDatabaseHealth, checkAPIHealth } = require('../routes/health.js');
const SessionManager = require('./SessionManager');
const Logger = require('./Logger.js');
const axios = require('axios');

// Code Constants
const WHATSAPP_MAX_MESSAGE_LENGTH = 4096;
const WHATSAPP_SAFE_REPLY_LENGTH = 3500;
const MAX_SLOT_ITEMS = 10;
const MAX_DATE_ITEMS = 5;
const MAX_DATE_PAGES = 2; // 2 pages of 5 = 10 business days (excluding Sundays)

const REGION_SUPPORT_INFO = {
  SG: {
    phone: '+65 9111 5623',
    email: 'admin@intouchphysio.com,ramesh@prohealthasia.com'
  },
  HK: {
    phone: '+852 1235 5678',
    email: 'appt@physiohk.com,ramesh@prohealthasia.com'
  },
  IN: {
    phone: '+91 98765 43210',
    email: 'support@prohealth.in'
  },
  PH: {
    phone: '+63 912 345 6789',
    email: 'support@prohealth.ph'
  }
};

/**
 * Resolve support email recipients based on existing REGION_SUPPORT_INFO.
 * - Uses REGION_SUPPORT_INFO[region].email if available.
 * - Accepts comma-separated list in REGION_SUPPORT_INFO to support multiple recipients.
 * - Falls back to REGION_SUPPORT_INFO.SG if region is missing or not found (consistent with getSupportInfo).
 *
 * No other hardcoding or environment variables are used here.
 *
 * @param {string|undefined} region - Optional region code like 'SG','HK','IN','PH'
 * @returns {string[]} Array of unique, trimmed email addresses.
 */
function resolveSupportEmails(region) {
  const out = new Set();

  let code = 'SG';
  try {
    if (typeof region === 'string') {
      code = region.toUpperCase().trim();
      if (!code) {
        code = 'SG';
      }
    }
  } catch (e) {
    // deliberate noop
  }

  let info = {};
  try {
    if (REGION_SUPPORT_INFO && REGION_SUPPORT_INFO[code]) {
      info = REGION_SUPPORT_INFO[code];
    } else if (REGION_SUPPORT_INFO && REGION_SUPPORT_INFO.SG) {
      info = REGION_SUPPORT_INFO.SG;
    } else {
      info = {};
    }
  } catch (e) {
    info = {};
  }

  try {
    const raw = String(info.email || '');
    const parts = raw.split(',');
    for (const p of parts) {
      const v = String(p || '').trim();
      if (v) {
        out.add(v);
      }
    }
  } catch (e) {
    // deliberate noop
  }

  return Array.from(out);
}

/**
 * Parse a user-entered DOB in the format "dd mm yyyy" (lenient on separators).
 * Returns an ISO date string "YYYY-MM-DD" if valid, else null.
 *
 * Rules:
 * - Accepts separators as spaces or non-digit chars (e.g., "09 04 1987", "09-04-1987", "09/04/1987").
 * - Validates calendar date and coerces to UTC YYYY-MM-DD without time.
 * - Rejects impossible dates (e.g., 31/02/2020).
 *
 * @param {string} raw - User input for DOB.
 * @returns {string|null} YYYY-MM-DD or null if invalid.
 */
function _parseDobDdMmYyyy(raw) {
  try {
    const s = String(raw || '').trim();
    const parts = s.split(/[^0-9]+/).filter(Boolean);
    if (parts.length !== 3) return null;
    let [dd, mm, yyyy] = parts.map(p => parseInt(p, 10));
    if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;
    if (yyyy < 1900 || yyyy > 2100) return null;
    if (mm < 1 || mm > 12) return null;
    if (dd < 1 || dd > 31) return null;

    const date = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0));
    if (isNaN(date.getTime())) return null;
    if (date.getUTCFullYear() !== yyyy || (date.getUTCMonth() + 1) !== mm || date.getUTCDate() !== dd) return null;

    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  } catch {
    return null;
  }
}

/**
 * Returns the inline image attachment object for the company logo using a base64-encoded JPEG
 * loaded from either PROHEALTH_LOGO_JPEG_BASE64 (env) or PROHEALTH_LOGO_JPEG_PATH (file).
 * Keeps source code small and avoids inlining large Base64 strings.
 *
 * Resolution order:
 * - If PROHEALTH_LOGO_JPEG_BASE64 is set, use it.
 * - Else if PROHEALTH_LOGO_JPEG_PATH is set, read file contents (single-line).
 * - Else return empty content (no change to existing behavior unless configured).
 */
function _getInlineLogoAttachment() {
  const fs = require('fs');
  const envB64 = process.env.PROHEALTH_LOGO_PNG_BASE64;
  const path = process.env.PROHEALTH_LOGO_PNG_PATH;
  let base64Data = '';
  if (envB64) {
    base64Data = envB64.trim();
  } else if (path) {
    try {
      base64Data = fs.readFileSync(path, 'utf8').trim();
    } catch (_err) {

      base64Data = '';
    }
  }
  return {
    filename: 'prohealth-logo.png',
    content: base64Data,
    encoding: 'base64',
    cid: 'prohealth-logo',
    contentType: 'image/png'
  };
}

// ====== NAVIGATION HELPERS ======

/**
 * Normalize appointment type names for consistent matching and dedupe.
 * - Collapses repeated whitespace
 * - Ensures a single space before '(' and no extra space before ')'
 * - Normalizes Unicode dashes to '-'
 * - Lowercases and trims
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeTypeName(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')           // collapse multiple spaces
    .replace(/([A-Za-z])\(/g, '$1 (') // add space before '('
    .replace(/\s+\)/g, ')')        // remove space before ')'
    .replace(/[\u2010-\u2015]/g, '-') // normalize dashes
    .toLowerCase()
    .trim();
}

/**
 * Push a step entry into navigation_chain.
 * - had_multiple_options: true if user had multiple options (a real branching choice)
 * - auto: true if we auto-advanced due to a single option
 */
function navPush(data, selection_step, { had_multiple_options, auto = false } = {}) {
  if (!data.navigation_chain) data.navigation_chain = [];
  data.navigation_chain.push({
    selection_step,
    had_multiple_options: !!had_multiple_options,
    auto: !!auto
  });
}

/**
 * Pop back to the last real branching step (had_multiple_options === true).
 * Skips auto-advanced or single-option frames.
 * Returns { step, popped } where step is selection_step to return to.
 */
function navBack(data) {
  if (!Array.isArray(data.navigation_chain) || data.navigation_chain.length === 0) {
    return { step: null, popped: [] };
  }
  const popped = [];
  let frame = data.navigation_chain.pop();
  popped.push(frame);
  while (data.navigation_chain.length > 0 && (frame?.auto === true || frame?.had_multiple_options === false)) {
    frame = data.navigation_chain.pop();
    popped.push(frame);
  }
  const step = frame && frame.had_multiple_options === true ? frame.selection_step : null;
  return { step, popped };
}

/**
 * Plan forward on a step:
 * - If optionsCount === 1 and not suppressed: call onAuto(), record auto frame.
 * - If optionsCount > 1: record a multi-option frame.
 * Returns { advanced, auto } to indicate if we auto-advanced.
 */
function planForward(data, selection_step, optionsCount, onAuto) {
  let advanced = false;
  let auto = false;
  if (optionsCount === 1 && !data.suppress_auto_advance) {
    if (typeof onAuto === 'function') onAuto();
    navPush(data, selection_step, { had_multiple_options: false, auto: true });
    advanced = true;
    auto = true;
  } else if (optionsCount > 1) {
    navPush(data, selection_step, { had_multiple_options: true, auto: false });
  }
  return { advanced, auto };
}

/**
 * Map of fields to clear when stepping back across a step.
 * This avoids stale values that could re-trigger auto-advances.
 */
const CLEAR_FIELDS_BY_STEP = {
  choose_date: ['selected_date', 'appointment_type_list', 'appt_type_page', 'selected_appt_type', 'practitioner_list', 'practitioner_page', 'selected_physio', 'clinic_list', 'clinic_page', 'selected_clinic'],
  choose_type: ['selected_appt_type', 'practitioner_list', 'practitioner_page', 'selected_physio', 'clinic_list', 'clinic_page', 'selected_clinic'],
  choose_physio: ['selected_physio', 'clinic_list', 'clinic_page', 'selected_clinic', 'appt_types_for_physio', 'appt_type_page', 'selected_appt_type'],
  choose_clinic: ['selected_clinic', 'appt_types_for_physio', 'appt_type_page', 'selected_appt_type'],
  choose_appt_type: ['selected_appt_type']
};

/**
 * Clear forward state for all popped frames.
 * Ensures we do not re-render a deeper step after user presses Back.
 *
 * Why: When backing out of `choose_clinic`, leftover `clinic_list` caused
 * the physio step to immediately reprint clinics. Similarly, backing out of
 * `choose_physio` must clear practitioner pagination.
 *
 * @param {object} data - session.data object (mutable)
 * @param {Array<{selection_step:string, had_multiple_options:boolean, auto:boolean}>} popped
 */
function clearForwardStateForPopped(data, popped) {
  if (!Array.isArray(popped)) return;
  const toClear = new Set();

  // Base per-step clears from existing table if present
  if (typeof CLEAR_FIELDS_BY_STEP === 'object') {
    for (const fr of popped) {
      const fields = CLEAR_FIELDS_BY_STEP[fr.selection_step] || [];
      for (const f of fields) toClear.add(f);
    }
  }

  // Hard guards to prevent re-rendering deeper steps after Back
  for (const fr of popped) {
    if (fr.selection_step === 'choose_clinic') {
      toClear.add('selected_clinic');
      toClear.add('clinic_list');
      toClear.add('clinic_page');
    }
    if (fr.selection_step === 'choose_physio') {
      toClear.add('selected_physio');
      toClear.add('practitioner_list');
      toClear.add('practitioner_page');
    }
    if (fr.selection_step === 'choose_type') {
      toClear.add('selected_appt_type');
      toClear.add('practitioner_list');
      toClear.add('practitioner_page');
      toClear.add('clinic_list');
      toClear.add('clinic_page');
      toClear.add('selected_clinic');
    }
  }

  for (const f of toClear) delete data[f];
}

/**
 * Validates and normalizes a date search window.
 *
 * Rules:
 * - If no inputs: window is [tomorrow 00:00Z, tomorrow + (maxSpanDays-1) 23:59:59Z].
 * - If inputs provided (YYYY-MM-DD or ISO): interpret as UTC day boundaries.
 * - If both inputs point to the same calendar day (single-day search), DO NOT auto-advance to nextDay; honor the chosen day.
 * - Always clamp span to maxSpanDays based on the final 'from'.
 * - Ensure to >= from.
 *
 * Notes:
 * - This avoids shifting a user-selected single date (e.g., the 25th) forward due to UTC-based “nextDay” clamping.
 * - Keeps existing behavior for open-ended or range queries (not earlier than nextDay).
 *
 * @param {string|undefined} fromISO - 'YYYY-MM-DD' or ISO with time
 * @param {string|undefined} toISO   - 'YYYY-MM-DD' or ISO with time
 * @param {number} maxSpanDays       - maximum span (default 7)
 * @returns {{ from: string, to: string }}
 */
function normalizeDateWindow(fromISO, toISO, maxSpanDays = 7) {
  // Base "tomorrow" in UTC
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const nextDay = new Date(base);
  nextDay.setUTCDate(base.getUTCDate() + 1);

  // Helper: parse YYYY-MM-DD or ISO into Date (UTC boundaries for date-only)
  const parseDate = (s, endOfDay = false) => {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(`${s}T00:00:00Z`);
      if (endOfDay) d.setUTCHours(23, 59, 59, 999);
      return d;
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    if (endOfDay) {
      const d2 = new Date(d);
      d2.setUTCHours(23, 59, 59, 999);
      return d2;
    }
    return d;
  };

  // Helper: format yyyy-mm-dd in UTC
  const toISODate = (d) => {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  // Initial parse
  let from = fromISO ? parseDate(fromISO, false) : null;
  let to = toISO ? parseDate(toISO, true) : null;

  // No inputs → default to tomorrow window
  if (!from && !to) {
    const fromDef = new Date(nextDay);
    const toDef = new Date(nextDay);
    toDef.setUTCDate(toDef.getUTCDate() + (maxSpanDays - 1));
    toDef.setUTCHours(23, 59, 59, 999);
    return {
      from: `${toISODate(fromDef)}T00:00:00Z`,
      to: `${toISODate(toDef)}T23:59:59Z`
    };
  }

  // If only one side provided, derive the other respecting maxSpanDays
  if (from && !to) {
    to = new Date(from);
    to.setUTCDate(to.getUTCDate() + (maxSpanDays - 1));
    to.setUTCHours(23, 59, 59, 999);
  } else if (!from && to) {
    from = new Date(to);
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - (maxSpanDays - 1));
  }

  // Fallback safety
  if (!from) from = new Date(nextDay);
  if (!to) {
    to = new Date(from);
    to.setUTCDate(to.getUTCDate() + (maxSpanDays - 1));
    to.setUTCHours(23, 59, 59, 999);
  }

  // Normalize to UTC day boundaries
  let finalFrom = new Date(`${toISODate(from)}T00:00:00Z`);
  let finalTo = new Date(`${toISODate(to)}T23:59:59Z`);

  // Detect explicit single-day request (same date strings provided)
  const explicitSingleDay =
    !!fromISO && !!toISO &&
    /^\d{4}-\d{2}-\d{2}$/.test(fromISO) &&
    /^\d{4}-\d{2}-\d{2}$/.test(toISO) &&
    fromISO === toISO;

  // Apply "not earlier than nextDay" only for non-explicit single-day ranges
  if (!explicitSingleDay) {
    if (finalFrom < nextDay) finalFrom = new Date(nextDay);
    if (finalTo < finalFrom) finalTo = new Date(finalFrom);
  } else {
    // Single day: ensure end >= start on that day
    if (finalTo < finalFrom) finalTo = new Date(finalFrom);
  }

  // Clamp span to maxSpanDays relative to finalFrom
  const maxTo = new Date(finalFrom);
  maxTo.setUTCDate(finalFrom.getUTCDate() + (maxSpanDays - 1));
  if (finalTo > maxTo) finalTo = maxTo;

  return {
    from: `${toISODate(finalFrom)}T00:00:00Z`,
    to: `${toISODate(finalTo)}T23:59:59Z`
  };
}

/**
 * Build a unique list of all practitioners from the grouped array returned by getPractitionersByClinic.
 * @param {Array<{clinic_id: string, clinic_name: string, practitioners: Array<Object>}>} groups
 * @returns {Array<Object>} Array of unique practitioner objects.
 */
function uniquePractitionersFromGroups(groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const p of group.practitioners) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        result.push(p);
      }
    }
  }
  return result;
}

/**
 * Build a deduplicated list of all appointment types offered by all practitioners.
 * @param {ClinikoAPI} clinikoAPI
 * @param {Array<{clinic_id: string, clinic_name: string, practitioners: Array<Object>}>} groups
 * @returns {Promise<Array<Object>>} Array of unique appointment type objects.
 */
async function getAllAppointmentTypesForAllPractitioners(clinikoAPI, groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const p of group.practitioners) {
      const types = await clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
      for (const t of types) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          result.push(t);
        }
      }
    }
  }
  return result;
}

/**
 * Return all unique practitioners who offer the given appointment type ID.
 *
 * Why: Cliniko may return numeric or string IDs. Strict equality causes
 * false negatives. Compare IDs as strings to avoid dropping valid matches.
 *
 * @param {Array<{clinic_id: string, clinic_name: string, practitioners: Array<Object>}>} groups
 * @param {ClinikoAPI} clinikoAPI
 * @param {string|number} apptTypeId
 * @returns {Promise<Array<Object>>}
 */

async function getPractitionersForType(groups, clinikoAPI, apptTypeId) {
  const targetId = String(apptTypeId);
  const seen = new Set();
  const result = [];
  for (const group of (groups || [])) {
    for (const p of (group.practitioners || [])) {
      if (seen.has(p.id)) continue;
      const types = await clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
      if ((types || []).some(t => String(t.id) === targetId)) {
        seen.add(p.id);
        result.push(p);
      }
    }
  }
  return result;
}

/**
 * Return all practitioners who offer an appointment type by NAME.
 * Why: Type IDs differ per practitioner for the same label, so ID match is insufficient.
 *
 * @param {Array<{clinic_id: string, clinic_name: string, practitioners: Array<Object>}>} groups
 * @param {ClinikoAPI} clinikoAPI
 * @param {string} apptTypeName
 * @returns {Promise<Array<Object>>}
 */
async function getPractitionersForTypeName(groups, clinikoAPI, apptTypeName) {
  const normalize = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-') // normalize dashes
    .replace(/\s+/g, ' ')              // collapse spaces
    .trim();

  const target = normalize(apptTypeName);
  const seen = new Set();
  const result = [];

  for (const group of groups || []) {
    for (const p of group.practitioners || []) {
      if (seen.has(p.id)) continue;
      const types = await clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
      if ((types || []).some(t => normalize(t.name) === target)) {
        seen.add(p.id);
        result.push(p);
      }
    }
  }
  return result;
}

/**
 * Returns support info string for the given region code.
 * Defaults to SG if region not found.
 * @param {string} region
 * @returns {string}
 */
function getSupportInfo(region) {
  const info = REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG;
  return `Need help? Call us at ${info.phone} or email ${info.email}`;
}

function formatSlotItem(slot, idx, opts = {}) {
  const dt = new Date(slot.slot);
  return `${idx}. ${dt.toLocaleString('en-GB')}`;
}

/**
 * Extracts the Cliniko ID from a reference object.
 * @param {object} obj - Cliniko reference object.
 * @param {string} type - Resource type (e.g., 'businesses').
 * @returns {string|undefined}
 */
function extractIdFromClinikoRef(obj, type) {
  if (!obj) return undefined;
  if (obj.id) return obj.id;
  const url = obj.links?.self;
  if (url) {
    const parts = url.split('/');
    const idx = parts.findIndex(p => p === type);
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    return parts[parts.length - 1];
  }
  return undefined;
}

/**
 * Converts a slot object to the shape expected by enrichAppointmentsForDisplay.
 * Ensures starts_at is set for enrichment.
 * @param {object} slot
 * @returns {object}
 */
function slotToEnrichable(slot) {
  // Defensive: support both slot.slot and slot.starts_at
  return {
    ...slot,
    starts_at: slot.slot || slot.starts_at, // This is the critical missing field!
    business: { id: slot.business_id },
    practitioner: { id: slot.practitioner_id },
    appointment_type: { id: slot.appointment_type_id }
  };
}

function deduplicateSlots(slots) {
  const seen = new Set();
  return slots.filter(slot => {
    const key = `${slot.practitioner_id}|${slot.business_id}|${slot.slot}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Returns a displayable practitioner name from a practitioner object.
 * @param {Object|null|undefined} practitioner
 * @returns {string}
 */
function getPractitionerDisplayName(practitioner) {
  if (!practitioner) return 'Practitioner';
  if (practitioner.display_name) return practitioner.display_name;
  if (practitioner.first_name || practitioner.last_name)
    return [practitioner.first_name, practitioner.last_name].filter(Boolean).join(' ');
  return 'Practitioner';
}

/**
 * Returns a displayable appointment type name from an appointment type object.
 * @param {Object|null|undefined} apptType
 * @returns {string}
 */
function getAppointmentTypeDisplayName(apptType) {
  if (!apptType) return 'Appointment';
  if (apptType.name) return apptType.name;
  return 'Appointment';
}

/**
 * Returns a displayable business name from a business object.
 * @param {Object|null|undefined} business
 * @returns {string}
 */
function getBusinessDisplayName(business) {
  if (!business) return '';
  return business.business_name || business.display_name || '';
}

/**
 * Enriches appointments with display fields (_practitioner_display, _appointment_type_display, etc.)
 * by fetching all relevant related objects in parallel.
 * @param {Array<Object>} appointments
 * @param {ClinikoAPI} clinikoAPI
 * @returns {Promise<Array<Object>>} Enriched appointments
 */
async function enrichAppointmentsForDisplay(appointments, clinikoAPI) {
  const practitionerIds = new Set();
  const apptTypeIds = new Set();
  const businessIds = new Set();

  // Single consolidated log for incoming appointments
  if (appointments.length > 0) {
    console.log(`[ENRICH] Processing ${appointments.length} appointments`);
  }

  // Collect IDs
  for (const appt of appointments) {
    const practitionerId = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const apptTypeId = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    const businessId = extractIdFromClinikoRef(appt.business, 'businesses');

    if (practitionerId) practitionerIds.add(practitionerId);
    if (apptTypeId) apptTypeIds.add(apptTypeId);
    if (businessId) businessIds.add(businessId);
  }

  // Single log for what we're fetching
  console.log(`[ENRICH] Fetching: ${practitionerIds.size} practitioners, ${apptTypeIds.size} types, ${businessIds.size} businesses`);

  // Fetch all entities in parallel
  const [practitioners, apptTypes, businesses] = await Promise.all([
    Promise.all([...practitionerIds].map(id => clinikoAPI.getPractitionerById(id).then(obj => [id, obj]))),
    Promise.all([...apptTypeIds].map(id => clinikoAPI.getAppointmentTypeById(id).then(obj => [id, obj]))),
    Promise.all([...businessIds].map(id => clinikoAPI.getBusinessById(id).then(obj => [id, obj])))
  ]);

  const practitionerMap = Object.fromEntries(practitioners);
  const apptTypeMap = Object.fromEntries(apptTypes);
  const businessMap = Object.fromEntries(businesses);

  // Only log if there were fetch failures
  const missingPractitioners = [...practitionerIds].filter(id => !practitionerMap[id]);
  const missingTypes = [...apptTypeIds].filter(id => !apptTypeMap[id]);
  const missingBusinesses = [...businessIds].filter(id => !businessMap[id]);
  
  if (missingPractitioners.length > 0 || missingTypes.length > 0 || missingBusinesses.length > 0) {
    console.warn('[ENRICH] Missing entities:', {
      practitioners: missingPractitioners,
      types: missingTypes,
      businesses: missingBusinesses
    });
  }

  // Enrich appointments
  for (const appt of appointments) {
    const practitionerId = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const apptTypeId = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    const businessId = extractIdFromClinikoRef(appt.business, 'businesses');

    const practitionerObj = practitionerMap[practitionerId] || null;
    const apptTypeObj = apptTypeMap[apptTypeId] || null;
    const businessObj = businessMap[businessId] || null;

    appt._practitioner_display = getPractitionerDisplayName(practitionerObj);
    appt._appointment_type_display = getAppointmentTypeDisplayName(apptTypeObj);
    appt._business_display = getBusinessDisplayName(businessObj);
    appt._display_dt = new Date(appt.starts_at).toLocaleString('en-GB');
  }

  // Single summary log at the end
  console.log(`[ENRICH] Completed enrichment for ${appointments.length} appointments`);
  
  return appointments;
}

/**
 * Paginate and format a list of options for WhatsApp reply.
 * @param {Array} items - Array of objects to present (slots, physios, clinics, etc.)
 * @param {function} formatFn - Function that returns string for each item (item, idx) => string
 * @param {number} [page=0] - Page number (0-based)
 * @param {number} [pageSize=MAX_SLOT_ITEMS] - Items per page
 * @param {string} [moreLabel='M. More'] - Label for "more" option
 * @param {string} [header=''] - Optional header/title for the list
 * @returns {string} WhatsApp-safe paginated list
 */
function formatPaginatedList({
  items,
  formatFn,
  page = 0,
  pageSize = MAX_SLOT_ITEMS,
  moreLabel = 'M. More',
  header = ''
}) {
  if (!Array.isArray(items)) return '';
  const start = page * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  let text = pageItems.map((item, idx) => formatFn(item, idx + 1 + start)).join('\n');
  if (items.length > start + pageSize) text += `\n${moreLabel}`;
  let reply = header ? header + '\n\n' + text : text;
  if (reply.length > WHATSAPP_SAFE_REPLY_LENGTH) {
    reply = reply.slice(0, WHATSAPP_SAFE_REPLY_LENGTH - 50) + "\n\n[Reply 'M' for more]";
  }
  return reply;
}

/**
 * Format a slot object for display in slot lists.
 * Omit practitioner_name and/or business_name if already selected.
 * @param {Object} slot
 * @param {number} idx - 1-based index for display
 * @param {Object} [opts] - { omitPhysio, omitClinic }
 * @returns {string}
 */
/*
function formatSlotItem(slot, idx, opts = {}) {
  const dt = new Date(slot.slot);
  let main = [];
  if (!opts.omitPhysio && slot.practitioner_name) main.push(slot.practitioner_name);
  if (!opts.omitClinic && slot.business_name) main.push(slot.business_name);
  if (slot.appointment_type_name) main.push(slot.appointment_type_name);
  return `${idx}. ${main.join(' — ')}\n   ${dt.toLocaleString('en-GB')}`;
}
*/

/**
 * Format a physiotherapist for display in physio lists.
 * @param {Object} physio
 * @param {number} idx - 1-based index for display
 * @returns {string}
 */
function formatPhysioItem(physio, idx) {
  const name = `${physio.first_name || ''} ${physio.last_name || ''}`.trim() || physio.display_name;
  return `${idx}. ${name}${physio.specialization ? ' - ' + physio.specialization : ''}`;
}

/**
 * Get the next available appointment dates, skipping Sundays.
 * @param {Date} [startFrom=new Date()] - Date to start from (not included)
 * @param {number} [count=MAX_DATE_ITEMS] - Number of dates to return
 * @param {number} [maxDays=14] - How many days max to look ahead
 * @returns {Date[]}
 */
function getNextAvailableDates(startFrom = new Date(), count = MAX_DATE_ITEMS, maxDays = 14) {
  const result = [];
  let date = new Date(startFrom);
  let added = 0;
  let checked = 0;
  while (added < count && checked < maxDays) {
    if (date.getDay() !== 0) { // 0 = Sunday
      result.push(new Date(date));
      added++;
    }
    date.setDate(date.getDate() + 1);
    checked++;
  }
  return result;
}
/**
 * Main Chatbot conversation engine for WhatsApp/Cliniko integration.
 */
class ChatbotEngine {
  constructor() {
    this.sessionManager = new SessionManager();
    this.clinikoAPI = new ClinikoAPI();
    this.logger = new Logger('ChatbotEngine');
    this.isInitialized = false;
    this.STATES = {
      INTRO: 'INTRO',
      VERIFY: 'VERIFY',
      BOOK_MANAGE_OPTIONS: 'BOOK_MANAGE_OPTIONS',
      BOOKING_METHOD_OPTIONS: 'BOOKING_METHOD_OPTIONS',
      BOOK_HISTORY: 'BOOK_HISTORY',
      BOOK_SOONEST: 'BOOK_SOONEST',
      BOOK_SPECIFIC_DATE: 'BOOK_SPECIFIC_DATE',
      BOOK_SPECIFIC_PHYSIO: 'BOOK_SPECIFIC_PHYSIO',
      BOOK_SPECIFIC_CLINIC: 'BOOK_SPECIFIC_CLINIC',
      SELECT_SLOT: 'SELECT_SLOT',
      CONFIRM_BOOKING: 'CONFIRM_BOOKING',
      CANCEL_APPOINTMENT: 'CANCEL_APPOINTMENT',
      SELECT_APPOINTMENT_TO_CANCEL: 'SELECT_APPOINTMENT_TO_CANCEL',
      CONFIRM_CANCEL: 'CONFIRM_CANCEL',
      RESCHEDULE_APPOINTMENT: 'RESCHEDULE_APPOINTMENT',
      SELECT_APPOINTMENT_TO_RESCHEDULE: 'SELECT_APPOINTMENT_TO_RESCHEDULE',
      CONFIRM_RESCHEDULE: 'CONFIRM_RESCHEDULE',
      VIEW_FEES: 'VIEW_FEES',
      VIEW_LOCATIONS: 'VIEW_LOCATIONS',
      REGISTER_PATIENT: 'REGISTER_PATIENT',
      FALLBACK: 'FALLBACK',
    };
    this.stateHandlers = {};
    this.initializeFlows();
  }

  /**
   * Returns the region code for this session, or 'SG' if not set.
   * @param {object} session
   * @returns {string}
   */
  _getSessionRegion(session) {
    let context = session.context;
    if (context && typeof context === 'string') {
      try { 
        context = JSON.parse(context);
      } catch (error) {
        this.logger.error('Failed to initialize region for session:', error);
      }
    }
    return (context && context.region) || 'SG';
  }

  /**
   * Unified error message with menu and support info.
   * @param {object} session
   */
  async renderErrorWithMenu(session) {
    let menu = '';
    if (session && session.verified) {
      menu = await this.renderMainMenu(session);
    }
    return (
      "We encountered an unexpected error processing your request. " +
      "You can continue using the menu below, or contact support if the issue persists.\n\n" +
      menu +
      "\n\n" + getSupportInfo(this._getSessionRegion(session))
    );
  }

  /**
   * Initialize session manager and mark engine as initialized.
   */
  async initialize() {
    try {
      await this.sessionManager.initialize();
      this.isInitialized = true;
      this.logger.info('ChatbotEngine initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize ChatbotEngine:', error);
      throw error;
    }
  }

  /**
   * Register all state handlers for the chatbot state machine.
   */
  initializeFlows() {
    this.stateHandlers = {
      [this.STATES.INTRO]: this.handleIntroState.bind(this),
      [this.STATES.VERIFY]: this.handleVerifyState.bind(this),
      [this.STATES.BOOK_MANAGE_OPTIONS]: this.handleBookManageOptions.bind(this),
      [this.STATES.BOOKING_METHOD_OPTIONS]: this.handleBookingMethodOptions.bind(this),
      [this.STATES.BOOK_HISTORY]: this.handleBookHistory.bind(this),
      [this.STATES.BOOK_SOONEST]: this.handleBookSoonest.bind(this),
      [this.STATES.BOOK_SPECIFIC_DATE]: this.handleBookSpecificDate.bind(this),
      [this.STATES.BOOK_SPECIFIC_PHYSIO]: this.handleBookSpecificPhysio.bind(this),
      [this.STATES.BOOK_SPECIFIC_CLINIC]: this.handleBookSpecificClinic.bind(this),
      [this.STATES.SELECT_SLOT]: this.handleSelectSlotState.bind(this),
      [this.STATES.CONFIRM_BOOKING]: this.handleConfirmBookingState.bind(this),
      [this.STATES.CANCEL_APPOINTMENT]: this.handleCancelAppointmentState.bind(this),
      [this.STATES.SELECT_APPOINTMENT_TO_CANCEL]: this.handleSelectAppointmentToCancelState.bind(this),
      [this.STATES.CONFIRM_CANCEL]: this.handleConfirmCancelState.bind(this),
      [this.STATES.RESCHEDULE_APPOINTMENT]: this.handleRescheduleAppointmentState.bind(this),
      [this.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE]: this.handleSelectAppointmentToRescheduleState.bind(this),
      [this.STATES.CONFIRM_RESCHEDULE]: this.handleConfirmRescheduleState.bind(this),
      [this.STATES.VIEW_FEES]: this.handleViewFeesState.bind(this),
      [this.STATES.VIEW_LOCATIONS]: this.handleViewLocationsState.bind(this),
      [this.STATES.REGISTER_PATIENT]: this.handleRegisterPatientState.bind(this),
      [this.STATES.FALLBACK]: this.handleFallbackState.bind(this),
    };
  }

  // ====== MENU RENDER HELPERS ======

  /**
   * Sets the appropriate menu state and renders the main menu.
   * @param {object} session
   * @returns {Promise<string>}
   */
  async goToInteractiveMenu(session) {
    // Always get the latest session state from DB
    const updatedSession = await this.sessionManager.getSession(session.id);

    if (!updatedSession.verified) {
      await this.sessionManager.updateSession(updatedSession.id, { conversation_state: this.STATES.INTRO });
      const fresh = await this.sessionManager.getSession(updatedSession.id);
      return await this.renderMainMenu(fresh);
    }

    if (updatedSession.conversation_state === this.STATES.BOOKING_METHOD_OPTIONS) {
      return await this.renderBookingMethodMenu(updatedSession);
    }
    // Add more as needed (manage, cancel, etc.)
    // Falling through here
    await this.sessionManager.updateSession(updatedSession.id, { conversation_state: this.STATES.BOOK_MANAGE_OPTIONS });
    const fresh = await this.sessionManager.getSession(updatedSession.id);
    return await this.renderMainMenu(fresh);
  }

  /**
   * Render the booking method submenu.
   * Region-aware: suppress "Clinic" (5) in SG.
   */
  async renderBookingMethodMenu(session) {
    // Determine region
    let regionCode = 'SG';
    try {
      const ctx = typeof session.context === 'string'
        ? JSON.parse(session.context || '{}')
        : (session.context || {});
      regionCode = String((ctx && ctx.region) || 'SG').toUpperCase();
      this.logger.debug('handleRender: Ramesh', { ctx, regionCode });
    } catch {
      regionCode = 'SG';
    }

    this.logger.debug('handleRender1: Ramesh', { regionCode });
    this.logger.debug('handleRender1: Ramesh', (regionCode!=='SG'));
    const lines = [
      'How would you like to book?',
      '1. Based on your last physio visit',
      '2. Soonest available appointment',
      '3. Specific date',
      '4. Specific physiotherapist',
    ];
    if (regionCode !== 'SG') {
      lines.push('5. Specific clinic');
    }
    lines.push('');
    lines.push('Reply 0 to go back.');

    return lines.join('\n');
  }

  /**
    Render the correct main menu based on verification and region.
    Always shows the current region (if set) and a hint to change it.
    @param {object} session
    @returns {Promise<string>}
  */
  async renderMainMenu(session) {
    // Get region from context (parse string if needed)
    let region = '';
    let showLocations = false;
    let context = session.context;
    this.logger.debug('handleIntro : Ramesh', { context });
    if (context && typeof context === 'string') {
      try { 
        context = JSON.parse(context); 
      } catch (error) {
        this.logger.error('renderMainMenu error:', error);
      }
    }
    if (context && context.region) {
      const regionLabels = {
        HK: 'Hong Kong 🇭🇰',
        SG: 'Singapore 🇸🇬',
        IN: 'India 🇮🇳',
        PH: 'Philippines 🇵🇭'
      };
      this.logger.debug('handleIntro : Ramesh', { context });
      const code = String(context.region).toUpperCase();  // normalize
      if (regionLabels[code]) {
        region = `🌏 *Your region*: ${regionLabels[code]}\n`;
        showLocations = (code !== 'SG');
      }
    }

    if (session.verified) {
      return (
        `${region}` +
        `What would you like to do?\n\n` +
        `1️⃣ Book Appointment\n` +
        `2️⃣ Cancel Appointment\n` +
        `3️⃣ Reschedule Appointment\n` +
        `9️⃣ Logout & Delete Data\n\n` +
        `Type "region" anytime to change region.\n` +
        `Reply with the number or a keyword.`
      );
    } else {
      const lines = [
        `👋 *Welcome to Prohealth Asia*`,
        ``,
        `${region}`.trim(),
        `Please select an option:`,
        `1️⃣ Existing Clients: Book or Manage Appointments`,
        `2️⃣ New Clients: Book or Manage Appointments`,
        `3️⃣ View Fees`,
        ...(showLocations ? [`4️⃣ View Locations`] : []),
        ``,
        `Type "region" anytime to change region.`,
        `Reply with the number or a keyword.`
      ];
      const body = lines.filter((l, i) => !(l === '' && (i === 0 || lines[i - 1] === ''))).join('\n');
      return body;
      /*
      return (
        `👋 *Welcome to Prohealth Asia*\n\n` +
        `${region}` +
        `Please select an option:\n` +
        `1️⃣ Book or Manage Appointment\n` +
        `2️⃣ View Fees\n` +
        `3️⃣ View Locations\n` +
        `4️⃣ Register as New Patient\n\n` +
        `Type "region" anytime to change region.\n` +
        `Reply with the number or a keyword.`
      );
      */
    }
  }
 
  // ====== MAIN ENTRY POINT ======
  
  /**
   * Bind session region for downstream Cliniko calls in this message cycle.
   * Defaults to 'SG' when session has no region.
   */
  async withSessionRegion(session, fn) { // class method
    const context = (typeof session?.context === 'string')
      ? (() => { try { return JSON.parse(session.context); } catch { return {}; } })()
      : (session?.context || {});
    const region = (context && context.region) ? String(context.region).toUpperCase() : 'SG';
    const RegionContext = require('../core/RegionContext');
    return RegionContext.run(region, fn);
  }


  /**
   * Main entry point: handle a message for a phone number.
   * @param {string} message
   * @param {string} phoneNumber
   */
  async handleMessage(message, phoneNumber) {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      this.logger.debug('Handling message:', { message, phoneNumber });
      let session = await this.sessionManager.getOrCreateSession(phoneNumber);
      if (!session) {
        this.logger.warn(`Failed to create session for ${phoneNumber}`);
        return 'Sorry, there was an issue starting your session. Please try again.';
      }
      // If first message, always start at INTRO unless already set
      if (!session.conversation_state) {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.INTRO
        });
        session.conversation_state = this.STATES.INTRO;
      }
      const currentState = session.conversation_state || this.STATES.INTRO;
      if (!this.stateHandlers[currentState]) {
        return await this.handleFallbackState(session, message);
      }

      // 🔐 Region-binding wrapper: all downstream Cliniko calls use the session's region
      const response = await this.withSessionRegion(session, async () => {
        return await this.stateHandlers[currentState](session, message);
      });

      if (session.id) {
        await this.sessionManager.db.addChatHistory(session.id, message, response);
      }
      return response;
    } catch (error) {
      this.logger.error('handleMessage error', { stack: error.stack, message: error.message, error });
      let session;
      try {
        session = await this.sessionManager.getSessionByPhone?.(phoneNumber);
      } catch {}
      if (session) {
        return await this.renderErrorWithMenu(session);
      }
      return (
          "We're currently experiencing a technical issue and could not start your session. " +
          "Please try again later. If the problem continues, " +
        getSupportInfo(this._getSessionRegion(session))
      );
    }
  }


  // ====== STATE HANDLERS ======

  /**

  Handle the intro state (first message), including region detection and selection.
  If region can be detected from phone, set as default.
  If not, prompt user to select.
  User can type "region" anytime to change region.
  All menu rendering is delegated to renderMainMenu.
  @param {object} session
  @param {string} message
  @returns {Promise<string>}
  */
  async handleIntroState(session, message) {
    const regionLabels = {
      HK: 'Hong Kong 🇭🇰',
      SG: 'Singapore 🇸🇬',
      IN: 'India 🇮🇳',
      PH: 'Philippines 🇵🇭'
    };
    const regionCodes = Object.keys(regionLabels);

    // Parse context safely
    let context = (session.context && typeof session.context === 'string')
      ? JSON.parse(session.context)
      : (session.context || {});
    const text = (message || '').trim().toLowerCase();

    // Logout: clear PII but PRESERVE region
    if (text === '9' || text.includes('logout')) {
      // Keep region if present
      let existingCtx = {};
      let region = '';
      try {
        existingCtx = (typeof session.context === 'string')
          ? JSON.parse(session.context || '{}')
          : (session.context || {});
        this.logger.debug('handleOut : Ramesh', { existingCtx });
      } catch {
        existingCtx = {};
      }
      const newCtx = {};
      newCtx.region = (existingCtx.region || region);
      // Clear PII-only bits

      // Wipe data + patient/verified; keep region
      await this.sessionManager.deleteSessionAndData(session.id);
      const fresh = await this.sessionManager.getOrCreateSession(session.phone_number || session.phoneNumber, true);
      // Ensure flags are reset and region is preserved
      await this.sessionManager.updateSession(fresh.id, {
        verified: false,
        patient_id: null,
        conversation_state: this.STATES.INTRO,
        data: null,
        context: JSON.stringify(newCtx)
      });
      const menu = await this.goToInteractiveMenu(fresh);
      return '✅ All your data has been deleted and you are logged out.\n\n' + menu;
    }
    /*
      await this.sessionManager.deleteSessionAndData(session.id);
      const fresh = await this.sessionManager.getOrCreateSession(session.phone_number || session.phoneNumber, true);
      // Force clean flags
      await this.sessionManager.updateSession(fresh.id, { verified: false, patient_id: null, conversation_state: this.STATES.INTRO, data: null, context: JSON.stringify({}) });
      return '✅ All your data has been deleted and you are logged out.\n\n' +
             (await this.goToInteractiveMenu(fresh));
    }
    */ 

    // If region not set, try auto-detect
    if (!context.region) {
      const phone = session.phone_number || session.phoneNumber;
      if (typeof this.sessionManager.getRegionFromPhoneNumber === 'function') {
        const info = this.sessionManager.getRegionFromPhoneNumber(phone);
        if (info && info.region && regionLabels[info.region]) {
          context.region = info.region;
          await this.sessionManager.updateSession(session.id, { context });
        }
      }
    }

    // If region not set or user typed "region", show region selection menu
    if (!context.region || text === 'region' || text === 'change region' || context.awaiting_region_selection) {
      context.awaiting_region_selection = true;
      // Handle selection input
      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        if (idx >= 0 && idx < regionCodes.length) {
          context.region = regionCodes[idx];
          delete context.awaiting_region_selection;
          await this.sessionManager.updateSession(session.id, { context });
          // Return main menu immediately after setting region
          return await this.renderMainMenu(session);
        }
      } else if (regionCodes.some(code => text.includes(regionLabels[code].toLowerCase()))) {
        const found = regionCodes.find(code => text.includes(regionLabels[code].toLowerCase()));
        context.region = found;
        delete context.awaiting_region_selection;
        await this.sessionManager.updateSession(session.id, { context });
        // Return main menu immediately after setting region
        return await this.renderMainMenu(session);
      }

      if (!context.region || context.awaiting_region_selection) {
        const menu = regionCodes.map((code, i) => `${i + 1}. ${regionLabels[code]}`).join('\n');
        await this.sessionManager.updateSession(session.id, { context });
        return `Please select your region:\n\n${menu}\n\nReply with the number.`;
      }
    }

    // From here, region is set. Proceed with your existing menu logic, using renderMainMenu.
    if (session.verified) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS
      });
      return await this.renderMainMenu(session);
    }

    if (!text || ['menu', 'hi', 'hello', 'hey', '0', 'back'].includes(text)) {
      return await this.renderMainMenu(session);
    }
    if (text === '1' || text.includes('book') || text.includes('manage')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VERIFY,
        verified: false
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleVerifyState(updatedSession, '');
    }
    if (text === '3' || text.includes('fee')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VIEW_FEES
      });
      return await this.handleViewFeesState(session, '');
    }
    if (text === '4' || text.includes('location')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VIEW_LOCATIONS
      });
      return await this.handleViewLocationsState(session, '');
    }
    if (text === '2' || text.includes('register')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.REGISTER_PATIENT
      });
      return await this.handleRegisterPatientState(session, '');
    }
    return `Sorry, I didn't understand that.\n\n` +
      await this.renderMainMenu(session);
  }

  /**
   * Handle fallback for any unknown state or invalid input.
   * @param {object} session
   * @param {string} message
   */
  async handleFallbackState(session, message) {
    return `I'm sorry, I didn't understand that.\n\n` + await this.goToInteractiveMenu(session);
  }

  /**
   * Handle user identity verification (email + DOB).
   * Flow:
   *   1) Prompt for email
   *   2) Prompt for DOB (dd mm yyyy)
   *   3) Verify via ClinikoAPI.findPatientByEmailAndDob
   *
   * Navigation:
   *   - "0/menu/back" => Intro + renderMainMenu
   *   - On failure => 3-option fail prompt:
   *        1. Try again
   *        2. Have someone reach out
   *        3. Go to main menu
   *     Stored as data.verify_error_prompt = true to route follow-up input.
   */
  async handleVerifyState(session, message) {
    // Safe parse session.data
    let data = {};
    try {
      data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    } catch { data = {}; }

    const textRaw = (message || '').trim();
    const text = textRaw.toLowerCase();

    // Back/menu at any time -> Intro + main menu
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      const updated = await this.sessionManager.getSession(session.id);
      return await this.renderMainMenu(updated);
    }

    // If we're in the fail-prompt branch, process 1/2/3
    if (data.verify_error_prompt === true) {
      if (text === '1') {
        // Try again: clear verify state and restart flow at email
        delete data.verify_error_prompt;
        delete data.verify_email;
        delete data.verify_dob;
        delete data.awaiting_dob;
        delete data.awaiting_email;
        data.awaiting_email = true;
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: JSON.stringify(data) });
        return 'To verify your identity, please enter the email address you used to register with us.\n\n(0️⃣ Back to menu)';
      }

      if (text === '2') {
        // Have support reach out: send support email with minimal context and go to verified main menu (or intro)
        try {
          const sessionRow = await this.sessionManager.getSession(session.id);
          // Reuse existing generic "no slots/contact" composer for outreach
          if (typeof this._composeSupportEmailPayloadNoSlots === 'function' && typeof this._postEmail === 'function') {
            const payload = await this._composeSupportEmailPayloadNoSlots(sessionRow, { reason: 'Verification failed: user requested outreach.' });
            if (payload && Array.isArray(payload.to) && payload.to.length) {
              await this._postEmail(payload);
            }
          }
        } catch (e) {
          // noop
        }
        // Clear prompt state and return to main menu (Intro, since not verified)
        delete data.verify_error_prompt;
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, data: JSON.stringify(data) });
        const updated = await this.sessionManager.getSession(session.id);
        return 'Thanks. Our support team will reach out shortly.\n\n' + await this.renderMainMenu(updated);
      }

      if (text === '3') {
        // Go to main menu
        delete data.verify_error_prompt;
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, data: JSON.stringify(data) });
        const updated = await this.sessionManager.getSession(session.id);
        return await this.renderMainMenu(updated);
      }

      // Unknown input → reprint the fail prompt
      return (
        "We couldn't verify those details.\n\n" +
        "1. Try again\n" +
        "2. Have someone reach out\n" +
        "3. Go to main menu\n\n" +
        "(Reply 1, 2, or 3. 0️⃣ Back)"
      );
    }

    // Step 1: ask for email
    if (!data.verify_email) {
      if (!data.awaiting_email) {
        data.awaiting_email = true;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return 'To verify your identity, please enter the email address you used to register with us.\n\n(0️⃣ Back to menu)';
      }
      // Validate email input
      const email = textRaw.trim().toLowerCase();
      if (!email.includes('@') || !email.includes('.')) {
        return 'That doesn\'t look like a valid email. Please enter a valid email address to proceed.\n\n(0️⃣ Back to menu)';
      }
      data.verify_email = email;
      delete data.awaiting_email;
      data.awaiting_dob = true;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Please enter your date of birth in the format: dd mm yyyy (e.g., 09 04 1987).\n\n(0️⃣ Back to menu)';
    }

    // Step 2: ask for DOB
    if (!data.verify_dob) {
      if (!textRaw) {
        return 'Please enter your date of birth in the format: dd mm yyyy (e.g., 09 04 1987).\n\n(0️⃣ Back to menu)';
      }
      const parsed = _parseDobDdMmYyyy(textRaw);
      if (!parsed) {
        return 'That doesn\'t look like a valid date. Please enter your date of birth as dd mm yyyy (e.g., 09 04 1987).\n\n(0️⃣ Back to menu)';
      }
      data.verify_dob = parsed; // YYYY-MM-DD
      delete data.awaiting_dob;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    }

    // Step 3: verify with API (email + dob)
    const emailToFind = data.verify_email;
    const dobToFind = data.verify_dob; // YYYY-MM-DD

    try {
      // New API method that prefers exact match and falls back email-only internally
      const patient = await this.clinikoAPI.findPatientByEmailAndDob(emailToFind, dobToFind);

      // Clean transient verify state before branching
      const cleared = { ...data };
      delete cleared.awaiting_email;
      delete cleared.awaiting_dob;
      delete cleared.verify_email;
      delete cleared.verify_dob;

      if (patient && patient.id) {
        try {
          if (typeof this.saveEmailToSessionContext === 'function') {
            await this.saveEmailToSessionContext(session, emailToFind);
          }
        } catch {}
        await this.sessionManager.updateSession(session.id, {
          verified: true,
          patient_id: patient.id,
          conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
          data: JSON.stringify(cleared)
        });
        const updated = await this.sessionManager.getSession(session.id);
        return 'Verification successful!\n\n' + await this.goToInteractiveMenu(updated);
      }

      // Failure → show 3-option fail prompt
      cleared.verify_error_prompt = true;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: JSON.stringify(cleared) });

      const region = this._getSessionRegion(session);
      const support = getSupportInfo(region);
      return (
        "We couldn't verify those details. Please check your email and date of birth and try again, or contact support for assistance.\n\n" +
        support + "\n\n" +
        "1. Try again\n" +
        "2. Have someone reach out\n" +
        "3. Go to main menu\n\n" +
        "(Reply 1, 2, or 3. 0️⃣ Back)"
      );
    } catch (e) {
      // API error → same fail prompt
      const cleared = { ...data, verify_error_prompt: true };
      delete cleared.awaiting_email;
      delete cleared.awaiting_dob;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: JSON.stringify(cleared) });

      const region = this._getSessionRegion(session);
      const support = getSupportInfo(region);
      return (
        "We couldn't verify those details. Please check your email and date of birth and try again, or contact support for assistance.\n\n" +
        support + "\n\n" +
        "1. Try again\n" +
        "2. Have someone reach out\n" +
        "3. Go to main menu\n\n" +
        "(Reply 1, 2, or 3. 0️⃣ Back)"
      );
    }
  }
  async handleVerifyState(session, message) {
    let data = {};
    try {
      data = typeof session.data === 'string'
        ? JSON.parse(session.data)
        : session.data || {};
    } catch (e) {
      data = {};
    }

    const textRaw = message || '';
    const text = textRaw.trim().toLowerCase();

    // Allow user to go back to Intro menu at any time
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.INTRO
      });
      const updated = await this.sessionManager.getSession(session.id);
      return await this.renderMainMenu(updated);
    }

    // First prompt: ask for email
    if (!data.awaiting_email) {
      const updatedData = { ...data, awaiting_email: true };
      await this.sessionManager.updateSession(session.id, {
        data: JSON.stringify(updatedData)
      });
      return 'To verify your identity, please enter the email address you used to register with us.\n\n(0️⃣ Back to menu)';
    }

    // Validate email input
    const email = textRaw.trim().toLowerCase();
    if (!email.includes('@') || !email.includes('.')) {
      return 'That doesn\'t look like a valid email. Please enter a valid email address to proceed.\n\n(0️⃣ Back to menu)';
    }

    // Attempt verification
    const patient = await this.clinikoAPI.findPatientByEmail(email);
    const clearedData = { ...data };
    delete clearedData.awaiting_email;

    if (patient) {
      try {
        if (typeof this.saveEmailToSessionContext === 'function') {
          await this.saveEmailToSessionContext(session, email);
        }
      } catch (e) {
        // deliberate noop
      }
      await this.sessionManager.updateSession(session.id, {
        verified: true,
        patient_id: patient.id,
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: JSON.stringify(clearedData)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return 'Verification successful!\n\n' + await this.goToInteractiveMenu(updatedSession);
    } else {
      // Verification failed: go back to Intro, show region-specific support info
      await this.sessionManager.updateSession(session.id, {
        verified: false,
        conversation_state: this.STATES.INTRO,
        data: JSON.stringify(clearedData)
      });
      const region = this._getSessionRegion(session);
      const support = getSupportInfo(region);
      return (
        "We couldn't verify that email. Please check the email address and try again, or contact support for assistance.\n\n" +
        support + "\n\n" +
        await this.renderMainMenu(session)
      );
    }
  }

  /**
   * Handle the Book/Manage options menu (after verification).
   * @param {object} session
   * @param {string} message
   */
  async handleBookManageOptions(session, message) {
    const text = (message || '').trim().toLowerCase();

    // Support region change from the verified main menu
    if (text === 'region' || text === 'change region') {
      let context = session.context;
      if (context && typeof context === 'string') {
        try { context = JSON.parse(context); } catch {}
      }
      context = context || {};
      context.awaiting_region_selection = true;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, context });
      const updated = await this.sessionManager.getSession(session.id);
      return await this.handleIntroState(updated, 'region');
    }

    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.renderMainMenu(updatedSession);
    }
    /*
    if (text === '9' || text.includes('logout')) {
      await this.sessionManager.deleteSessionAndData(session.id);
      const updatedSession = await this.sessionManager.getOrCreateSession(
        session.phone_number || session.phoneNumber,
        true
      );
      await this.sessionManager.updateSession(updatedSession.id, { verified: false, patient_id: null, conversation_state: this.STATES.INTRO, data: null, context: JSON.stringify({}) });
      return '✅ All your data has been deleted and you are logged out.\n\n' +
        (await this.goToInteractiveMenu(updatedSession));
    }
    */
    // Logout: clear PII but PRESERVE region
    if (text === '9' || text.includes('logout')) {
      // Keep region if present
      let existingCtx = {};
      let region = '';
      try {
        existingCtx = (typeof session.context === 'string')
          ? JSON.parse(session.context || '{}')
          : (session.context || {});
        this.logger.debug('handleOutBMO : Ramesh', { existingCtx });
      } catch {
        existingCtx = {};
      }
      const newCtx = {};
      newCtx.region = (existingCtx.region || region);
      // Clear PII-only bits

      // Wipe data + patient/verified; keep region
      await this.sessionManager.deleteSessionAndData(session.id);
      const fresh = await this.sessionManager.getOrCreateSession(session.phone_number || session.phoneNumber, true);
      // Ensure flags are reset and region is preserved
      await this.sessionManager.updateSession(fresh.id, {
        verified: false,
        patient_id: null,
        conversation_state: this.STATES.INTRO,
        data: null,
        context: JSON.stringify(newCtx)
      });
      const menu = await this.goToInteractiveMenu(fresh);
      return '✅ All your data has been deleted and you are logged out.\n\n' + menu;
    }

    if (text === '1' || text.includes('book')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS });
      //return 'How would you like to book?\n\n1️⃣ Based on your last physio visit\n2️⃣ Soonest available\n3️⃣ At specific date\n4️⃣ Pick a specific physio\n5️⃣ Pick a specific clinic\n\nReply with number or keyword.';
      return await this.goToInteractiveMenu(session);
    }
    if (text === '2' || text.includes('cancel')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.CANCEL_APPOINTMENT });
      return await this.handleCancelAppointmentState(session, '');
    }
    if (text === '3' || text.includes('resched')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.RESCHEDULE_APPOINTMENT });
      return await this.handleRescheduleAppointmentState(session, '');
    }
    return 'Your response is not understood. Here are the options. Try again.' + (await this.goToInteractiveMenu(session));
  }

  /**
   * Handle options for booking method selection.
   * @param {object} session
   * @param {string} message
   */
  async handleBookingMethodOptions(session, message) {
    const text = (message || '').trim().toLowerCase();

    // Support region change while at booking method menu
    if (text === 'region' || text === 'change region') {
      let context = session.context;
      if (context && typeof context === 'string') {
        try { context = JSON.parse(context); } catch {}
      }
      context = context || {};
      context.awaiting_region_selection = true;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, context });
      const updated = await this.sessionManager.getSession(session.id);
      return await this.handleIntroState(updated, 'region');
    }

    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_MANAGE_OPTIONS });
      return 'What would you like to do?\n\n' + (await this.goToInteractiveMenu(session));
    }
    // Determine region
    let regionCode = 'SG';
    try {
      const ctx = typeof session.context === 'string' ? JSON.parse(session.context || '{}') : (session.context || {});
      regionCode = String((ctx && ctx.region) || 'SG').toUpperCase();
    } catch { regionCode = 'SG'; }
  
    if (text === '1' || text.includes('history')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_HISTORY });
      return await this.handleBookHistory(session, '');
    }
    if (text === '2' || text.includes('soonest')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SOONEST });
      return await this.handleBookSoonest(session, '');
    }
    if (text === '3' || text.includes('date')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      return await this.handleBookSpecificDate(session, '');
    }
    if (text === '4' || text.includes('physio')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      return await this.handleBookSpecificPhysio(session, '');
    }
    if (text === '5' || text.includes('clinic')) {
      if (regionCode === 'SG') {
        // SG: reject clinic selection cleanly and keep user in booking method menu
        return 'Please choose 1-4.';
      }
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      return await this.handleBookSpecificClinic(session, '');
    }
    return `Please choose ${regionCode === 'SG' ? '1-4' : '1-5'}. Reply 0 to go back.`;
  }

  /**
   * Returns the previous logical selection step for the given flow and step.
   * Use this in all handlers for robust, consistent "back" navigation.
   *
   * @param {string} selection_step
   * @param {string} flow - One of 'clinic', 'physio', 'date', 'soonest'
   * @returns {string|null} previous step or null if at top
   */
  async getPreviousStepForBooking(selection_step, flow) {
    if (flow === 'clinic') {
      if (['choose_physio', 'choose_appt_type'].includes(selection_step))
        return 'choose_clinic';
      if (selection_step === 'choose_clinic')
        return null;
    }
    if (flow === 'physio') {
      if (['choose_clinic', 'choose_appt_type'].includes(selection_step))
        return 'choose_physio';
      if (selection_step === 'choose_physio')
        return null;
    }
    if (flow === 'date') {
      if (['choose_clinic', 'choose_physio'].includes(selection_step))
        return 'choose_type';
      if (selection_step === 'choose_type')
        return 'choose_date';
      if (selection_step === 'choose_date')
        return null;
    }
    if (flow === 'soonest') {
      if (['choose_clinic', 'choose_physio'].includes(selection_step))
        return 'choose_type';
      if (selection_step === 'choose_type')
        return null;
    }
    return null;
  }

  /**
   * Centralized: Record the last multi-choice menu for correct back navigation.
   */
  async recordLastMultiOption(session, data, state, selection_step, options) {
    if (options && options.length > 1) {
      data.last_multi_option_state = { state, selection_step };
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    }
  }

  async _handleNoSlotsDecision(session, data, stateConst, backHandler, incomingText) {
    const text = (incomingText || '').trim().toLowerCase();
    if (!data.no_slots_prompt) return null;

    if (text === '1') {
      delete data.no_slots_prompt;
      const { step, popped } = navBack(data);
      if (step) {
        clearForwardStateForPopped(data, popped);
        data.selection_step = step;
        data.suppress_auto_advance = true;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: stateConst,
          data: JSON.stringify(data)
        });
        return await backHandler.call(this, session, '');
      }
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return await this.goToInteractiveMenu(session);
    }

    if (text === '2') {
      // Region-specific support email
      let context = session.context;
      if (context && typeof context === 'string') {
        try { context = JSON.parse(context); } catch {}
      }
      const region = (context && context.region) || 'SG';
      const support = REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG;
      const toEmail = support.email;

      // Patient info (best effort)
      const patient_id = session.patient_id || null;
      let patientEmail = null;
      let patientName = null;
      try {
        if (patient_id && this.clinikoAPI.getPatientById) {
          const patient = await this.clinikoAPI.getPatientById(patient_id);
          if (patient) {
            patientEmail = patient.email || null;
            patientName = [patient.first_name, patient.last_name].filter(Boolean).join(' ') || null;
          }
        }
      } catch (e) {}

      const phone = session.phone_number || session.phoneNumber || '';

      // Log the outreach request for staff to action via the region email
      this.logger.info('[NoSlots] Outreach requested for manual email', {
        to: toEmail,
        sessionId: session.id,
        patient_id,
        patientEmail,
        patientName,
        phone,
        region
      });

      delete data.no_slots_prompt;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: JSON.stringify(data)
      });
      return `Thanks! Our ${region} support team (${toEmail}) will reach out to you at ${patientEmail || phone || 'your contact'} shortly.\n\n` + await this.renderMainMenu(session);
    }

    if (text === '3') {
      delete data.no_slots_prompt;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: JSON.stringify(data)
      });
      return await this.renderMainMenu(session);
    }

    return null;
  }

  /**
   * Book-from-history flow replicating handleBookSoonest structure.
   * - Pulls past bookings with statusMode='both'.
   * - Step 1: choose_previous → user picks a prior appointment.
   * - Step 2: choose_type      → build unique appointment-type names for that SAME practitioner across clinics.
   * - Step 3: choose_clinic    → clinics for that practitioner that actually have slots for the chosen type. Excludes UWC.
   * - Step 4: view_slots       → show deduped slots filtered by the chosen unique type name.
   *
   * Uses only existing helpers and ClinikoAPI endpoints in your codebase:
   * normalizeTypeName, normalizeDateWindow, formatPaginatedList, getPractitionerDisplayName,
   * navPush, navBack, clearForwardStateForPopped, deduplicateSlots, enrichAppointmentsForDisplay,
   * MAX_SLOT_ITEMS, this.STATES, this.sessionManager, this.clinikoAPI.
   *
   * Text navigation: "0", "back", "menu" respected. Auto-advance on single-choice lists.
   * Prompts mirror handleBookSoonest style.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookHistory(session, message) {
    const log = this.logger.child({ component: 'BookHistory', sessionId: session?.id });
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const incoming = (message || '').trim();
    const text = incoming.toLowerCase();
    if (!data.navigation_chain) data.navigation_chain = [];

    const normName = (s) => (typeof normalizeTypeName === 'function'
      ? normalizeTypeName(s)
      : String(s || '')
          .replace(/\s+/g, ' ')
          .replace(/([A-Za-z])\(/g, '$1 (')
          .replace(/\s+\)/g, ')')
          .replace(/[\u2010-\u2015]/g, '-')
          .toLowerCase()
          .trim());

    const sync = async (state) => {
      if (state && state.conversation_state) session.conversation_state = state.conversation_state;
      session.data = JSON.stringify(data);
      if (state) await this.sessionManager.updateSession(session.id, { ...state, data: session.data });
      else await this.sessionManager.updateSession(session.id, { data: session.data });
    };

    const refId = (ref, segment) => {
      if (!ref) return '';
      if (ref.id) return String(ref.id);
      try { return String(extractIdFromClinikoRef(ref, segment) || ''); } catch { return ''; }
    };

    // No-slots branch reuse
    if (data.no_slots_prompt) {
      const ret = await this._handleNoSlotsDecision(session, data, this.STATES.BOOK_HISTORY, this.handleBookHistory, incoming || '');
      if (ret) return ret;
    }

    // ===== Back/Menu =====
    if (["0", "back", "menu"].includes(text)) {
      const current = data.selection_step || 'choose_physio_from_history';
      const { step, popped } = navBack(data);
      if (step && step !== current) {
        clearForwardStateForPopped(data, popped);
        data.selection_step = step;
        data.suppress_auto_advance = true;
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        return await this.handleBookHistory(session, '');
      }
      // Top-level: go back to booking method options
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }

    // ===== INIT: fetch past bookings (both) and build physio list =====
    if (!data.selection_step) {
      const patientId = session?.patient_id || data?.patient_id;
      if (!patientId) {
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: null });
        return 'Verify your details before booking from history.';
      }

      const nowISO = new Date().toISOString();
      const fromISO = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();

      const rows = await this.clinikoAPI.getBookingsByPatientId(String(patientId), {
        when: 'past',
        fromISO,
        toISO: nowISO,
        perPage: 100,
        statusMode: 'both'
      });

      // Build practitioner index for names
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const pracById = new Map();
      for (const g of groups || []) {
        for (const p of (g.practitioners || [])) {
          const pid = String(p.id);
          if (!pracById.has(pid)) pracById.set(pid, p);
        }
      }

      // Distinct physios by most recent encounter
      const byPrac = new Map(); // pid -> { practitioner, last_seen, last_clinic_id }
      for (const a of rows || []) {
        const pid = String(a.practitioner_id || refId(a.practitioner, 'practitioners') || '');
        if (!pid) continue;
        const bid = String(a.business_id || refId(a.business, 'businesses') || '');
        const seen = a.starts_at || a.created_at || a.updated_at || new Date(0).toISOString();
        const prev = byPrac.get(pid);
        if (!prev || new Date(seen) > new Date(prev.last_seen)) {
          byPrac.set(pid, {
            practitioner: pracById.get(pid) || { id: pid },
            last_seen: seen,
            last_clinic_id: bid
          });
        }
      }

      const physios = Array.from(byPrac.values()).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
      if (!physios.length) {
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
        return 'No prior physio visits found. Choose another booking method.';
      }

      data.history_physio_list = physios;
      data.selection_step = 'choose_physio_from_history';

      const fwd = planForward(data, 'choose_physio_from_history', physios.length, () => {
        data.selected_physio = physios[0].practitioner;
        data.last_clinic_id = physios[0].last_clinic_id || '';
        data.selection_step = 'choose_type';
      });
      await sync({ conversation_state: this.STATES.BOOK_HISTORY });
      if (fwd.advanced) return await this.handleBookHistory(session, '');
    }

    // ===== choose_physio_from_history =====
    if (data.selection_step === 'choose_physio_from_history') {
      const list = data.history_physio_list || [];

      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= list.length) return 'Invalid selection. Reply with a number from the list.';
        data.selected_physio = list[idx].practitioner;
        data.last_clinic_id = list[idx].last_clinic_id || '';
        data.selection_step = 'choose_type';
        navPush(data, 'choose_type', { had_multiple_options: (list.length > 1), auto: false });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        return await this.handleBookHistory(session, '');
      }

      const reply = formatPaginatedList({
        items: list,
        formatFn: (p, i) => `${i}. ${getPractitionerDisplayName(p.practitioner)}\n   Last seen: ${new Date(p.last_seen).toLocaleString('en-GB')}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: null,
        header: 'Choose a physio from your past visits:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // ===== choose_type (unique names; exclude Initial/New; map name→ids; exclude UWC) =====
    if (data.selection_step === 'choose_type') {
      if (!Array.isArray(data.appointment_type_list)) {
        const physioId = String(data.selected_physio?.id || data.selected_physio);
        const types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: physioId });

        const buckets = new Map(); // norm -> { displayName, ids:Set }
        for (const t of types || []) {
          if (!t || !t.name) continue;
          if (/UWC/i.test(t.name)) continue;
          if (/\b(initial|new\s*clients?)\b/i.test(t.name)) continue; // no Initial/New in history flow
          const display = String(t.name).replace(/\s+/g, ' ').replace(/([A-Za-z])\(/g, '$1 (').replace(/\s+\)/g, ')').trim();
          const n = normName(display);
          if (!buckets.has(n)) buckets.set(n, { displayName: display, ids: new Set() });
          buckets.get(n).ids.add(String(t.id));
        }

        data.appointment_type_list = Array.from(buckets.values())
          .map(v => ({ name: v.displayName, norm_name: normName(v.displayName), ids: Array.from(v.ids) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        data.appt_type_name_to_ids_norm = Object.fromEntries(
          (data.appointment_type_list || []).map(x => [x.norm_name, x.ids])
        );

        const fwd = planForward(data, 'choose_type', data.appointment_type_list.length, () => {
          data.selected_appt_type = data.appointment_type_list[0];
          data.selection_step = 'choose_clinic';
        });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        if (fwd.advanced) return await this.handleBookHistory(session, '');
      }

      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        const list = data.appointment_type_list || [];
        if (idx < 0 || idx >= list.length) return 'Invalid appointment type selection.';
        data.selected_appt_type = list[idx];
        data.selection_step = 'choose_clinic';
        navPush(data, 'choose_clinic', { had_multiple_options: (list.length > 1), auto: false });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        return await this.handleBookHistory(session, '');
      }

      const reply2 = formatPaginatedList({
        items: data.appointment_type_list || [],
        formatFn: (a, i) => `${i}. ${a.name}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: null,
        header: `Choose appointment type for ${getPractitionerDisplayName(data.selected_physio)}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply2;
    }

    // ===== choose_clinic (exclude UWC; prefer last clinic used) =====
    if (data.selection_step === 'choose_clinic') {
      if (!Array.isArray(data.clinic_list)) {
        const physioId = String(data.selected_physio?.id || data.selected_physio);
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const clinics = [];
        for (const g of groups || []) {
          if (/UWC/i.test(g.clinic_name)) continue;
          if ((g.practitioners || []).some(p => `${p.id}` === physioId)) {
            clinics.push({ id: String(g.clinic_id), business_name: g.clinic_name });
          }
        }
        const lastId = String(data.last_clinic_id || '');
        clinics.sort((a, b) => (String(a.id) === lastId ? -1 : String(b.id) === lastId ? 1 : a.business_name.localeCompare(b.business_name)));
        data.clinic_list = clinics;

        const fwd = planForward(data, 'choose_clinic', clinics.length, () => {
          data.selected_clinic = clinics[0];
          data.selection_step = 'view_slots';
        });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        if (fwd.advanced) return await this.handleBookHistory(session, '');
      }

      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        const list = data.clinic_list || [];
        if (idx < 0 || idx >= list.length) return 'Invalid clinic selection.';
        data.selected_clinic = list[idx];
        data.selection_step = 'view_slots';
        navPush(data, 'view_slots', { had_multiple_options: (list.length > 1), auto: false });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        return await this.handleBookHistory(session, '');
      }

      const reply3 = formatPaginatedList({
        items: data.clinic_list || [],
        formatFn: (c, i) => `${i}. ${c.business_name}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: 'Select a clinic:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply3;
    }

    // ===== view_slots → SELECT_SLOT =====
    if (data.selection_step === 'view_slots') {
      const { from, to } = normalizeDateWindow();
      const physioId = String(data.selected_physio?.id || data.selected_physio);
      const businessId = String(data.selected_clinic?.id);
      const typeNorm = normName(data.selected_appt_type?.name || '');

      const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: businessId,
        practitioner_id: physioId,
        from,
        to
      });
      const filtered = deduplicateSlots((raw || []).filter(s => normName(s.appointment_type_name) === typeNorm));

      if (!filtered.length) {
        data.no_slots_prompt = { context: 'history' };
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        return `No available slots for that combination.\n\n1. Try another type\n2. Pick another physio\n3. Choose another clinic\n0. Back`;
      }

      const slotData = {
        slot_list: filtered,
        slot_page: 0,
        last_selection_flow: 'history',
        prev_state_data: {
          selected_physio: data.selected_physio,
          selected_clinic: data.selected_clinic,
          selected_appt_type: data.selected_appt_type
        }
      };
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(slotData)
      });

      const header = `${data.selected_appt_type.name} • ${getPractitionerDisplayName(data.selected_physio)} • ${data.selected_clinic.business_name}`;
      const reply4 = formatPaginatedList({
        items: filtered,
        formatFn: (s, i) => { const dt = new Date(s.slot || s.starts_at || s.appointment_start); return `${i}. ${dt.toLocaleString('en-GB')}`; },
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply4;
    }

    // Fallback
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    return await this.goToInteractiveMenu(session);
  }

/**
   * Book soonest available appointment.
   * CHANGE: After the user picks an appointment type, we now show the earliest available slots
   * across all practitioners and clinics (ascending by time) WITHOUT asking for physio or clinic first.
   * The slot list lines include "Practitioner • Clinic • Date-Time", and the header shows the selected type.
   *
   * Navigation is preserved:
   * - From choose_type, we proceed directly to SELECT_SLOT with a prepared slot_list.
   * - Back/menu from SELECT_SLOT returns to BOOKING_METHOD_OPTIONS or back to choose_type as per your existing logic.
   * - We use existing helpers: normalizeDateWindow, formatPaginatedList, deduplicateSlots, navPush, planForward, etc.
   * - We keep the "no slots" prompt semantics consistent with the rest of your flows.
   *
   * Steps now: choose_type -> SELECT_SLOT (slot list aggregated across all practitioners & clinics)
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSoonest(session, message) {
    const log = this.logger.child({ component: 'BookSoonest', sessionId: session?.id });
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const textRaw = (message || '').trim();
    const text = textRaw.toLowerCase();
    if (!data.navigation_chain) data.navigation_chain = [];

    // Reuse shared normalizer
    const normName = (s) => (typeof normalizeTypeName === 'function'
      ? normalizeTypeName(s)
      : String(s || '')
          .replace(/\s+/g, ' ')
          .replace(/([A-Za-z])\(/g, '$1 (')
          .replace(/\s+\)/g, ')')
          .replace(/[\u2010-\u2015]/g, '-')
          .toLowerCase()
          .trim());

    const sync = async (state) => {
      if (state && state.conversation_state) session.conversation_state = state.conversation_state;
      session.data = JSON.stringify(data);
      if (state) await this.sessionManager.updateSession(session.id, { ...state, data: session.data });
      else await this.sessionManager.updateSession(session.id, { data: session.data });
    };

    /**
     * Build deduped + alpha-sorted appointment types and map normName→Set(ids).
     */
    const buildTypeCatalogue = async () => {
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const allTypes = await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
      const buckets = new Map(); // norm -> { displayName, ids:Set }
      for (const t of allTypes || []) {
        if (!t || !t.name) continue;
        if (/UWC/i.test(t.name)) continue;
        const display = String(t.name).replace(/\s+/g, ' ').replace(/([A-Za-z])\(/g, '$1 (').replace(/\s+\)/g, ')').trim();
        const n = normName(display);
        if (!buckets.has(n)) buckets.set(n, { displayName: display, ids: new Set() });
        buckets.get(n).ids.add(String(t.id));
      }
      const list = Array.from(buckets.values())
        .map(b => ({ name: b.displayName, id: Array.from(b.ids)[0], norm_name: normName(b.displayName) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const map = {}; for (const [n, b] of buckets.entries()) map[n] = Array.from(b.ids);
      return { list, map };
    };

    /**
     * Return all clinics for a practitioner based on groups, excluding UWC.
     */
    const clinicsForPractitioner = async (practitionerId) => {
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const clinics = [];
      for (const g of groups || []) {
        if (Array.isArray(g.practitioners) && g.practitioners.some(p => p.id === practitionerId)) {
          if (!/UWC/i.test(g.clinic_name)) clinics.push({ id: String(g.clinic_id), business_name: g.clinic_name });
        }
      }
      return clinics;
    };

    /**
     * Gather all practitioners that offer the given type NAME (norm) across all clinics.
     */
    const getPractitionersOfferingTypeName = async (typeNorm) => {
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const seen = new Set();
      const result = [];
      for (const g of groups || []) {
        for (const p of g.practitioners || []) {
          if (seen.has(p.id)) continue;
          const types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
          if ((types || []).some(t => normName(t.name) === typeNorm)) {
            seen.add(p.id);
            result.push(p);
          }
        }
      }
      return result;
    };

    /**
     * Build ALL slots for a given appointment type NAME (normalized) across
     * all practitioners and their clinics within the standard soonest window.
     * Returns a sorted (ascending) and deduplicated list with practitioner/clinic names retained.
     */
    const buildAggregatedSoonestSlotsForType = async (typeNorm, typeDisplayName) => {
      const practitioners = await getPractitionersOfferingTypeName(typeNorm);
      if (!practitioners.length) return [];

      const { from, to } = normalizeDateWindow();

      // Pre-index clinics per practitioner
      const byPractitionerClinics = new Map(); // pid -> [{id,business_name}, ...]
      for (const p of practitioners) {
        const cs = await clinicsForPractitioner(p.id);
        byPractitionerClinics.set(String(p.id), cs);
      }

      // Collect slots across all practitioner/clinic combos
      const collected = [];
      for (const p of practitioners) {
        const clinics = byPractitionerClinics.get(String(p.id)) || [];
        for (const c of clinics) {
          const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
            business_id: String(c.id),
            practitioner_id: String(p.id),
            from,
            to
          });
          const filtered = (raw || []).filter(s => normName(s.appointment_type_name) === typeNorm);
          for (const s of filtered) {
            // Retain names for formatting
            collected.push({
              ...s,
              practitioner_name: getPractitionerDisplayName ? getPractitionerDisplayName(p) : (p.display_name || ''),
              business_name: getBusinessDisplayName ? getBusinessDisplayName(c) : (c.business_name || ''),
            });
          }
        }
      }

      // Deduplicate (using your key rules) then sort ascending by slot time
      const unique = deduplicateSlots(collected);
      unique.sort((a, b) => new Date(a.slot).getTime() - new Date(b.slot).getTime());

      return unique;
    };

    // Handle existing no-slots prompt contexts within Soonest (unchanged semantics)
    if (data.no_slots_prompt && data.no_slots_prompt.context === 'soonest') {
      if (text === '1') { // Try another type
        delete data.no_slots_prompt;
        data.selection_step = 'choose_type';
        delete data.selected_appt_type;
        delete data.practitioner_list; delete data.selected_physio;
        delete data.clinic_list; delete data.selected_clinic;
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }
      if (text === '2') { // kept for compatibility, but we no longer branch to physio-first in soonest
        // Re-route to choose_type again (since we don't show physio now)
        delete data.no_slots_prompt;
        data.selection_step = 'choose_type';
        delete data.selected_appt_type;
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }
      if (text === '3') { // Try another clinic -> not applicable here; go back to types
        delete data.no_slots_prompt;
        data.selection_step = 'choose_type';
        delete data.selected_appt_type;
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }
      // Other input → fall through to re-render current step
    } else if (data.no_slots_prompt) {
      const ret = await this._handleNoSlotsDecision(session, data, this.STATES.BOOK_SOONEST, this.handleBookSoonest, textRaw);
      if (ret) return ret;
    }

    // Back/menu handling: from top return to booking options, otherwise return to choose_type
    if (["0", "menu", "back"].includes(text)) {
      if (!data.selection_step || data.selection_step === 'choose_type') {
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
        return await this.goToInteractiveMenu(session);
      }
      // Any deeper context goes back to choose_type
      const { list, map } = await buildTypeCatalogue();
      data.appointment_type_list = list; data.appt_type_name_to_ids_norm = map; data.appt_type_page = 0;
      delete data.selected_appt_type;
      delete data.slot_list; delete data.slot_page; delete data.prev_state_data; delete data.last_selection_flow;
      data.selection_step = 'choose_type';
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
      const reply = formatPaginatedList({
        items: list,
        formatFn: (a, i) => `${i}. ${a.name}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
        header: 'Choose appointment type:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // ===== Init → choose_type =====
    if (!data.selection_step) {
      const { list, map } = await buildTypeCatalogue();
      data.appointment_type_list = list; data.appt_type_name_to_ids_norm = map; data.appt_type_page = 0;
      data.selection_step = 'choose_type'; data.navigation_chain = [];
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
      if (list.length > 1) navPush(data, 'choose_type', { had_multiple_options: true, auto: false });
      else if (list.length === 1) navPush(data, 'choose_type', { had_multiple_options: false, auto: true });
      await sync();
    }

    // Paging in choose_type
    if (data.selection_step === 'choose_type' && (text === 'm' || text === 'more')) {
      data.appt_type_page = (data.appt_type_page || 0) + 1;
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
      return await this.handleBookSoonest(session, '');
    }

    // ===== choose_type → directly build aggregated slots and jump to SELECT_SLOT =====
    if (data.selection_step === 'choose_type') {
      const apptTypes = data.appointment_type_list || [];
      const page = data.appt_type_page || 0;

      const { advanced } = planForward(data, 'choose_type', apptTypes.length, () => { data.selected_appt_type = apptTypes[0]; });

      if (!advanced && /^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1 + (page * MAX_SLOT_ITEMS);
        if (idx < 0 || idx >= apptTypes.length) return 'Invalid appointment type selection. Reply with a number from the list.';
        data.selected_appt_type = apptTypes[idx];
        await sync();
      }

      if (!data.selected_appt_type) {
        const reply = formatPaginatedList({
          items: apptTypes,
          formatFn: (a, i) => `${i}. ${a.name}`,
          page,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More types',
          header: 'Choose appointment type:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }

      // Build AGGREGATED slots across all practitioners and clinics for the chosen type
      const typeNorm = data.selected_appt_type.norm_name || normName(data.selected_appt_type.name);
      const aggregated = await buildAggregatedSoonestSlotsForType(typeNorm, data.selected_appt_type.name);

      if (!aggregated.length) {
        // No slots at all for this type in the soonest window → allow user to pick another type
        data.no_slots_prompt = { context: 'soonest' };
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return `No available slots for ${data.selected_appt_type.name} in the next few days.\n1. Try another type\n\nReply 1 or 0️⃣ Back.`;
      }

      // Prepare SELECT_SLOT state data with required prev context
      const header = `${data.selected_appt_type.name}`;
      const slotData = {
        slot_list: aggregated,
        slot_page: 0,
        last_selection_flow: 'soonest',
        prev_state_data: {
          selected_appt_type: data.selected_appt_type
          // physio/clinic intentionally omitted at this stage (aggregated view)
        }
      };
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(slotData) });

      // Render slot list: "Practitioner • Clinic • Date-Time" lines
      const reply = formatPaginatedList({
        items: aggregated,
        formatFn: (s, i) => {
          const dt = new Date(s.slot || s.starts_at || s.appointment_start);
          const who = s.practitioner_name || s.practitioner || 'Practitioner';
          const where = s.business_name || s.clinic || '';
          return `${i}. ${who} • ${where} • ${dt.toLocaleString('en-GB')}`;
        },
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }

    // Fallback → show types again
    const apptTypes = data.appointment_type_list || [];
    const apptTypePage = data.appt_type_page || 0;
    const reply = formatPaginatedList({
      items: apptTypes,
      formatFn: (a, i) => `${i}. ${a.name}`,
      page: apptTypePage,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More types',
      header: 'Choose appointment type:'
    }) + `\n\nReply with number. (0️⃣ Back)`;
    return reply;
  }

  /**
   * Book by a specific date with date-scoped choices.
   * Navigation-only + date-availability filtering change:
   * - After date selection, list only appointment types and physios that have availability on that date.
   * - Auto-advance:
   *    1) If there is only ONE clinic for the chosen physio, auto-advance from choose_clinic.
   *    2) At view_slots, when there are NO slots, present the standard no-slots decision
   *       using _handleNoSlotsDecision (consistent with other flows), letting the user
   *       try another option, ask support to reach out, or go to main menu.
   * - Stable indices and back behavior identical to other flows.
   *
   * Steps: choose_date -> choose_type -> choose_physio -> choose_clinic -> SELECT_SLOT
   *
   * Only minimal changes applied as requested:
   *   - Added auto-advance guard in choose_clinic when only one clinic.
   *   - Replaced inline "no slots" message in view_slots with the shared no-slots prompt
   *     via data.no_slots_prompt + _handleNoSlotsDecision.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */

  async handleBookSpecificDate(session, message) {
    // --- Safe state load ---
    let data;
    try {
      data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    } catch {
      data = {};
    }
    if (!data || typeof data !== 'object') data = {};
    if (!data.navigation_chain) data.navigation_chain = [];

    const textRaw = String(message || '');
    const text = textRaw.trim().toLowerCase();

    // Local helpers
    const sync = async (patch = {}) => this.sessionManager.updateSession(session.id, { ...patch, data: JSON.stringify(data) });
    const normName = (s) => (typeof normalizeTypeName === 'function' ? normalizeTypeName(s) : String(s || '').toLowerCase().trim());
    const ymdLocal = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };

    // Handle “no slots” prompt first if present for this flow
    if (data.no_slots_prompt && data.no_slots_prompt.context === 'date') {
      const ret = await this._handleNoSlotsDecision(
        session,
        data,
        this.STATES.BOOK_SPECIFIC_DATE,
        this.handleBookSpecificDate,
        message || ''
      );
      if (ret) return ret;
      // Fall through to re-render current step otherwise
    }

    // Back/menu global behavior
    if (text === 'menu' || text === 'back') {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }
    if (text === '0' && data.selection_step) {
      const current = data.selection_step;
      const { step, popped } = typeof navBack === 'function' ? navBack(data) : { step: null, popped: [] };
      if (step && step !== current) {
        if (typeof clearForwardStateForPopped === 'function') clearForwardStateForPopped(data, popped);
        data.selection_step = step;
        data.suppress_auto_advance = true;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        return await this.handleBookSpecificDate(session, '');
      }
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      const fresh = await this.sessionManager.getSession(session.id);
      return await this.goToInteractiveMenu(fresh);
    }

    // Initialize flow
    if (!data.selection_step) {
      data.selection_step = 'choose_date';
      data.date_page = 0;
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
    }

    // ---------- Step: choose_date ----------
    if (data.selection_step === 'choose_date') {
      // Build next 10 business days (skip Sundays), 5 per page
      const MAX_DATE_ITEMS_LOCAL = 5;
      const MAX_DATE_PAGES_LOCAL = 2;

      const days = [];
      let d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 1); // start from tomorrow
      while (days.length < MAX_DATE_ITEMS_LOCAL * MAX_DATE_PAGES_LOCAL) {
        if (d.getDay() !== 0) days.push(new Date(d)); // exclude Sundays
        d.setDate(d.getDate() + 1);
      }

      // Handle pagination commands for date list
      if (text === 'm' || text === 'more') {
        const nextPage = (Number(data.date_page) || 0) + 1;
        if (nextPage < MAX_DATE_PAGES_LOCAL) {
          data.date_page = nextPage;
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        }
        // Re-render below
      } else if (/^\d+$/.test(text)) {
        const page = Math.max(0, Math.min(Number(data.date_page) || 0, MAX_DATE_PAGES_LOCAL - 1));
        const start = page * MAX_DATE_ITEMS_LOCAL;
        const idx = parseInt(text, 10) - 1;
        const picked = days[start + idx];
        if (picked) {
          data.selected_date = ymdLocal(picked); // YYYY-MM-DD
          data.selection_step = 'choose_type';
          navPush?.(data, 'choose_type', { had_multiple_options: true, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          const fresh = await this.sessionManager.getSession(session.id);
          return await this.handleBookSpecificDate(fresh, '');
        }
      }

      const page = Math.max(0, Math.min(Number(data.date_page) || 0, MAX_DATE_PAGES_LOCAL - 1));
      const pageItems = days.slice(page * MAX_DATE_ITEMS_LOCAL, page * MAX_DATE_ITEMS_LOCAL + MAX_DATE_ITEMS_LOCAL);
      const list = pageItems.map((dt, i) => `${i + 1}. ${dt.toLocaleDateString('en-GB')}`).join('\n');
      const more = page < (MAX_DATE_PAGES_LOCAL - 1) ? '\nM. More dates' : '';
      return `Pick a date (Page ${page + 1}/${MAX_DATE_PAGES_LOCAL}):\n${list}${more}\n\nReply with number${more ? ' or M for more' : ''}. (0️⃣ Back)`;
    }

    // Helper: build unique appointment type catalogue across all practitioners
    const buildTypeCatalogue = async () => {
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const allTypes = await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
      const buckets = new Map(); // norm -> { displayName, ids:Set }
      for (const t of allTypes || []) {
        if (!t || !t.name) continue;
        if (/UWC/i.test(t.name)) continue;
        const display = String(t.name).replace(/\s+/g, ' ').replace(/([A-Za-z])\(/g, '$1 (').replace(/\s+\)/g, ')').trim();
        const n = normName(display);
        if (!buckets.has(n)) buckets.set(n, { displayName: display, ids: new Set() });
        buckets.get(n).ids.add(String(t.id));
      }
      const list = Array.from(buckets.values())
        .map(b => ({ name: b.displayName, norm_name: normName(b.displayName), ids: Array.from(b.ids) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const map = {}; for (const [n, b] of buckets.entries()) map[n] = Array.from(b.ids);
      return { list, map };
    };

    // Helper: gather practitioners who offer a type name (normalized), reusing existing endpoint
    const getPractitionersOfferingTypeName = async (typeNorm) => {
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const seen = new Set();
      const result = [];
      for (const g of groups || []) {
        for (const p of g.practitioners || []) {
          if (seen.has(p.id)) continue;
          const types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
          if ((types || []).some(t => normName(t.name) === typeNorm)) {
            seen.add(p.id);
            result.push({ practitioner: p, clinics: [{ id: String(g.clinic_id), business_name: g.clinic_name }] });
          }
        }
      }
      // The above pairs only include the clinic of the current group iteration; we need all clinics the practitioner works at.
      // Build a full clinic map per practitioner (excluding UWC).
      const groupsAll = await this.clinikoAPI.getPractitionersByClinic();
      const byPidClinics = new Map();
      for (const g of groupsAll || []) {
        if (/UWC/i.test(g.clinic_name)) continue;
        for (const p of g.practitioners || []) {
          const pid = String(p.id);
          if (!byPidClinics.has(pid)) byPidClinics.set(pid, []);
          byPidClinics.get(pid).push({ id: String(g.clinic_id), business_name: g.clinic_name });
        }
      }
      const uniq = [];
      const seenPid = new Set();
      for (const g of groupsAll || []) {
        for (const p of g.practitioners || []) {
          const pid = String(p.id);
          if (seenPid.has(pid)) continue;
          // keep only if practitioner offers the type
          const types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
          if ((types || []).some(t => normName(t.name) === typeNorm)) {
            seenPid.add(pid);
            uniq.push({ practitioner: p, clinics: (byPidClinics.get(pid) || []).filter(c => !/UWC/i.test(c.business_name)) });
          }
        }
      }
      return uniq;
    };

    // Helper: build aggregated slots for a specific date for the chosen type across all practitioners/clinics
    const buildAggregatedSlotsForDateAndType = async (dateYmd, typeNorm) => {
      const { from, to } = normalizeDateWindow(dateYmd, dateYmd, 1);
      const entries = await getPractitionersOfferingTypeName(typeNorm);

      const collected = [];
      for (const entry of entries) {
        const p = entry.practitioner;
        const clinics = entry.clinics || [];
        for (const c of clinics) {
          if (/UWC/i.test(c.business_name || '')) continue;
          const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
            business_id: String(c.id),
            practitioner_id: String(p.id),
            from,
            to
          });
          const filtered = (raw || []).filter(s => normName(s.appointment_type_name) === typeNorm);
          for (const s of filtered) {
            collected.push({
              ...s,
              practitioner_name: getPractitionerDisplayName ? getPractitionerDisplayName(p) : (p.display_name || ''),
              business_name: getBusinessDisplayName ? getBusinessDisplayName(c) : (c.business_name || ''),
            });
          }
        }
      }

      const unique = deduplicateSlots(collected);
      unique.sort((a, b) => new Date(a.slot).getTime() - new Date(b.slot).getTime());
      return unique;
    };

    // ---------- Step: choose_type ----------
    if (data.selection_step === 'choose_type') {
      // Build catalogue once
      if (!Array.isArray(data.appointment_type_list)) {
        const { list, map } = await buildTypeCatalogue();
        data.appointment_type_list = list;
        data.appt_type_name_to_ids_norm = map;
        data.appt_type_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

      // Paging in type list
      if (text === 'm' || text === 'more') {
        data.appt_type_page = (Number(data.appt_type_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        return await this.handleBookSpecificDate(session, '');
      }

      // Selection by number (absolute index across paginated pages)
      if (/^\d+$/.test(text)) {
        const list = data.appointment_type_list || [];
        const page = data.appt_type_page || 0;
        const idx = parseInt(text, 10) - 1 + (page * MAX_SLOT_ITEMS);
        if (idx >= 0 && idx < list.length) {
          data.selected_appt_type = list[idx];
          await sync();
          // Build aggregated slots for the specific date and type
          const typeNorm = data.selected_appt_type.norm_name || normName(data.selected_appt_type.name);
          const aggregated = await buildAggregatedSlotsForDateAndType(data.selected_date, typeNorm);

          if (!aggregated.length) {
            data.no_slots_prompt = { context: 'date' };
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
            return `No available slots for ${data.selected_appt_type.name} on ${new Date(`${data.selected_date}T00:00:00Z`).toLocaleDateString('en-GB')}.\n\n` +
                   `1. Try another type\n2. Pick another physio\n3. Choose another clinic\n0. Back`;
          }

          // Prepare SELECT_SLOT data
          const slotData = {
            slot_list: aggregated,
            slot_page: 0,
            last_selection_flow: 'date',
            prev_state_data: {
              selected_appt_type: data.selected_appt_type,
              selected_date: data.selected_date
            }
          };
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.SELECT_SLOT,
            data: JSON.stringify(slotData)
          });

          // Header and list render
          const header = `${data.selected_appt_type.name} • ${new Date(`${data.selected_date}T00:00:00Z`).toLocaleDateString('en-GB')}`;
          const reply = formatPaginatedList({
            items: aggregated,
            formatFn: (s, i) => {
              const dt = new Date(s.slot || s.starts_at || s.appointment_start);
              const who = s.practitioner_name || s.practitioner || 'Practitioner';
              const where = s.business_name || s.clinic || '';
              return `${i}. ${who} • ${where} • ${dt.toLocaleString('en-GB')}`;
            },
            page: 0,
            pageSize: MAX_SLOT_ITEMS,
            moreLabel: 'M. More slots',
            header
          }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
          return reply;
        }
        return 'Invalid appointment type selection. Reply with a number from the list.';
      }

      // Render types (paginated)
      const apptTypes = data.appointment_type_list || [];
      const page = data.appt_type_page || 0;
      const replyTypes = formatPaginatedList({
        items: apptTypes,
        formatFn: (a, i) => `${i}. ${a.name}`,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: (page + 1) * MAX_SLOT_ITEMS < apptTypes.length ? 'M. More types' : null,
        header: `Select visit type for ${new Date(`${data.selected_date}T00:00:00Z`).toLocaleDateString('en-GB')}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return replyTypes;
    }

    // Fallback to booking method options if step is unexpected
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    const fresh = await this.sessionManager.getSession(session.id);
    return await this.goToInteractiveMenu(fresh);
  }

  /**
   * Book by picking a physio first. Navigation-only hardening.
   * - Reset cross-flow state on entry to avoid skipping steps.
   * - Stable indices with persisted lists and page offsets.
   * - Auto-advance recorded and skipped after back.
   * - "0/menu/back" returns to last multi-option step; from top to BOOKING_METHOD_OPTIONS.
   * - When physio changes, clear any previously selected appointment type and cached lists.
   *
   * Steps: choose_physio -> choose_clinic -> choose_appt_type -> SELECT_SLOT
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSpecificPhysio(session, message) {
    // ---------- safe load ----------
    let data;
    try { data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {}); } catch { data = {}; }
    if (!data || typeof data !== 'object') data = {};
    if (!data.navigation_chain) data.navigation_chain = [];

    const textRaw = String(message || '');
    const text = textRaw.trim().toLowerCase();
    const sync = async (patch = {}) => this.sessionManager.updateSession(session.id, { ...patch, data: JSON.stringify(data) });

    const normName = (s) => (typeof normalizeTypeName === 'function' ? normalizeTypeName(s) : String(s || '').toLowerCase().trim());

    // ---------- global back/menu ----------
    if (text === 'back' || text === 'menu') {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }
    if (text === '0' && data.selection_step) {
      const current = data.selection_step;
      const { step, popped } = typeof navBack === 'function' ? navBack(data) : { step: null };
      if (step && step !== current) {
        if (typeof clearForwardStateForPopped === 'function') clearForwardStateForPopped(data, popped);
        data.selection_step = step;
        data.suppress_auto_advance = true;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
        return await this.handleBookSpecificPhysio(session, '');
      }
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }

    // ---------- init ----------
    if (!data.selection_step) {
      data.selection_step = 'choose_physio';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
    }

    // =====================================================================
    // choose_physio
    // =====================================================================
    if (data.selection_step === 'choose_physio') {
      if (!Array.isArray(data.practitioner_list)) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const allPhysios = [];
        for (const g of groups || []) {
          if (/UWC/i.test(g.clinic_name)) continue;
          for (const p of g.practitioners || []) allPhysios.push(p);
        }
        // unique by id
        const seen = new Set();
        data.practitioner_list = allPhysios.filter(p => { if (seen.has(`${p.id}`)) return false; seen.add(`${p.id}`); return true; });
        data.practitioner_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      if (/^\d+$/.test(text)) {
        const idx = parseInt(text,10) - 1 + ((data.practitioner_page || 0) * MAX_SLOT_ITEMS);
        const list = data.practitioner_list || [];
        if (idx >= 0 && idx < list.length) {
          data.selected_physio = list[idx];
          data.selection_step = 'choose_type';
          if (typeof navPush === 'function') navPush(data, 'choose_type', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          const fresh = await this.sessionManager.getSession(session.id);
          return await this.handleBookSpecificPhysio(fresh, '');
        }
      }

      const reply = formatPaginatedList({
        items: data.practitioner_list || [],
        formatFn: (p,i)=>`${i}. ${getPractitionerDisplayName ? getPractitionerDisplayName(p) : (p.display_name||p.name)}`,
        page: data.practitioner_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More physios',
        header: 'Choose a physio:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // =====================================================================
    // choose_type — unique type names for that physio
    // =====================================================================
    if (data.selection_step === 'choose_type') {
      if (!Array.isArray(data.appointment_type_list)) {
        const apptTypes = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: String(data.selected_physio.id) });
        const buckets = new Map();
        for (const t of (apptTypes || [])) {
          if (!t || !t.name) continue;
          if (/UWC/i.test(t.name)) continue;
          const display = String(t.name).replace(/\s+/g,' ').replace(/([A-Za-z])\(/g,'$1 (').replace(/\s+\)/g,')').trim();
          const n = normName(display);
          if (!buckets.has(n)) buckets.set(n, { displayName: display, ids: new Set() });
          buckets.get(n).ids.add(String(t.id));
        }
        data.appointment_type_list = Array.from(buckets.values()).map(v=>({ name: v.displayName, ids: Array.from(v.ids), norm: normName(v.displayName) })).sort((a,b)=>a.name.localeCompare(b.name));
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      if (/^\d+$/.test(text)) {
        const idx = parseInt(text,10) - 1;
        const list = data.appointment_type_list || [];
        if (idx >= 0 && idx < list.length) {
          data.selected_appt_type = list[idx];
          data.selection_step = 'choose_clinic';
          if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          const fresh = await this.sessionManager.getSession(session.id);
          return await this.handleBookSpecificPhysio(fresh, '');
        }
      }

      const reply = formatPaginatedList({
        items: data.appointment_type_list || [],
        formatFn: (a,i)=>`${i}. ${a.name}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: null,
        header: `Select visit type for ${getPractitionerDisplayName(data.selected_physio)}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // =====================================================================
    // choose_clinic — clinics where the physio works
    // =====================================================================
    if (data.selection_step === 'choose_clinic') {
      if (!Array.isArray(data.clinic_list)) {
        const physId = String(data.selected_physio?.id || data.selected_physio);
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const clinics = [];
        for (const g of groups || []) {
          if (/UWC/i.test(g.clinic_name)) continue;
          if ((g.practitioners || []).some(p => `${p.id}` === physId)) clinics.push({ id: String(g.clinic_id), business_name: g.clinic_name });
        }
        data.clinic_list = clinics;
        data.clinic_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      if (/^\d+$/.test(text)) {
        const list = data.clinic_list || [];
        const idx = parseInt(text, 10) - 1 + ((data.clinic_page || 0) * MAX_SLOT_ITEMS);
        if (idx >= 0 && idx < list.length) {
          data.selected_clinic = list[idx];
          data.selection_step = 'view_slots';
          if (typeof navPush === 'function') navPush(data, 'view_slots', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          const fresh = await this.sessionManager.getSession(session.id);
          return await this.handleBookSpecificPhysio(fresh, '');
        }
      }

      const reply = formatPaginatedList({
        items: data.clinic_list || [],
        formatFn: (c,i)=>`${i}. ${getBusinessDisplayName ? getBusinessDisplayName(c) : c.business_name}`,
        page: data.clinic_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: `Select a clinic for ${getPractitionerDisplayName(data.selected_physio)}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // =====================================================================
    // view_slots — use normalizeDateWindow
    // =====================================================================
    if (data.selection_step === 'view_slots') {
      let from, to;
      if (data.selected_date) {
        const date = data.selected_date; // 'YYYY-MM-DD'
        ({ from, to } = normalizeDateWindow(date, date, 1));
      } else {
        ({ from, to } = normalizeDateWindow());
      }

      const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: String(data.selected_clinic.id),
        practitioner_id: String(data.selected_physio.id),
        from,
        to
      });

      const typeNorm = normName(data.selected_appt_type?.name || '');
      const slots = deduplicateSlots((raw || []).filter(s => normName(s.appointment_type_name) === typeNorm));
      if (!slots.length) return 'No slots in that window. Pick another option.';

      const slotData = {
        slot_list: slots,
        slot_page: 0,
        last_selection_flow: 'physio',
        prev_state_data: {
          selected_physio: data.selected_physio,
          selected_clinic: data.selected_clinic,
          selected_appt_type: data.selected_appt_type
        }
      };
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(slotData) });

      const header = `${data.selected_appt_type?.name} • ${getPractitionerDisplayName(data.selected_physio)} • ${getBusinessDisplayName(data.selected_clinic)}`;
      const reply = formatPaginatedList({
        items: slots,
        formatFn: (s,i)=>{ const dt = new Date(s.slot || s.starts_at || s.appointment_start); return `${i}. ${dt.toLocaleString('en-GB')}`; },
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }

    // fallback
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    const fresh = await this.sessionManager.getSession(session.id);
    return await this.goToInteractiveMenu(fresh);
  }

  /**
   * Handle booking flow when the user starts by choosing a specific clinic.
   * Uses the fixed navigation/state matrix with auto-advance and back behavior.
   * Steps:
   *  - choose_clinic:  show clinics (excludes UWC)
   *  - choose_physio:  list physios at that clinic
   *  - choose_type:    build unique appointment-type set for that physio (map name -> ids)
   *  - view_slots:     show slots for the chosen type at the chosen clinic and physio
   *
   * Constraints:
   *  - Only uses endpoints present in ClinikoAPI and helpers already in ChatbotEngine.
   *  - Auto-advance when a step has a single choice. "0" or "back" pops to last multi-choice.
   *  - Uses getPractitionerDisplayName for practitioner full name display.
   *  - Uses unique appointment type names mapped to multiple IDs (as in handleBookSoonest).
   *
   * @param {object} session
   * @param {string} text
   * @returns {Promise<string>}
   */

  async handleBookSpecificClinic(session, message) {
    const log = this.logger.child({ component: 'BookSpecificClinic', sessionId: session?.id });

    // ---------- safe load ----------
    let data;
    try { data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {}); } catch { data = {}; }
    if (!data || typeof data !== 'object') data = {};
    if (!data.navigation_chain) data.navigation_chain = [];

    const textRaw = String(message || '');
    const text = textRaw.trim().toLowerCase();
    const numStr = text.replace(/[^0-9]/g, '');
    const sync = async (patch = {}) => this.sessionManager.updateSession(session.id, { ...patch, data: JSON.stringify(data) });

    const normName = (s) => (typeof normalizeTypeName === 'function' ? normalizeTypeName(s) : String(s || '').toLowerCase().trim());

    // ---------- Back/Menu ----------
    if (text === 'back' || text === 'menu') {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }
    if (text === '0' && data.selection_step) {
      const current = data.selection_step;
      const { step, popped } = typeof navBack === 'function' ? navBack(data) : { step: null };
      if (step && step !== current) {
        if (typeof clearForwardStateForPopped === 'function') clearForwardStateForPopped(data, popped);
        data.selection_step = step;
        data.suppress_auto_advance = true;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        return await this.handleBookSpecificClinic(session, '');
      }
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }

    // ---------- init ----------
    if (!data.selection_step) {
      data.selection_step = 'choose_clinic';
      data.clinic_page = 0;
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
    }

    // =====================================================================
    // choose_clinic — exclude UWC; auto-advance to choose_type if single
    // =====================================================================
    if (data.selection_step === 'choose_clinic') {
      if (!Array.isArray(data.clinic_list)) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const clinics = [];
        for (const g of groups || []) {
          if (/UWC/i.test(g.clinic_name)) continue;
          clinics.push({ id: String(g.clinic_id), business_name: g.clinic_name });
        }
        data.clinic_list = clinics;
        data.clinic_page = 0;

        const fwd = typeof planForward === 'function' ? planForward(data, 'choose_clinic', clinics.length, () => {
          data.selected_clinic = clinics[0];
          data.selection_step = 'choose_type';
        }) : { advanced: false };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (fwd.advanced) return await this.handleBookSpecificClinic(session, '');
      }

      if (/^m(ore)?$/i.test(text)) {
        data.clinic_page = (Number(data.clinic_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      }

      if (numStr) {
        const idx = parseInt(numStr, 10) - 1 + ((data.clinic_page || 0) * MAX_SLOT_ITEMS);
        const list = data.clinic_list || [];
        if (idx >= 0 && idx < list.length) {
          data.selected_clinic = list[idx];
          data.selection_step = 'choose_type';
          if (typeof navPush === 'function') navPush(data, 'choose_type', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
          return await this.handleBookSpecificClinic(session, '');
        }
      }

      const reply = formatPaginatedList({
        items: data.clinic_list || [],
        formatFn: (c, i) => `${i}. ${getBusinessDisplayName ? getBusinessDisplayName(c) : (c.business_name || c.display_name || c.id)}`,
        page: data.clinic_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: 'Select a clinic:'
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // =====================================================================
    // choose_type — type names available in this clinic
    // =====================================================================
    if (data.selection_step === 'choose_type') {
      if (!Array.isArray(data.appointment_type_list)) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const clinicId = String(data.selected_clinic?.id || data.selected_clinic || '');
        const inClinic = (groups || []).find(g => String(g.clinic_id) === clinicId);
        const pracList = (inClinic?.practitioners || []).map(p => ({ id: String(p.id), ...p }));

        const buckets = new Map(); // norm -> { display, ids:Set }
        for (const p of pracList) {
          const types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: String(p.id) });
          for (const t of (types || [])) {
            if (!t || !t.name) continue;
            if (/UWC/i.test(t.name)) continue;
            const display = String(t.name).replace(/\s+/g,' ').replace(/([A-Za-z])\(/g,'$1 (').replace(/\s+\)/g,')').trim();
            const n = normName(display);
            if (!buckets.has(n)) buckets.set(n, { display, ids: new Set() });
            buckets.get(n).ids.add(String(t.id));
          }
        }
        data.appointment_type_list = Array.from(buckets.values())
          .map(v => ({ name: v.display, norm_name: normName(v.display), ids: Array.from(v.ids) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        data.appt_type_name_to_ids_norm = Object.fromEntries((data.appointment_type_list || []).map(x => [x.norm_name, x.ids]));

        const fwd = typeof planForward === 'function' ? planForward(data, 'choose_type', data.appointment_type_list.length, () => {
          data.selected_appt_type = data.appointment_type_list[0];
          data.selection_step = 'choose_physio';
        }) : { advanced: false };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (fwd.advanced) return await this.handleBookSpecificClinic(session, '');
      }

      if (numStr) {
        const idx = parseInt(numStr, 10) - 1;
        const list = data.appointment_type_list || [];
        if (idx >= 0 && idx < list.length) {
          data.selected_appt_type = list[idx];
          data.selection_step = 'choose_physio';
          if (typeof navPush === 'function') navPush(data, 'choose_physio', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
          return await this.handleBookSpecificClinic(session, '');
        }
      }

      const replyTypes = formatPaginatedList({
        items: data.appointment_type_list || [],
        formatFn: (a, i) => `${i}. ${a.name}`,
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: null,
        header: `Select visit type for ${getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic) : ''}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return replyTypes;
    }

    // =====================================================================
    // choose_physio — physios at selected clinic who offer selected type
    // =====================================================================
    if (data.selection_step === 'choose_physio') {
      if (!Array.isArray(data.practitioner_list)) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const clinicId = String(data.selected_clinic?.id || data.selected_clinic || '');
        const inClinic = (groups || []).find(g => String(g.clinic_id) === clinicId);
        const pracInClinic = (inClinic?.practitioners || []).map(p => ({ id: String(p.id), ...p }));
        const wanted = new Set((data.appt_type_name_to_ids_norm?.[normName(data.selected_appt_type?.name || '')] || []).map(String));

        const practitioners = [];
        for (const p of pracInClinic) {
          const types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: String(p.id) });
          if ((types || []).some(t => wanted.has(String(t.id)))) practitioners.push(p);
        }

        data.practitioner_list = practitioners;
        data.practitioner_page = 0;

        const fwd = typeof planForward === 'function' ? planForward(data, 'choose_physio', practitioners.length, () => {
          data.selected_physio = practitioners[0];
          data.selection_step = 'view_slots';
        }) : { advanced: false };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (fwd.advanced) return await this.handleBookSpecificClinic(session, '');
      }

      if (/^m(ore)?$/i.test(text)) {
        data.practitioner_page = (Number(data.practitioner_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      }

      if (numStr) {
        const idx = parseInt(numStr, 10) - 1 + ((data.practitioner_page || 0) * MAX_SLOT_ITEMS);
        const list = data.practitioner_list || [];
        if (idx >= 0 && idx < list.length) {
          data.selected_physio = list[idx];
          data.selection_step = 'view_slots';
          if (typeof navPush === 'function') navPush(data, 'view_slots', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
          return await this.handleBookSpecificClinic(session, '');
        }
      }

      const replyPhys = formatPaginatedList({
        items: data.practitioner_list || [],
        formatFn: (p, i) => `${i}. ${getPractitionerDisplayName ? getPractitionerDisplayName(p) : (p.display_name || p.name || p.id)}`,
        page: data.practitioner_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More physios',
        header: `Choose a physio for ${getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic) : ''}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return replyPhys;
    }

    // =====================================================================
    // view_slots — fetch slots for this clinic/type/physio → SELECT_SLOT
    // =====================================================================
    if (data.selection_step === 'view_slots') {
      let from, to;
      if (data.selected_date) {
        const date = data.selected_date; // 'YYYY-MM-DD'
        ({ from, to } = normalizeDateWindow(date, date, 1));
      } else {
        ({ from, to } = normalizeDateWindow());
      }

      const businessId = String(data.selected_clinic?.id || data.selected_clinic);
      const physioId = String(data.selected_physio?.id || data.selected_physio);

      const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: businessId,
        practitioner_id: physioId,
        from,
        to
      });

      const typeNorm = normName(data.selected_appt_type?.name || '');
      const slots = deduplicateSlots((raw || []).filter(s => normName(s.appointment_type_name) === typeNorm));
      if (!slots.length) return 'No available slots in that window. Try another selection.';

      const slotData = {
        slot_list: slots,
        slot_page: 0,
        last_selection_flow: 'specific_clinic',
        prev_state_data: {
          selected_physio: data.selected_physio,
          selected_clinic: data.selected_clinic,
          selected_appt_type: data.selected_appt_type,
          date: data.selected_date
        }
      };
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(slotData) });

      const header = `${data.selected_appt_type?.name} • ${getPractitionerDisplayName ? getPractitionerDisplayName(data.selected_physio) : ''} • ${getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic) : ''}`;
      const reply = formatPaginatedList({
        items: slots,
        formatFn: (s, i) => { const dt = new Date(s.slot || s.starts_at || s.appointment_start); return `${i}. ${dt.toLocaleString('en-GB')}`; },
        page: 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More slots',
        header
      }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
      return reply;
    }

    // fallback
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    return await this.goToInteractiveMenu(session);
  }

  /**
   * Handles user selection of an appointment slot in any workflow leading to SELECT_SLOT state.
   * - Consistent formatting across pagination:
   *   If slots contain practitioner_name and business_name (as in aggregated Soonest flow),
   *   list items are rendered as "Practitioner • Clinic • Date-Time" on every page.
   *   Otherwise, fall back to the compact time-only format.
   * - Keeps the existing 3-option no-slots handling.
   * - Preserves navigation/back behavior and existing headers.
   *
   * @param {object} session - The user session object.
   * @param {string} message - The user's input (expected: slot number, 'M' for more, or back keys).
   * @returns {Promise<string>} Message to send to the user.
   */
  async handleSelectSlotState(session, message) {
    const log = this.logger.child({ component: 'SelectSlot', sessionId: session?.id });
    let data;
    try {
      data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    } catch (e) { data = {}; }

    const slots = Array.isArray(data.slot_list) ? data.slot_list : [];
    const textRaw = (message || '').trim();
    let text = textRaw.toLowerCase();

    // If awaiting no-slots decision (3 options), process it first
    if (data.no_slots_prompt) {
      // Route back using last_selection_flow
      let stateConst = this.STATES.BOOKING_METHOD_OPTIONS;
      let backHandler = async (sess) => this.goToInteractiveMenu(sess);
      if (data.last_selection_flow === 'physio') { stateConst = this.STATES.BOOK_SPECIFIC_PHYSIO; backHandler = this.handleBookSpecificPhysio; }
      else if (data.last_selection_flow === 'clinic') { stateConst = this.STATES.BOOK_SPECIFIC_CLINIC; backHandler = this.handleBookSpecificClinic; }
      else if (data.last_selection_flow === 'date') { stateConst = this.STATES.BOOK_SPECIFIC_DATE; backHandler = this.handleBookSpecificDate; }
      else if (data.last_selection_flow === 'soonest') { stateConst = this.STATES.BOOK_SOONEST; backHandler = this.handleBookSoonest; }
      else if (data.last_selection_flow === 'history') { stateConst = this.STATES.BOOK_HISTORY; backHandler = this.handleBookHistory; }

      const ret = await this._handleNoSlotsDecision(session, data, stateConst, backHandler, message || '');
      if (ret) return ret;
      // If user typed something else, fall through to render the prompt again
    }

    // Pagination
    if (text === 'm' || text === 'more') {
      data.slot_page = (data.slot_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      log.info('Slots page advanced', { page: data.slot_page });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleSelectSlotState(updatedSession, '');
    }

    // Back/menu
    if (['0', 'menu', 'back'].includes(text)) {
      if (data.prev_state_data) {
        const prevData = data.prev_state_data;
        const step = data.last_selection_flow;
        log.info('Back to previous flow', { step });
        if (step === 'physio') {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
            data: JSON.stringify(prevData)
          });
          return await this.handleBookSpecificPhysio(session, '');
        }
        if (step === 'clinic') {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC,
            data: JSON.stringify(prevData)
          });
          return await this.handleBookSpecificClinic(session, '');
        }
        if (step === 'date') {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SPECIFIC_DATE,
            data: JSON.stringify(prevData)
          });
          return await this.handleBookSpecificDate(session, '');
        }
        if (step === 'soonest') {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_SOONEST,
            data: JSON.stringify(prevData)
          });
          return await this.handleBookSoonest(session, '');
        }
        if (step === 'history') {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.BOOK_HISTORY,
            data: JSON.stringify(prevData)
          });
          return await this.handleBookHistory(session, '');
        }
      }
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      log.info('Back fallback -> Booking Options');
      return await this.goToInteractiveMenu(session);
    }

    // Edge case: no slots in state
    if (!slots.length) {
      data.no_slots_prompt = true;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      return "No available slots to show.\n\n1. Go back one level\n2. Have someone reach out\n3. Go to main menu\n\nReply 1, 2 or 3.";
    }

    const page = data.slot_page || 0;

    // Numeric selection (absolute index across entire list)
    if (/^\d+$/.test(text)) {
      const idx = parseInt(text, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= slots.length) {
        return 'Invalid slot selection. Please reply with a number from the list, or 0️⃣ to go back.';
      }
      const selectedSlot = slots[idx];
      data.selected_slot = selectedSlot;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.CONFIRM_BOOKING,
        data: JSON.stringify(data)
      });
      const dt = new Date(selectedSlot.slot || selectedSlot.starts_at || selectedSlot.appointment_start);
      log.info('Slot chosen', {
        practitioner_id: selectedSlot.practitioner_id,
        business_id: selectedSlot.business_id,
        appt_type_id: selectedSlot.appointment_type_id,
        slot: selectedSlot.slot || selectedSlot.starts_at || selectedSlot.appointment_start
      });

      // Build concise confirmation with context in header
      const headerParts = [];
      if (data.prev_state_data?.selected_appt_type?.name) headerParts.push(`${data.prev_state_data.selected_appt_type.name}`);
      const who = selectedSlot.practitioner_name || selectedSlot.practitioner || (data.prev_state_data?.selected_physio?.display_name || data.prev_state_data?.selected_physio?.first_name);
      const where = selectedSlot.business_name || selectedSlot.clinic || data.prev_state_data?.selected_clinic?.business_name;
      if (who) headerParts.push(who);
      if (where) headerParts.push(where);
      const header = headerParts.length ? headerParts.join(' • ') : (selectedSlot.practitioner_name || 'Appointment');

      return (
        `You have selected:\n\n` +
        `• ${header}\n` +
        `• ${dt.toLocaleString('en-GB')}\n\n` +
        `Reply YES to confirm, or 0️⃣ to cancel.`
      );
    }

    // Build header (kept from your original)
    let header = 'Available slots:';
    if (data.prev_state_data?.selected_appt_type || data.prev_state_data?.selected_physio || data.prev_state_data?.selected_clinic) {
      const parts = [];
      if (data.prev_state_data?.selected_appt_type?.name) parts.push(data.prev_state_data.selected_appt_type.name);
      const whoPrev = data.prev_state_data?.selected_physio?.display_name || data.prev_state_data?.selected_physio?.first_name;
      if (whoPrev) parts.push(whoPrev);
      const wherePrev = data.prev_state_data?.selected_clinic?.business_name;
      if (wherePrev) parts.push(wherePrev);
      if (parts.length) header = parts.join(' • ');
    }

    // Decide formatter once based on presence of rich fields anywhere in the list
    const hasRichFields = (() => {
      for (const s of slots) {
        if ((s.practitioner_name || s.practitioner) && (s.business_name || s.clinic)) return true;
      }
      return false;
    })();

    const richFormat = (s, idx) => {
      const dt = new Date(s.slot || s.starts_at || s.appointment_start);
      const who = s.practitioner_name || s.practitioner || 'Practitioner';
      const where = s.business_name || s.clinic || '';
      return `${idx}. ${who} • ${where} • ${dt.toLocaleString('en-GB')}`;
    };

    const compactFormat = (s, idx) => {
      const dt = new Date(s.slot || s.starts_at || s.appointment_start);
      return `${idx}. ${dt.toLocaleString('en-GB')}`;
    };

    const formatter = hasRichFields ? richFormat : compactFormat;

    const reply = formatPaginatedList({
      items: slots,
      formatFn: formatter,
      page,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More slots',
      header
    }) + `\n\nReply with the number to pick a slot, or 0️⃣ Back.`;
    return reply;
  }
  
  /**
   * Handle confirmation of booking slot.
   * Enriches the selected slot with practitioner and clinic display names,
   * always shows the clinic, and logs errors with debug comments.
   *
   * @param {object} session - User session object
   * @param {string} message - User input (expected: "yes" or "0"/"menu"/"back")
   * @returns {Promise<string>} Message to send to the user
   */
  async handleConfirmBookingState(session, message) {
    // --- Debug: Start function ---
    this.logger.debug('[handleConfirmBookingState] Entry', { message, sessionId: session?.id });

    const text = (message || '').trim().toLowerCase();

    // Parse session data safely
    let data = {};
    try {
      data = typeof session.data === 'string'
        ? JSON.parse(session.data || '{}')
        : (session.data || {});
    } catch (e) {
      this.logger.warn('[handleConfirmBookingState] Failed to parse session.data', { error: e, raw: session.data });
      data = {};
    }

    // Handle "back" or "menu"
    if (['0', 'menu', 'back'].includes(text)) {
      try {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
          data: null
        });
      } catch (e) {
        this.logger.error('[handleConfirmBookingState] Failed to update session for menu/back', e);
      }
      //return 'How would you like to book?\n\n1️⃣ Based on your last physio visit\n2️⃣ Soonest available\n3️⃣ At specific date\n4️⃣ Pick a specific physio\n5️⃣ Pick a specific clinic\n\nReply with number or keyword.';
      return await this.goToInteractiveMenu(session);
    }

    // --- Debug: Prepare slot for enrichment ---
    let selectedSlot = data.selected_slot;
    // Defensive: If slot is missing, bail out
    if (!selectedSlot) {
      this.logger.warn('[handleConfirmBookingState] No selected_slot in session.data');
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return "No slot was selected. Please try booking again.";
    }

    // --- Debug: Enrichment ---
    let enrichedSlot = selectedSlot;
    try {
      const enrichableSlot = slotToEnrichable(selectedSlot);
      const enrichedArr = await enrichAppointmentsForDisplay([enrichableSlot], this.clinikoAPI);
      if (enrichedArr && enrichedArr[0]) {
        enrichedSlot = enrichedArr[0];
        this.logger.debug('[handleConfirmBookingState] Slot enriched', { enriched: enrichedSlot });
      } else {
        this.logger.warn('[handleConfirmBookingState] Enrichment did not return an enriched slot');
      }
    } catch (e) {
      this.logger.warn('[handleConfirmBookingState] Slot enrichment failed', { error: e });
    }
    const dt = new Date(enrichedSlot.slot);

    // --- Debug: Handle confirmation ---
    if (text === 'yes') {
      // Defensive: Check required booking info
      const patient_id = session.patient_id;
      if (!patient_id) {
        this.logger.warn('[handleConfirmBookingState] Missing patient_id');
        try {
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.INTRO,
            verified: false
          });
        } catch (e) {
          this.logger.error('[handleConfirmBookingState] Failed to set INTRO state after missing patient_id', e);
        }
        return 'Cannot proceed with booking. Please start again.\n\n' + await this.renderMainMenu(session);
      }

      // Defensive: Check slot fields
      if (!selectedSlot.practitioner_id || !selectedSlot.business_id || !selectedSlot.appointment_type_id || !selectedSlot.slot) {
        this.logger.warn('[handleConfirmBookingState] Slot missing required fields', { slot: selectedSlot });
        return "The selected slot is missing some details. Please try booking again.";
      }

      // --- Debug: Attempt booking ---
      let result = {};
      try {
        result = await this.clinikoAPI.bookAppointment({
          patient_id,
          practitioner_id: selectedSlot.practitioner_id,
          business_id: selectedSlot.business_id,
          appointment_type_id: selectedSlot.appointment_type_id,
          starts_at: selectedSlot.slot
        });
        this.logger.debug('[handleConfirmBookingState] Book appointment result', { result });
      } catch (e) {
        this.logger.error('[handleConfirmBookingState] Error in bookAppointment', e);
        result = { success: false, message: "Booking failed due to a technical error." };
      }

      if (result.success) {

        // ✅ Send the booking email on success (new, minimal)
        try {
          const sessionRow = await this.sessionManager.getSession(session.id);
          const payloadAppt = {
            id: selectedSlot.appointment_type_id,
            starts_at: selectedSlot.starts_at || selectedSlot.appointment_start || selectedSlot.slot,
            appointment_type: enrichedSlot._appointment_type_display || enrichedSlot.appointment_type_name || enrichedSlot.appointment_type,
            practitioner: enrichedSlot._practitioner_display || enrichedSlot.practitioner_name,
            clinic: enrichedSlot._business_display || enrichedSlot.business_name
        };
        await this._sendBookedEmail(sessionRow, data, payloadAppt);
        } catch (error) {
          this.logger.error('Error parsing appt to book after success:', error);
        }
        // --- Debug: Booking success, show enriched details ---
        return (
          `✅ Your appointment is booked for:\n` +
          `👨‍⚕️ *${enrichedSlot._practitioner_display || enrichedSlot.practitioner_name}*\n` +
          `🏥 *${enrichedSlot._business_display || ''}*\n` +
          `🗓️ ${dt.toLocaleString('en-GB')}\n\n` +
          await this.goToInteractiveMenu(session)
        );
      } else {
        // --- Debug: Booking failed, show error message ---
        return (
          `❌ Could not book your appointment. ${result.message || ''}\n\n` +
          await this.goToInteractiveMenu(session)
        );
      }
    }

    // --- Debug: Default, show confirmation message ---
    return (
      `You have selected:\n\n` +
      `👨‍⚕️ *${enrichedSlot._practitioner_display || enrichedSlot.practitioner_name}*\n` +
      `🏥 *${enrichedSlot._business_display || ''}*\n` +
      `🗓️ ${dt.toLocaleString('en-GB')}\n\n` +
      `Reply YES to confirm, or 0️⃣ to cancel.`
    );
  }

  // ========== VIEW FEES / LOCATIONS / REGISTER (REUSE) ==========
  async handleViewFeesState(session, message) {
    try {
      // Detect active region from session.context
      let ctx = {};
      try {
        ctx = typeof session.context === 'string' ? JSON.parse(session.context || '{}') : (session.context || {});
      } catch { ctx = {}; }
      const region = String((ctx && ctx.region) || 'SG').toUpperCase();

      // Region-aware mocked fees (UWC excluded by design)
      const MOCK_FEES_BY_REGION = {
        SG: [
          {
            clinic: 'Prohealth In Touch Physiotherapy',
            items: [
              { service: 'Initial Consultation 60 mins',   price: 'SGD 240' },
              { service: 'Return Visit 30 mins',   price: 'SGD 160' },
              { service: 'Return Visit 45 mins',   price: 'SGD 200' },
              { service: 'Return Visit 60 mins',   price: 'SGD 240' },
              /*
              { service: 'Clinical Pilates 45 mins',  price: 'SGD 160' },
              { service: 'Clinical Pilates 60 mins',  price: 'SGD 195' },
              { service: 'Sports Massage 30 mins',   price: 'SGD 130' },
              { service: 'Sports Massage 45 mins',   price: 'SGD 150' },
              { service: 'Sports Massage 60 mins',   price: 'SGD 190' },
              */
            ]
          },
        ],
        HK: [
          {
            clinic: 'A. Prohealth Sports & Spinal Physiotherapy Centres (15/F)',
            items: [
              { service: 'Initial',   price: 'HKD 1,200' },
              { service: 'Follow-up', price: 'HKD 900' },
            ]
          },
          {
            clinic: 'B. Prohealth Sports & Spinal Physiotherapy Centres (12/F)',
            items: [
              { service: 'Initial',   price: 'HKD 1,100' },
              { service: 'Follow-up', price: 'HKD 850' },
            ]
          },
          {
            clinic: 'C. Prohealth Sports and Spinal Physiotherapy Centres (WWH)',
            items: [
              { service: 'Initial',   price: 'HKD 1,100' },
              { service: 'Follow-up', price: 'HKD 850' },
            ]
          },
        ],
        IN: [
          {
            clinic: 'Prohealth Physiotherapy – Delhi',
            items: [
              { service: 'Initial',   price: 'INR 1,500' },
              { service: 'Follow-up', price: 'INR 1,200' },
            ]
          },
        ],
        PH: [
          {
            clinic: 'Prohealth Physiotherapy – Manila',
            items: [
              { service: 'Initial',   price: 'PHP 3,000' },
              { service: 'Follow-up', price: 'PHP 2,500' },
            ]
          },
        ]
      };

      const regionFees = MOCK_FEES_BY_REGION[region] || MOCK_FEES_BY_REGION.SG;

      /*
      // Fetch live clinics (region-scoped; excludes UWC)
      let liveClinics = [];
      try {
        liveClinics = await this.clinikoAPI.getClinics();
      } catch {
        liveClinics = [];
      }

      const liveCount = Array.isArray(liveClinics) ? liveClinics.length : 0;
      const mockCount = Array.isArray(regionFees) ? regionFees.length : 0;

      if (liveCount !== mockCount) {
        const liveNames = (liveClinics || []).map(c => c.business_name).slice(0, 10);
        const mockNames = (regionFees || []).map(x => x.clinic).slice(0, 10);
        this.logger.warn('[FeesMock] Clinic count mismatch', {
          region,
          liveCount,
          mockCount,
          liveSample: liveNames,
          mockSample: mockNames
        });
      }
      */
      const labelByRegion = {
        SG: 'Singapore 🇸🇬',
        HK: 'Hong Kong 🇭🇰',
        IN: 'India 🇮🇳',
        PH: 'Philippines 🇵🇭'
      };
      const regionLabel = labelByRegion[region] || region;

      // Build response body from mock (always display)
      const lines = [`💰 Fee Structure — ${regionLabel}`];
      for (const entry of regionFees) {
        lines.push(`\n🏥 ${entry.clinic}`);
        for (const it of entry.items) {
          lines.push(`• ${it.service}: ${it.price}`);
        }
      }
      const body = lines.join('\n').trim();

      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      return body + '\n\n' + await this.goToInteractiveMenu(session);
    } catch (e) {
      this.logger.error('handleViewFeesState (region-mock) error', { err: e?.message || e });
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      return 'We could not load fees right now. Please try again later.\n\n' + await this.goToInteractiveMenu(session);
    }
  }

  async handleViewLocationsState(session, message) {
    const clinics = await this.clinikoAPI.getClinics();
    const displayText = clinics.map((c, idx) =>
      `${idx + 1}. ${c.business_name}\n `
    ).join('\n');
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
    return `Here are our clinic locations:\n\n${displayText}\n\n` + await this.renderMainMenu(session);
  }

  /**
   * Handle patient registration flow with support for "0/back/menu".
   * - Adds DOB (dd mm yyyy) collection before calling ClinikoAPI.registerNewPatient.
   * - On successful registration:
   *    • Saves email into session context (existing helper).
   *    • Builds a verification message + patient-form link (no POST), sends back to user.
   *    • Sends a "registration" email using existing composer, appending the form message.
   * - On failure:
   *    • Sends a support email with chat history via _composeSupportEmailPayloadNoSlots.
   *    • Prompts the user with existing 3-option support semantics.
   *
   * Uses only uploaded helpers and endpoints. Does not alter other flows.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleRegisterPatientState(session, message) {
    const log = this.logger.child({ component: 'RegisterPatient', sessionId: session?.id });
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const text = (message || '').trim();

    // Back/cancel to Intro from any step
    if (['0', 'back', 'menu'].includes(text.toLowerCase())) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.INTRO,
        verified: false,
        data: null
      });
      const updated = await this.sessionManager.getSession(session.id);
      log.info('Registration cancelled -> Intro');
      return await this.renderMainMenu(updated);
    }

    // Collect required fields in order, with DOB added (dd mm yyyy)
    const required = ['first_name', 'last_name', 'email', 'date_of_birth'];
    let next = null;
    for (const f of required) {
      if (!data[f]) { next = f; break; }
    }

    if (next) {
      if (text) {
        if (next === 'date_of_birth') {
          const parsed = _parseDobDdMmYyyy(text);
          if (!parsed) {
            return "Please enter your date of birth in the format: dd mm yyyy (e.g., 09 04 1987).\n(0️⃣ Back)";
          }
          data.date_of_birth = parsed; // store as YYYY-MM-DD
        } else if (next === 'email') {
          const emailLower = text.trim().toLowerCase();
          if (!emailLower.includes('@') || !emailLower.includes('.')) {
            return "That doesn't look like a valid email. Please enter a valid email address to proceed.\n\n(0️⃣ Back)";
          }
          data.email = emailLower;
        } else {
          data[next] = text;
        }
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        log.info('Collected field', { field: next });
      }

      if (!data.first_name)     return "Please tell me your first name:\n(0️⃣ Back)";
      if (!data.last_name)      return "Got it. What's your last name?\n(0️⃣ Back)";
      if (!data.email)          return "Thanks. Lastly, what's your email address?\n(0️⃣ Back)";
      if (!data.date_of_birth)  return "Please enter your date of birth (dd mm yyyy):\n(0️⃣ Back)";
    }

    // All fields collected → register
    const phoneNumber = session.phone_number || session.phoneNumber;
    if (!data.email || !phoneNumber || !data.date_of_birth) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.INTRO,
        verified: false
      });
      const updated = await this.sessionManager.getSession(session.id);
      log.warn('Missing email, phone, or DOB for registration');
      return "We need your email, phone number, and date of birth to complete registration.\n\n" + await this.goToInteractiveMenu(updated);
    }

    const patient = {
      first_name: data.first_name,
      last_name:  data.last_name,
      email:      data.email,
      date_of_birth: data.date_of_birth
    };

    const phone = String(session.phoneNumber || '').trim();
    if (phone) {
      if (Array.isArray(patient.patient_phone_numbers)) {
        if (!patient.patient_phone_numbers.length) {
          patient.patient_phone_numbers.push({ number: phone, phone_type: 'Mobile' });
        }
      } else {
        patient.patient_phone_numbers = [{ number: phone, phone_type: 'Mobile' }];
      }
    }

    try {
      const result = await this.clinikoAPI.registerNewPatient(patient);
      if (result) {
        try {
          if (typeof this.saveEmailToSessionContext === 'function') {
            await this.saveEmailToSessionContext(session, patient.email);
          }
        } catch (e) { /* noop */ }

        // Try to attach patient_id to session for subsequent flows
        try {
          const newPatientId = result?.patient?.id || result?.id || null;
          if (newPatientId) {
            await this.sessionManager.updateSession(session.id, { patient_id: newPatientId });
            session.patient_id = newPatientId;
          }
        } catch (e) { /* noop */ }

        // Build verification + patient-form link (no POST)
        // const formMsg = await this._buildPatientFormIntroMessage(session, result);

        // Send confirmation email to support + user by reusing booked email composer (adds Next Step)
        try {
          const sessionRow = await this.sessionManager.getSession(session.id);
          const apptLike = {
            id: '',
            starts_at: '',
            appointment_type: 'New Patient Registration',
            practitioner: '',
            clinic: ''
          };
          const payload = await this._composeSupportEmailPayloadBooked(sessionRow, { email: patient.email }, apptLike, false);
          if (payload) {
            // const extra = `\n\n— Next Step —\n${formMsg}`;
            const extra = `\n\n— Next Step —\n`;
            payload.text = (payload.text || '') + extra;
            if (payload.html) {
              const safe = (s) => String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
              //const injected = `<h3 style="margin:16px 0 8px 0;">Next Step</h3><p style="margin:0;">${safe(formMsg).replace(/\n/g,'<br/>')}</p>`;
              const injected = `<h3 style="margin:16px 0 8px 0;">Next Step</h3><p style="margin:0;"></p>`;
              payload.html = payload.html.replace('</body></html>', injected + '</body></html>');
            }
            if (Array.isArray(payload.to) && payload.to.length) {
              await this._postEmail(payload);
            }
          }
        } catch (e) {
          this.logger.warn('Registration success email send failed', { error: e?.message || e });
        }

        await this.sessionManager.updateSession(session.id, {
          verified: true,
          conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
          data: null
        });
        const updated = await this.sessionManager.getSession(session.id);

        this.logger.info('Registration success', { email: patient.email });
        //return `✅ You've been registered!\n\n${formMsg}\n\n` + await this.renderMainMenu(updated);
        return `✅ You've been registered!\n\n` + await this.goToInteractiveMenu(updated);
      }
      log.warn('Registration returned false result');
    } catch (e) {
      log.error('Registration error', { err: e?.message || e });
    }

    // Failure → send email with chat history and show support options
    try {
      const sessionRow = await this.sessionManager.getSession(session.id);
      if (typeof this._composeSupportEmailPayloadNoSlots === 'function' && typeof this._postEmail === 'function') {
        const payload = await this._composeSupportEmailPayloadNoSlots(sessionRow, data || {});
        if (payload && Array.isArray(payload.to) && payload.to.length) {
          await this._postEmail(payload);
        }
      }
    } catch (e) { /* noop */ }

    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
    return "We hit an error while registering you. Please try again later.\n\n" +
           "1. Go back one level\n" +
           "2. Have someone reach out\n" +
           "3. Go to main menu\n\n" +
           await this.goToInteractiveMenu(session);
  }

  // ========== CANCEL WORKFLOW  ==========

  /**
   * List appointments eligible for cancellation.
   * Only FUTURE + ACTIVE appointments are shown. Cancelled are excluded.
   * Uses only uploaded helpers and ClinikoAPI.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleCancelAppointmentState(session, message) {
    const patient_id = session.patient_id;
    if (!patient_id) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY });
      return 'You need to be a registered patient to cancel appointments. Enter your email to verify your details first.';
    }

    // Fetch future ACTIVE appts only; defensive local filter
    let appts = await this.clinikoAPI.getBookingsByPatientId(patient_id.toString(), {
      when: 'future',
      statusMode: 'active',
      perPage: 100,
    });
    const now = new Date();
    let futureAppts = (appts || []).filter(a => new Date(a.starts_at) > now && !a.cancelled_at);
    if (!futureAppts.length) {
      return 'No upcoming appointments found to cancel.\n\n' + await this.goToInteractiveMenu(session);
    }

    futureAppts = await enrichAppointmentsForDisplay(futureAppts, this.clinikoAPI);

    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.cancel_appt_list = futureAppts;
    data.selected_cancel_appt = undefined;
    data.selected_cancel_appt_idx = undefined;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });

    if (futureAppts.length === 1) {
      data.selected_cancel_appt = futureAppts[0];
      data.selected_cancel_appt_idx = 0;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this._cancelPresentConfirmation(session, data, true);
    }

    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_APPOINTMENT_TO_CANCEL,
      data: JSON.stringify(data)
    });

    const listText = futureAppts.map((appt, idx) =>
      `${idx + 1}. ${appt._practitioner_display} — ${appt._appointment_type_display}\n   ${appt._display_dt}`
    ).join('\n');
    return `Your upcoming appointments:\n\n${listText}\n\nPlease reply with the number of the appointment you want to cancel, or "0" to go back.`;
  }

  /**
   * Handle selection of which appointment to cancel.
   * @param {object} session
   * @param {string} message
   */
  async handleSelectAppointmentToCancelState(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const appts = data.cancel_appt_list || [];
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      delete data.cancel_appt_list;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !appts[idx]) {
      return 'Invalid selection. Please reply with the number of the appointment you want to cancel, or "0" to go back.';
    }
    data.selected_cancel_appt = appts[idx];
    data.selected_cancel_appt_idx = idx;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    return await this._cancelPresentConfirmation(session, data, false);
  }

  /**
   * Presents cancellation confirmation for a selected appointment.
   * Used by both the single-appointment and selection flows.
   * @param {object} session
   * @param {object} data
   * @param {boolean} isSingle (true if called from the "only one appt" shortcut)
  */
  async _cancelPresentConfirmation(session, data, isSingle) {
    const appt = data.selected_cancel_appt;
    if (!appt) {
      // Clean up
      delete data.cancel_appt_list;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
    }
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.CONFIRM_CANCEL,
      data: JSON.stringify(data)
    });
    const intro = isSingle
      ? `You have one upcoming appointment:\n\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n`
      : `You selected:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n`;
    return `${intro}\nType "yes" to confirm cancellation, or "0" to go back.`;
  }

  /**
   * Confirm and execute appointment cancellation.
   * Mirrors existing flow and uses only uploaded helpers and ClinikoAPI.
   * Robustness fixes:
   *  - Accepts "yes" to confirm. "0/back/menu" returns without side effects.
   *  - Coerces appointment id to string before API call.
   *  - Clears transient state after API call in both success/failure cases.
   *  - Returns to main menu with unchanged copy.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleConfirmCancelState(session, message) {
    const textRaw = (message || '').trim();
    const text = textRaw.toLowerCase();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});

    // Back/menu
    if (text === '0' || text === 'menu' || text === 'back') {
      delete data.cancel_appt_list;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }

    // Failure prompt branch: allow contacting support (unchanged)
    if (data.cancel_error_prompt === true) {
      if (text === '1') {
        try {
          const sessionRow = await this.sessionManager.getSession(session.id);
          const appt = data.selected_cancel_appt || {};
          const payloadAppt = {
            id: appt.id,
            starts_at: appt.starts_at || appt.appointment_start || appt.slot,
            appointment_type: appt._appointment_type_display || appt.appointment_type_name || appt.appointment_type,
            practitioner: appt._practitioner_display || appt.practitioner_name || appt.practitioner,
            clinic: appt._business_display || appt.business_name || appt.clinic,
            note: 'User attempted cancellation, system returned failure.'
          };
          await this._sendCancelledEmail(sessionRow, data, payloadAppt);
        } catch (error) {
          this.logger.error('Error parsing appt to cancel:', error);
        }
        delete data.cancel_error_prompt;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return `Thanks. Our support team will follow up shortly.\n\n` + await this.goToInteractiveMenu(session);
      }
      if (text === '0' || text === 'menu' || text === 'back') {
        delete data.cancel_error_prompt;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return await this.goToInteractiveMenu(session);
      }
      return `❌ Could not cancel your appointment.\n\nReply 1 to contact support, or 0 to return to menu.`;
    }

    // Require explicit yes
    if (text !== 'yes') {
      const appt = data.selected_cancel_appt;
      const intro = appt ? `You are cancelling:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}` : '';
      return `${intro}\nType "yes" to confirm cancellation, or "0" to go back.`;
    }

    const appt = data.selected_cancel_appt;
    if (!appt || !appt.id) {
      delete data.cancel_appt_list;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
    }

    const result = await this.clinikoAPI.cancelSpecificAppointment(appt.id.toString());

    // Clean up transient state either way
    delete data.cancel_appt_list;
    delete data.selected_cancel_appt;
    delete data.selected_cancel_appt_idx;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });

    if (result && result.success) {
      // ✅ Send the cancel email on success (new, minimal)
      try {
        const sessionRow = await this.sessionManager.getSession(session.id);
        const payloadAppt = {
          id: appt.id,
          starts_at: appt.starts_at || appt.appointment_start || appt.slot,
          appointment_type: appt._appointment_type_display || appt.appointment_type_name || appt.appointment_type,
          practitioner: appt._practitioner_display || appt.practitioner_name || appt.practitioner,
          clinic: appt._business_display || appt.business_name || appt.clinic
        };
        await this._sendCancelledEmail(sessionRow, data, payloadAppt);
      } catch (error) {
        this.logger.error('Error parsing appt to cancel after success:', error);
      }
      return `✅ Your appointment has been cancelled.\n\n` + await this.goToInteractiveMenu(session);
    }

    // Failure -> show prompt to contact support
    data.cancel_error_prompt = true;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    try {
      const sessionRow = await this.sessionManager.getSession(session.id);
      const appt = data.selected_cancel_appt || {};
      const payloadAppt = {
        id: appt.id,
        starts_at: appt.starts_at || appt.appointment_start || appt.slot,
        appointment_type: appt._appointment_type_display || appt.appointment_type_name || appt.appointment_type,
        practitioner: appt._practitioner_display || appt.practitioner_name || appt.practitioner,
        clinic: appt._business_display || appt.business_name || appt.clinic,
        patient_email: (data && data.email) || sessionRow.email || ''
      };
      if (typeof this._composeSupportEmailPayloadCancelled === 'function') {
        const payload = await this._composeSupportEmailPayloadCancelled(sessionRow, data, payloadAppt, true);
        if (payload && Array.isArray(payload.to) && payload.to.length && typeof this._postEmail === 'function') {
          await this._postEmail(payload);
        }
      }
    } catch (e) {
      // deliberate noop
    }
    return `❌ Could not cancel your appointment.\n\nReply 1 to contact support, or 0 to return to menu.`;
  }

  // ========== RESCHEDULE WORKFLOW  ==========
  /**
   * List appointments eligible for rescheduling.
   * Only FUTURE + ACTIVE appointments are shown. Cancelled are excluded.
   * Uses only uploaded helpers and ClinikoAPI.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleRescheduleAppointmentState(session, message) {
    const patient_id = session.patient_id;
    if (!patient_id) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY });
      return 'You need to be a registered patient to reschedule appointments. Enter your email to verify your details first.';
    }

    // Fetch future ACTIVE appts only; defensive local filter
    let appts = await this.clinikoAPI.getBookingsByPatientId(patient_id.toString(), {
      when: 'future',
      statusMode: 'active',
      perPage: 100,
    });
    const now = new Date();
    let futureAppts = (appts || []).filter(a => new Date(a.starts_at) > now && !a.cancelled_at);
    if (!futureAppts.length) {
      return 'No upcoming appointments found to reschedule.\n\n' + await this.goToInteractiveMenu(session);
    }

    futureAppts = await enrichAppointmentsForDisplay(futureAppts, this.clinikoAPI);

    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.reschedule_appt_list = futureAppts;
    data.selected_reschedule_appt = undefined;
    data.selected_reschedule_appt_idx = undefined;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });

    if (futureAppts.length === 1) {
      data.selected_reschedule_appt = futureAppts[0];
      data.selected_reschedule_appt_idx = 0;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this._reschedulePresentSlots(session, data, true);
    }

    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE,
      data: JSON.stringify(data)
    });

    const listText = futureAppts.map((appt, idx) =>
      `${idx + 1}. ${appt._practitioner_display} — ${appt._appointment_type_display}\n   ${appt._display_dt}`
    ).join('\n');
    return `Your upcoming appointments:\n\n${listText}\n\nPlease reply with the number of the appointment you want to reschedule, or "0" to go back.`;
  }

  /**
   * Handle selection of which appointment to reschedule.
   * @param {object} session
   * @param {string} message
   */
  async handleSelectAppointmentToRescheduleState(session, message) {
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const appts = data.reschedule_appt_list || [];
    const text = message.trim().toLowerCase();
    if (['0', 'menu', 'back'].includes(text)) {
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, {
        data: JSON.stringify(data)
      });
      return await this.goToInteractiveMenu(session);
    }
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !appts[idx]) {
      return 'Invalid selection. Please reply with the number of the appointment you want to reschedule, or "0" to go back.';
    }
    data.selected_reschedule_appt = appts[idx];
    data.selected_reschedule_appt_idx = idx;
    await this.sessionManager.updateSession(session.id, {
      data: JSON.stringify(data)
    });
    return await this._reschedulePresentSlots(session, data, false);
  } 

  /**
   * Presents available slots for a selected appointment (with pagination).
   * Used by both the single-appointment and selection flows.
   * @param {object} session
   * @param {object} data
   * @param {boolean} isSingle (true if called from the "only one appt" shortcut)
   */
  async _reschedulePresentSlots(session, data, isSingle) {
    const appt = data.selected_reschedule_appt;
    if (!appt) {
      // Clean up
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
    }
    const business_id = extractIdFromClinikoRef(appt.business, 'businesses');
    const practitioner_id = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const appointment_type_id = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    if (!business_id || !practitioner_id || !appointment_type_id) {
      // Clean up
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return (
        'Sorry, this appointment does not have enough information to find available slots for rescheduling. ' +
        'Please contact our clinic for assistance.\n\n' +
        await this.goToInteractiveMenu(session)
      );
    }
    const { from, to } = normalizeDateWindow();
    const availableTimes = await this.clinikoAPI.getAvailableTimes({
      practitioner_id,
      business_id,
      appt_type: appointment_type_id,
      from,
      to,
    });
    if (!availableTimes.length) {
      // Clean up
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Sorry, there are no available slots for this practitioner at this clinic for this appointment type. Please try again later.\n\n' + await this.goToInteractiveMenu(session);
    }
    data.available_times = availableTimes;
    data.slot_page = 0; // Reset slot page for new selection
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.CONFIRM_RESCHEDULE,
      data: JSON.stringify(data)
    });
    const slotList = formatPaginatedList({
      items: availableTimes,
      formatFn: (slot, i) => `${i}. ${new Date(slot.appointment_start).toLocaleString('en-GB')}`,
      page: 0,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: 'M. More slots',
      header: ''
    });
    const intro = isSingle
      ? `You have one upcoming appointment:\n\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n`
      : `You selected to reschedule:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n`;
    return `${intro}\nPlease choose a new slot:\n\n${slotList}\n\nReply with the number of your chosen slot, "M" for more, or "0" to go back.`;
  }

  /**
   * Confirm new slot and execute reschedule (PATCH existing appointment).
   * Coerces IDs to strings and guarantees ends_at when slot end is missing.
   * Uses only uploaded helpers and ClinikoAPI.
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleConfirmRescheduleState(session, message) {
    const textRaw = (message || '').trim();
    const text = textRaw.toLowerCase();

    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const appt = data.selected_reschedule_appt;
    const availableTimes = data.available_times || [];
    let slot_page = data.slot_page || 0;

    // Back/menu from error prompt
    if (data.resched_error_prompt === true) {
      if (text === '1') {
        // Contact support with context
        try {
          const sessionRow = await this.sessionManager.getSession(session.id);
          const oldAppt = {
            id: appt?.id,
            starts_at: appt?.starts_at || appt?.appointment_start || appt?.slot,
            appointment_type: appt?._appointment_type_display || appt?.appointment_type_name || appt?.appointment_type,
            practitioner: appt?._practitioner_display || appt?.practitioner_name || appt?.practitioner,
            clinic: appt?._business_display || appt?.business_name || appt?.clinic,
            note: 'User attempted reschedule, system returned failure.'
          };
          const sel = data.selected_new_slot || {};
          const newAppt = {
            id: sel.id || '',
            starts_at: sel.starts_at || sel.appointment_start || sel.slot || '',
            appointment_type: sel.appointment_type_name || sel.appointment_type || (data._selected_type_display || ''),
            practitioner: sel.practitioner_name || sel.practitioner || (data._selected_practitioner_display || ''),
            clinic: sel.business_name || sel.clinic || (data._selected_business_display || '')
          };
          await this._sendRescheduledEmail(sessionRow, data, oldAppt, newAppt);
        } catch (error) {
          this.logger.error('Error parsing appt to reschedule after failure:', error);
        }
        delete data.resched_error_prompt;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return `Thanks. Our support team will follow up shortly.\n\n` + await this.goToInteractiveMenu(session);
      }
      if (text === '0' || text === 'menu' || text === 'back') {
        delete data.resched_error_prompt;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return await this.goToInteractiveMenu(session);
      }
      return `❌ Could not reschedule your appointment.\n\nReply 1 to contact support, or 0 to return to menu.`;
    }

    // Pagination for slot list
    if (text === 'm' || text === 'more') {
      slot_page = slot_page + 1;
      data.slot_page = slot_page;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.CONFIRM_RESCHEDULE, data: JSON.stringify(data) });
      const slotList = formatPaginatedList({
        items: availableTimes,
        formatFn: (s, i) => `${i}. ${new Date(s.starts_at || s.appointment_start || s.slot).toLocaleString('en-GB')}`,
        page: slot_page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: (slot_page + 1) * MAX_SLOT_ITEMS < availableTimes.length ? 'M. More' : null,
        header: 'Pick a new time:'
      }) + `\n\nReply with number${(slot_page + 1) * MAX_SLOT_ITEMS < availableTimes.length ? ' or M for more' : ''}. (0️⃣ Back)`;
      return slotList;
    }

    // Back/menu
    if (text === '0' || text === 'menu' || text === 'back') {
      // Do not clear the original selection here; user may come back
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_MANAGE_OPTIONS, data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }

    // Pick a slot by index
    if (/^\d+$/.test(text)) {
      const idx = parseInt(text, 10) - 1 + (slot_page * MAX_SLOT_ITEMS);
      if (idx < 0 || idx >= availableTimes.length) {
        return 'Invalid selection. Please reply with the number of the new time you want, or "0" to go back.';
      }
      const slot = availableTimes[idx];
      data.selected_new_slot = slot;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });

      const appointment_type_id = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
      const business_id = extractIdFromClinikoRef(appt.business, 'businesses');
      const patient_id = session.patient_id;
      const practitioner_id = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
      const starts_at = slot.starts_at || slot.appointment_start || slot.slot;
      let ends_at = slot.ends_at || slot.appointment_end;
      if (!ends_at && starts_at) {
        ends_at = new Date(new Date(starts_at).getTime() + 30 * 60000).toISOString();
      }

      if (!business_id || !practitioner_id || !appointment_type_id || !patient_id || !starts_at) {
        delete data.reschedule_appt_list;
        delete data.selected_reschedule_appt;
        delete data.selected_reschedule_appt_idx;
        delete data.available_times;
        delete data.slot_page;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data), conversation_state: this.STATES.BOOK_MANAGE_OPTIONS });
        return 'Could not retrieve all necessary details for rescheduling. Please try again later or contact the clinic.\n\n' + await this.renderMainMenu(session);
      }

      const payload = {
        appointment_type_id: appointment_type_id.toString(),
        business_id: business_id.toString(),
        patient_id: patient_id.toString(),
        practitioner_id: practitioner_id.toString(),
        starts_at,
        ends_at,
      };

      const result = await this.clinikoAPI.updateIndividualAppointment(appt.id.toString(), payload);
      if (result && result.success) {
        // Email on success
        try {
          const sessionRow = await this.sessionManager.getSession(session.id);
          const oldAppt = {
            id: appt.id,
            starts_at: appt.starts_at || appt.appointment_start || appt.slot,
            appointment_type: appt._appointment_type_display || appt.appointment_type_name || appt.appointment_type,
            practitioner: appt._practitioner_display || appt.practitioner_name || appt.practitioner,
            clinic: appt._business_display || appt.business_name || appt.clinic
          };
          const newAppt = {
            id: result.new_id || appointment_type_id || '',
            starts_at: slot.starts_at || slot.appointment_start || slot.slot || '',
            appointment_type: slot.appointment_type_name || slot.appointment_type || (data._selected_type_display || ''),
            practitioner: slot.practitioner_name || slot.practitioner || (data._selected_practitioner_display || ''),
            clinic: slot.business_name || slot.clinic || (data._selected_business_display || '')
          };
          await this._sendRescheduledEmail(sessionRow, data, oldAppt, newAppt);
        } catch (error) {
          this.logger.error('Error parsing appt to reschedule after success:', error);
        }

        // Clear transient reschedule UI state
        delete data.available_times; delete data.selected_new_slot; delete data.slot_page;
        delete data.selected_reschedule_appt; delete data.selected_reschedule_appt_idx;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return `✅ Your appointment has been rescheduled.\n\n` + await this.goToInteractiveMenu(session);
      }

      // Failure: keep state and offer support
      data.resched_error_prompt = true;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });

      try {
        const sessionRow = await this.sessionManager.getSession(session.id);
        const oldAppt = data.selected_reschedule_appt || {};
        const chosen = data.selected_new_slot || {};
        const oldPayload = {
          id: oldAppt.id,
          starts_at: oldAppt.starts_at || oldAppt.appointment_start || oldAppt.slot,
          appointment_type: oldAppt._appointment_type_display || oldAppt.appointment_type_name || oldAppt.appointment_type,
          practitioner: oldAppt._practitioner_display || oldAppt.practitioner_name || oldAppt.practitioner,
          clinic: oldAppt._business_display || oldAppt.business_name || oldAppt.clinic,
          patient_email: (data && data.email) || sessionRow.email || ''
        };
        const newPayload = {
          id: chosen.id || '',
          starts_at: chosen.starts_at || chosen.appointment_start || chosen.slot || '',
          appointment_type: chosen.appointment_type_name || chosen.appointment_type || (data._selected_type_display || ''),
          practitioner: chosen.practitioner_name || chosen.practitioner || (data._selected_practitioner_display || ''),
          clinic: chosen.business_name || chosen.clinic || (data._selected_business_display || '')
        };
        if (typeof this._composeSupportEmailPayloadRescheduled === 'function') {
          const payload = await this._composeSupportEmailPayloadRescheduled(sessionRow, data, oldPayload, newPayload, true);
          if (payload && Array.isArray(payload.to) && payload.to.length && typeof this._postEmail === 'function') {
            await this._postEmail(payload);
          }
        }
      } catch (e) {
        // deliberate noop
      }
      return `❌ Could not reschedule your appointment.\n\nReply 1 to contact support, or 0 to return to menu.`;
    }

    // Initial render of slot list (or invalid input)
    const slotList = formatPaginatedList({
      items: availableTimes,
      formatFn: (s, i) => `${i}. ${new Date(s.starts_at || s.appointment_start || s.slot).toLocaleString('en-GB')}`,
      page: slot_page,
      pageSize: MAX_SLOT_ITEMS,
      moreLabel: (slot_page + 1) * MAX_SLOT_ITEMS < availableTimes.length ? 'M. More' : null,
      header: 'Pick a new time:'
    }) + `\n\nReply with number${(slot_page + 1) * MAX_SLOT_ITEMS < availableTimes.length ? ' or M for more' : ''}. (0️⃣ Back)`;
    return slotList;
  }

  /**
   * Build email payload after a successful or failed reschedule.
   * Centralizes support recipients via resolveSupportEmails() using region from session context or data.
   * Adds a "Failure" variant when a reschedule attempt fails.
   *
   * @param {object} sessionRow
   * @param {object} data
   * @param {object} oldAppt - { id, starts_at, appointment_type, practitioner, clinic, patient_email, patient_phone }
   * @param {object} newAppt - { id, starts_at, appointment_type, practitioner, clinic, patient_email, patient_phone }
   * @param {boolean} failed - If true, compose a failure-notice email subject/body
   * @returns {Promise<{to:string[],subject:string,text:string,meta:object}>}
   */
  async _composeSupportEmailPayloadRescheduled(sessionRow, data = {}, oldAppt = {}, newAppt = {}, failed = false) {
    function safeJSON(v){ try { return typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); } catch { return {}; } }
    const ctx = safeJSON(sessionRow?.context);
    let region = String((ctx.region || data.region || 'SG')).toUpperCase();
    let phone = String(sessionRow?.phone_number || data.phone || '').trim();
    let email = String((data.email || ctx.email || sessionRow?.email || '')).trim() || '—';
    const to = resolveSupportEmails(region);

    let whenOld = '—'; try { if (oldAppt?.starts_at) whenOld = new Date(oldAppt.starts_at).toLocaleString('en-GB'); } catch {}
    let whenNew = '—'; try { if (newAppt?.starts_at) whenNew = new Date(newAppt.starts_at).toLocaleString('en-GB'); } catch {}

    const subject = (failed ? '[Reschedule Failed]' : '[Rescheduled]') + ' Appointment — ' + region + ' — ' + phone;

    const text =
  'Appointment reschedule notification.\n\n' +
  '— Context —\n' +
  'Region: ' + region + '\n' +
  'Phone:  ' + phone + '\n' +
  'Email:  ' + email + '\n' +
  (failed ? '\nNote: User attempted to reschedule via chatbot but the operation failed. Please assist.\n' : '') +
  '— Previous —\n' +
  'Clinic: ' + (oldAppt?.clinic || '—') + '\n' +
  'Physio: ' + (oldAppt?.practitioner || '—') + '\n' +
  'Type:   ' + (oldAppt?.appointment_type || '—') + '\n' +
  'When:   ' + whenOld + '\n' +
  'ID:     ' + (oldAppt?.id || '—') + '\n\n' +
  '— New —\n' +
  'Clinic: ' + (newAppt?.clinic || '—') + '\n' +
  'Physio: ' + (newAppt?.practitioner || '—') + '\n' +
  'Type:   ' + (newAppt?.appointment_type || '—') + '\n' +
  'When:   ' + whenNew + '\n' +
  'ID:     ' + (newAppt?.id || '—');

    const failureNote = failed
      ? '<p style="margin:12px 0 0 0;"><em>Note: User attempted to reschedule via chatbot but the operation failed. Please assist.</em></p>'
      : '';

    const html =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  '<title>Appointment Notification</title></head><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.4;color:#222;">' +
  '<div style="text-align:center;margin-bottom:16px;"><img src="cid:prohealth-logo" alt="ProHealth" style="max-width:220px;height:auto;display:inline-block" /></div>' +
  '<h2 style="margin:0 0 12px 0;">Appointment reschedule notification</h2>' +
  '<h3 style="margin:16px 0 8px 0;">Context</h3>' +
  `<p style="margin:0 0 6px 0;"><strong>Region:</strong> ${region}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Phone:</strong> ${phone}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Email:</strong> ${email}</p>` +
  failureNote +
  '<h3 style="margin:16px 0 8px 0;">Previous</h3>' +
  `<p style="margin:0 0 6px 0;"><strong>Clinic:</strong> ${oldAppt?.clinic || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Physio:</strong> ${oldAppt?.practitioner || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Type:</strong> ${oldAppt?.appointment_type || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>When:</strong> ${whenOld}</p>` +
  `<p style="margin:0;"><strong>ID:</strong> ${oldAppt?.id || '—'}</p>` +
  '<h3 style="margin:16px 0 8px 0;">New</h3>' +
  `<p style="margin:0 0 6px 0;"><strong>Clinic:</strong> ${newAppt?.clinic || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Physio:</strong> ${newAppt?.practitioner || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Type:</strong> ${newAppt?.appointment_type || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>When:</strong> ${whenNew}</p>` +
  `<p style="margin:0;"><strong>ID:</strong> ${newAppt?.id || '—'}</p>` +
  '</body></html>';

    try {
      const set = new Set(Array.isArray(to) ? to : []);
      let patientEmail = '';
      if (newAppt?.patient_email) patientEmail = String(newAppt.patient_email).trim();
      else if (oldAppt?.patient_email) patientEmail = String(oldAppt.patient_email).trim();
      if (patientEmail) set.add(patientEmail);
      if (email && email !== '—') set.add(email);
      to.length = 0; for (const a of set) to.push(a);
    } catch {}

    return { to, subject, text, html, attachments: [_getInlineLogoAttachment()] };
  }

  /**
   * Build support + user email payload for a BOOKING appointment.
   * Centralizes support recipients via resolveSupportEmails() using region from session context or data.
   * Adds a "Failure" variant when a cancellation attempt fails.
   *
   * @param {Object} sessionRow - row from `sessions` (expects `phone_number`, `context` as JSON/object)
   * @param {Object} data       - parsed session.data or {}
   * @param {Object} appt       - { id, starts_at, appointment_type, practitioner, clinic, patient_email, patient_phone }
   * @param {boolean} failed    - If true, compose a failure-notice email subject/body
   * @returns {{to:string[], subject:string, text:string}}
   */
  async _composeSupportEmailPayloadBooked(sessionRow, data = {}, appt = {}, failed = false) {
    function safeJSON(v){ try { return typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); } catch { return {}; } }
    const ctx = safeJSON(sessionRow?.context);
    let region = String((ctx.region || data.region || 'SG')).toUpperCase();
    let phone = String(sessionRow?.phone_number || data.phone || '').trim();
    let email = String((data.email || ctx.email || sessionRow?.email || '')).trim() || '—';
    const to = resolveSupportEmails(region);
    let whenStr = '—'; try { if (appt?.starts_at) whenStr = new Date(appt.starts_at).toLocaleString('en-GB'); } catch {}
    const subject = 'Booked! Appointment — ' + region + ' — ' + phone;

    const text =
  'Appointment booking notification.\n\n' +
  '— Context —\n' +
  'Region: ' + region + '\n' +
  'Phone:  ' + phone + '\n' +
  'Email:  ' + email + '\n' +
  '— Appointment —\n' +
  'Clinic: ' + (appt?.clinic || '—') + '\n' +
  'Physio: ' + (appt?.practitioner || '—') + '\n' +
  'Type:   ' + (appt?.appointment_type || '—') + '\n' +
  'When:   ' + whenStr + '\n' +
  'ID:     ' + (appt?.id || '—');

    const html =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  '<title>Appointment Notification</title></head><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.4;color:#222;">' +
  '<div style="text-align:center;margin-bottom:16px;"><img src="cid:prohealth-logo" alt="ProHealth" style="max-width:220px;height:auto;display:inline-block" /></div>' +
  '<h2 style="margin:0 0 12px 0;">Appointment booking notification</h2>' +
  '<h3 style="margin:16px 0 8px 0;">Context</h3>' +
  `<p style="margin:0 0 6px 0;"><strong>Region:</strong> ${region}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Phone:</strong> ${phone}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Email:</strong> ${email}</p>` +
  '<h3 style="margin:16px 0 8px 0;">Appointment</h3>' +
  `<p style="margin:0 0 6px 0;"><strong>Clinic:</strong> ${appt?.clinic || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Physio:</strong> ${appt?.practitioner || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Type:</strong> ${appt?.appointment_type || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>When:</strong> ${whenStr}</p>` +
  `<p style="margin:0;"><strong>ID:</strong> ${appt?.id || '—'}</p>` +
  '</body></html>';

    try { const set = new Set(Array.isArray(to) ? to : []); if (email && email !== '—') set.add(email); to.length = 0; for (const a of set) to.push(a); } catch {}

    return { to, subject, text, html, attachments: [_getInlineLogoAttachment()] };
  }
  
  /**
   * Build support + user email payload for a CANCELLED appointment.
   * Centralizes support recipients via resolveSupportEmails() using region from session context or data.
   * Adds a "Failure" variant when a cancellation attempt fails.
   *
   * @param {Object} sessionRow - row from `sessions` (expects `phone_number`, `context` as JSON/object)
   * @param {Object} data       - parsed session.data or {}
   * @param {Object} appt       - { id, starts_at, appointment_type, practitioner, clinic, patient_email, patient_phone }
   * @param {boolean} failed    - If true, compose a failure-notice email subject/body
   * @returns {{to:string[], subject:string, text:string}}
   */
  async _composeSupportEmailPayloadCancelled(sessionRow, data = {}, appt = {}, failed = false) {
    function safeJSON(v){ try { return typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); } catch { return {}; } }
    const ctx = safeJSON(sessionRow?.context);
    let region = String((ctx.region || data.region || 'SG')).toUpperCase();
    let phone = String(sessionRow?.phone_number || data.phone || '').trim();
    let email = String((data.email || ctx.email || sessionRow?.email || '')).trim() || '—';
    const to = resolveSupportEmails(region);

    let whenStr = '—'; try { if (appt?.starts_at) whenStr = new Date(appt.starts_at).toLocaleString('en-GB'); } catch {}
    const subject = (failed ? '[Cancel Failed]' : '[Cancelled]') + ' Appointment — ' + region + ' — ' + phone;

    const text =
  'Appointment cancellation notification.\n\n' +
  '— Context —\n' +
  'Region: ' + region + '\n' +
  'Phone:  ' + phone + '\n' +
  'Email:  ' + email + '\n' +
  (failed ? '\nNote: User attempted to cancel via chatbot but the operation failed. Please assist.\n' : '') +
  '— Appointment —\n' +
  'Clinic: ' + (appt?.clinic || '—') + '\n' +
  'Physio: ' + (appt?.practitioner || '—') + '\n' +
  'Type:   ' + (appt?.appointment_type || '—') + '\n' +
  'When:   ' + whenStr + '\n' +
  'ID:     ' + (appt?.id || '—');

    const failureNote = failed
      ? '<p style="margin:12px 0 0 0;"><em>Note: User attempted to cancel via chatbot but the operation failed. Please assist.</em></p>'
      : '';

    const html =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  '<title>Appointment Notification</title></head><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.4;color:#222;">' +
  '<div style="text-align:center;margin-bottom:16px;"><img src="cid:prohealth-logo" alt="ProHealth" style="max-width:220px;height:auto;display:inline-block" /></div>' +
  '<h2 style="margin:0 0 12px 0;">Appointment cancellation notification</h2>' +
  '<h3 style="margin:16px 0 8px 0;">Context</h3>' +
  `<p style="margin:0 0 6px 0;"><strong>Region:</strong> ${region}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Phone:</strong> ${phone}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Email:</strong> ${email}</p>` +
  failureNote +
  '<h3 style="margin:16px 0 8px 0;">Appointment</h3>' +
  `<p style="margin:0 0 6px 0;"><strong>Clinic:</strong> ${appt?.clinic || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Physio:</strong> ${appt?.practitioner || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Type:</strong> ${appt?.appointment_type || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>When:</strong> ${whenStr}</p>` +
  `<p style="margin:0;"><strong>ID:</strong> ${appt?.id || '—'}</p>` +
  '</body></html>';

    try {
      const set = new Set(Array.isArray(to) ? to : []);
      const patientFromAppt = appt?.patient_email ? String(appt.patient_email).trim() : '';
      if (patientFromAppt) set.add(patientFromAppt);
      if (email && email !== '—') set.add(email);
      to.length = 0; for (const a of set) to.push(a);
    } catch {}

    return { to, subject, text, html, attachments: [_getInlineLogoAttachment()] };
  }

  /**
   * Build email payload for "no slots → contact me".
   * Centralizes recipients via resolveSupportEmails() and keeps the same transcript logic.
   *
   * @param {object} session - session row (expects id, phone_number, context JSON string or object)
   * @param {object} data    - parsed session.data or {}
   * @returns {Promise<{to:string[],subject:string,text:string,meta:object}>}
   */
  async _composeSupportEmailPayloadNoSlots(session, data) {
    function safeJSON(v){ try { return typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); } catch { return {}; } }
    const s = session || {};
    const d = (data && typeof data === 'object') ? data : safeJSON(s.data);
    const ctx = safeJSON(s.context);

    let region = String((ctx.region || d.region || 'SG')).toUpperCase();
    let phone = String(s.phone_number || s.phoneNumber || d.phone || '').trim();
    let userEmail = String(s.email || d.email || '').trim();

    const to = resolveSupportEmails(region);
    if (userEmail) to.push(userEmail);

    const meta = {
      session_id: s.id || '',
      region,
      phone,
      patient_id: d.patient_id || d.patientId || '',
      selected_clinic: d.selected_clinic || null,
      selected_physio: d.selected_physio || null,
      selected_appt_type: d.selected_appt_type || null,
      selected_date: d.selected_date || null
    };

    function fmtTs(ts){ try { return ts ? new Date(ts).toLocaleString('en-GB') : ''; } catch { return ts || ''; } }

    let lines = [];
    try {
      if (this.sessionManager?.db?.getChatHistory && s.id) {
        const rows = await this.sessionManager.db.getChatHistory(s.id);
        if (Array.isArray(rows) && rows.length) {
          const recent = rows.slice(-40);
          for (const r of recent) {
            const ts = r.timestamp || r.created_at || r.time || '';
            const u = r.message && String(r.message).trim();
            const b = r.response && String(r.response).trim();
            if (u) lines.push('[' + fmtTs(ts) + '] USER ▶ ' + u);
            if (b) lines.push('[' + fmtTs(ts) + '] Bot   : ' + b);
          }
        }
      }
    } catch {}

    const headerText =
  'No available slots — user requested a callback.\n\n' +
  '— Context —\n' +
  'Region: ' + region + '\n' +
  'Phone:  ' + (phone || '—') + '\n' +
  'Email:  ' + (userEmail || '—') + '\n' +
  'Date:   ' + (meta.selected_date || '—') + '\n' +
  (meta.selected_clinic ? ('Clinic: ' + (meta.selected_clinic.business_name || meta.selected_clinic.name || meta.selected_clinic) + '\n') : '') +
  (meta.selected_physio ? ('Physio: ' + (meta.selected_physio.display_name || meta.selected_physio.name || meta.selected_physio) + '\n') : '') +
  (meta.selected_appt_type ? ('Type:   ' + (meta.selected_appt_type.name || meta.selected_appt_type) + '\n') : '');

    const transcriptText = lines.length
      ? '\n— Transcript (most recent) —\n' + lines.join('\n') + '\n'
      : '\n— Transcript —\n(no history rows found)\n';

    const subject = '[No Slots] Contact request — ' + region + ' — ' + (phone || userEmail || 'unknown');
    const text = (headerText + '\n' + transcriptText).trim();

    const esc = (s) => String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    const headerHtml =
  '<h2 style="margin:0 0 12px 0;">No available slots — user requested a callback.</h2>' +
  '<h3 style="margin:16px 0 8px 0;">Context</h3>' +
  `<p style="margin:0 0 6px 0;"><strong>Region:</strong> ${region}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Phone:</strong> ${phone || '—'}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Email:</strong> ${userEmail || '—'}</p>` +
  (meta.selected_date ? (`<p style="margin:0 0 6px 0;"><strong>Date:</strong> ${esc(meta.selected_date)}</p>`) : '') +
  (meta.selected_clinic ? (`<p style="margin:0 0 6px 0;"><strong>Clinic:</strong> ${esc(meta.selected_clinic.business_name || meta.selected_clinic.name || meta.selected_clinic)}</p>`) : '') +
  (meta.selected_physio ? (`<p style="margin:0 0 6px 0;"><strong>Physio:</strong> ${esc(meta.selected_physio.display_name || meta.selected_physio.name || meta.selected_physio)}</p>`) : '') +
  (meta.selected_appt_type ? (`<p style="margin:0 0 6px 0;"><strong>Type:</strong> ${esc(meta.selected_appt_type.name || meta.selected_appt_type)}</p>`) : '');

    const transcriptHtml =
  '<h3 style="margin:16px 0 8px 0;">Transcript (most recent)</h3>' +
  (lines.length
    ? ('<pre style="background:#f6f6f6;padding:10px;border-radius:6px;white-space:pre-wrap;">' + lines.map(l => l.replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))).join('\n') + '</pre>')
    : '<p style="margin:0;">(no history rows found)</p>');

    const html =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  '<title>No Slots</title></head><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.4;color:#222;">' +
  '<div style="text-align:center;margin-bottom:16px;"><img src="cid:prohealth-logo" alt="ProHealth" style="max-width:220px;height:auto;display:inline-block" /></div>' +
  headerHtml + transcriptHtml +
  '</body></html>';

    return { to, subject, text, html, attachments: [_getInlineLogoAttachment()], meta };
  }

  /**
   * Compose a support email payload to notify staff when an operation fails without an appointment context.
   * Use this for generic failures in cancel/reschedule flows when we do not have a structured appt object.
   *
   * @param {Object} sessionRow - row from `sessions`
   * @param {Object} data       - parsed session.data or {}
   * @param {string} action     - One of: 'cancel', 'reschedule'
   * @param {string} reason     - Optional short reason message
   * @returns {{to:string[], subject:string, text:string}}
   */
  async _composeGenericFailureEmail(sessionRow, data = {}, action = 'cancel', reason = '') {
    function safeJSON(v){ try { return typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); } catch { return {}; } }
    const ctx = safeJSON(sessionRow?.context);
    let region = String((ctx.region || data.region || 'SG')).toUpperCase();
    let phone = String(sessionRow?.phone_number || data.phone || '').trim();
    let email = String((data.email || sessionRow?.email || '')).trim() || '—';
    const to = resolveSupportEmails(region);

    let act = String(action || 'cancel').toLowerCase() === 'reschedule' ? 'Reschedule' : 'Cancel';
    const subject = `[${act} Failed] — ${region} — ${phone}`;

    const text =
  'Operation failure notification.\n\n' +
  '— Context —\n' +
  'Action: ' + act + '\n' +
  'Region: ' + region + '\n' +
  'Phone:  ' + phone + '\n' +
  'Email:  ' + email + '\n' +
  (reason ? ('\nDetails: ' + reason + '\n') : '');

    const esc = (s) => String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    const html =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  '<title>Operation Failure</title></head><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.4;color:#222;">' +
  '<div style="text-align:center;margin-bottom:16px;"><img src="cid:prohealth-logo" alt="ProHealth" style="max-width:220px;height:auto;display:inline-block" /></div>' +
  '<h2 style="margin:0 0 12px 0;">Operation failure notification</h2>' +
  '<h3 style="margin:16px 0 8px 0;">Context</h3>' +
  `<p style="margin:0 0 6px 0;"><strong>Action:</strong> ${act}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Region:</strong> ${region}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Phone:</strong> ${phone}</p>` +
  `<p style="margin:0 0 6px 0;"><strong>Email:</strong> ${email}</p>` +
  (reason ? (`<p style="margin:12px 0 0 0;"><em>Details: ${esc(reason)}</em></p>`) : '') +
  '</body></html>';

    try { const patientEmail = String(data.email || '').trim(); if (patientEmail) to.push(patientEmail); } catch {}

    return { to, subject, text, html, attachments: [_getInlineLogoAttachment()] };
  }

  /**
   * Persist the patient's email into session.data so it can be reused by email composers.
   * This merges the provided email into the existing JSON in session.data.
   *
   * Integration points (add these calls without changing functional behavior):
   *  - After successful verification in handleVerifyState (on success path), call:
   *      await this.saveEmailToSessionData(session, email);
   *  - After successful registration in handleRegisterPatientState (on success path), call:
   *      await this.saveEmailToSessionData(session, data.email);
   *
   * Note: This does not alter menus or flow; it only persists data.email.
   *
   * @param {object} session - Session object with id and current data
   * @param {string} email   - Patient email to persist
   * @returns {Promise<void>}
   */
  async saveEmailToSessionData(session, email) {
    if (!session || !session.id) {
      return;
    }

    let dataObj = {};
    try {
      if (typeof session.data === 'string') {
        dataObj = JSON.parse(session.data || '{}');
      } else {
        dataObj = session.data || {};
      }
    } catch (e) {
      dataObj = {};
    }

    try {
      dataObj.email = String(email || '').trim();
    } catch (e) {
      dataObj.email = '';
    }

    try {
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(dataObj) });
    } catch (e) {
      // deliberate noop
    }
  }

  /**
   * Persist the patient's email into session.context (not session.data).
   * This merges { email } into the existing context JSON, ensuring availability
   * for later email composers even when session.data is cleared by flows.
   *
   * @param {object} session - Session row/object with id and context
   * @param {string} email   - Patient email to persist
   * @returns {Promise<void>}
   */
  async saveEmailToSessionContext(session, email) {
    if (!session || !session.id) return;

    let ctx = {};
    try {
      if (typeof session.context === 'string') {
        ctx = JSON.parse(session.context || '{}');
      } else {
        ctx = session.context || {};
      }
    } catch (e) {
      ctx = {};
    }

    ctx.email = String(email || '').trim();

    try {
      await this.sessionManager.updateSession(session.id, { context: JSON.stringify(ctx) });
    } catch (e) {
      // noop
    }
  }
  
  /**
   * Low-level POST to local mailer. Keeps runtime quiet on failures.
   * Accepts payload:
   *   - to: string[]
   *   - subject: string
   *   - text: string
   *   - html?: string
   *   - attachments?: Array
   *
   * @param {{to:string[],subject:string,text:string,html?:string,attachments?:Array}} payload
   * @returns {Promise<void>}
   */
  async _postEmail(payload) {
    try {
      const http = require('http');
      const body = JSON.stringify({
        to: Array.isArray(payload.to) ? payload.to : [],
        subject: String(payload.subject || 'Support message'),
        text: String(payload.text || ''),
        html: payload.html ? String(payload.html) : undefined,
        attachments: Array.isArray(payload.attachments) ? payload.attachments : undefined
      });
      await new Promise((resolve, reject) => {
        const req = http.request(
          {
            method: 'POST',
            host: '127.0.0.1',
            port: 8089,
            path: '/email',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          },
          (res) => { res.resume(); res.statusCode === 200 ? resolve() : reject(new Error(`mailer ${res.statusCode}`)); }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    } catch (e) {
      (this && this.logger ? this.logger : console).warn?.('mail send failed', { error: e && e.message });
    }
  }

  /**
   * Wrapper for “no slots” email using your existing composer.
   * Safe to call anywhere once user requested a callback.
   */
  async _sendNoSlotsEmail(sessionRow, data) {
    if (typeof this._composeSupportEmailPayloadNoSlots !== 'function') return;
    const payload = await this._composeSupportEmailPayloadNoSlots(sessionRow, data || {});
    if (payload && Array.isArray(payload.to) && payload.to.length) await this._postEmail(payload);
  }

  /**
   * Wrapper for “cancelled” email using your existing composer.
   */
  async _sendCancelledEmail(sessionRow, data, appt) {
    if (typeof this._composeSupportEmailPayloadCancelled !== 'function') return;
    const payload = await this._composeSupportEmailPayloadCancelled(sessionRow, data || {}, appt || {});
    console.log('DBG context raw:', sessionRow && sessionRow.context);
    if (payload && Array.isArray(payload.to) && payload.to.length) await this._postEmail(payload);
  }

  /**
   * Wrapper for “booked” email using your existing composer.
   */
  async _sendBookedEmail(sessionRow, data, appt) {
    if (typeof this._composeSupportEmailPayloadBooked !== 'function') return;
    const payload = await this._composeSupportEmailPayloadBooked(sessionRow, data || {}, appt || {});
    console.log('DBG context raw:', sessionRow && sessionRow.context);
    if (payload && Array.isArray(payload.to) && payload.to.length) await this._postEmail(payload);
  }

  /**
   * Wrapper for “rescheduled” email using your existing composer.
   */
  async _sendRescheduledEmail(sessionRow, data, oldAppt, newAppt) {
    if (typeof this._composeSupportEmailPayloadRescheduled !== 'function') return;
    const payload = await this._composeSupportEmailPayloadRescheduled(sessionRow, data || {}, oldAppt || {}, newAppt || {});
    console.log('DBG context raw:', sessionRow && sessionRow.context);
    if (payload && Array.isArray(payload.to) && payload.to.length) await this._postEmail(payload);
  }
   

} // End of Class

module.exports = ChatbotEngine;
