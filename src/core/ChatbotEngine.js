// File: /src/core/ChatbotEngine.js

const { buttons, list, MessageEnvelope } = require('./MessageBuilder');
const ClinikoAPI = require('../api/ClinikoAPI.js');
const { formatClinicForWhatsApp } = require('./ClinicFormatter');
const { checkDatabaseHealth, checkAPIHealth } = require('../routes/health.js');
const SessionManager = require('./SessionManager');
const Logger = require('./Logger.js');
const axios = require('axios');
const { bookingConfirmed, appointmentCancelled, appointmentRescheduled } = require('../../prohealth-mailer/EmailTemplates');


function getMailerConfig() {
  const deploymentTarget = String(process.env.DEPLOY_TARGET || '').trim().toLowerCase();
  const isCloudRun =
    deploymentTarget === 'cloudrun' ||
    !!process.env.K_SERVICE ||
    !!process.env.K_REVISION ||
    !!process.env.K_CONFIGURATION;

  const mailerBaseUrl = String(process.env.MAILER_BASE_URL || '').trim();

  if (isCloudRun) {
    if (!mailerBaseUrl) {
      throw new Error('MAILER_BASE_URL is required when running on Cloud Run');
    }
    const url = new URL('/email', mailerBaseUrl);
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
    };
  }

  return {
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: 8089,
    path: '/email',
  };
}

// Code Constants
const WHATSAPP_MAX_MESSAGE_LENGTH = 4096;
const WHATSAPP_SAFE_REPLY_LENGTH = 3500;
const MAX_SLOT_ITEMS = 10;
const SLOT_LIST_PAGE_FIRST = 9;  // slots on page 0 (no prev row needed)
const SLOT_LIST_PAGE_REST  = 8;  // slots on page 1+ (prev row takes one row budget)
const MAX_DATE_ITEMS = 5;
const MAX_DATE_PAGES = 2; // 2 pages of 5 = 10 business days (excluding Sundays)

const REGION_SUPPORT_INFO = {
  SG: {
    phone: '+65 6123 4567',
    email: 'support@prohealth.com.sg'
  },
  HK: {
    phone: '+852 1234 5678',
    email: 'support@prohealth.hk'
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

const REGION_TZ = {
  SG: 'Asia/Singapore',
  HK: 'Asia/Hong_Kong',
  IN: 'Asia/Kolkata',
  PH: 'Asia/Manila',
};

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
 * Validates and normalizes a date search window enforcing:
 * - bookings start from next day (not today),
 * - max 7 days span (inclusive),
 * - ISO strings in 'YYYY-MM-DDTHH:mm:ssZ' or 'YYYY-MM-DD' interpreted as UTC.
 *
 * If input is missing, constructs from next-day start up to next-day + 6 (7-day window).
 * If provided 'from'/'to' violate constraints, clamps within the valid window.
 *
 * @param {string|undefined} fromISO - optional 'YYYY-MM-DDTHH:mm:ssZ' or 'YYYY-MM-DD'
 * @param {string|undefined} toISO   - optional 'YYYY-MM-DDTHH:mm:ssZ' or 'YYYY-MM-DD'
 * @param {number} maxSpanDays       - maximum span (default 7)
 * @returns {{ from: string, to: string }}
 */
function normalizeDateWindow(fromISO, toISO, maxSpanDays = 7) {
  // Compute next-day window
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const nextDay = new Date(base);
  nextDay.setUTCDate(base.getUTCDate() + 1);
  const lastDay = new Date(nextDay);
  // Inclusive span of maxSpanDays => last day is nextDay + (maxSpanDays - 1)
  lastDay.setUTCDate(nextDay.getUTCDate() + (maxSpanDays - 1));

  // parse helper that accepts 'YYYY-MM-DD' or ISO with time
  const parseDate = (s, endOfDay = false) => {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(`${s}T00:00:00Z`);
      if (endOfDay) d.setUTCHours(23, 59, 59, 999);
      return d;
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d;
  };

  // Build initial from/to
  let from = fromISO ? parseDate(fromISO, false) : new Date(nextDay);
  let to = toISO ? parseDate(toISO, true) : new Date(lastDay);
  if (!from) from = new Date(nextDay);
  if (!to) to = new Date(lastDay);

  // Enforce not earlier than nextDay
  if (from < nextDay) from = new Date(nextDay);
  if (to < from) to = new Date(from);

  // Clamp to max span from 'from'. Do NOT clamp against lastDay — lastDay is computed
  // relative to today+1 and would silently move 'to' before 'from' for any future date
  // beyond the default window (e.g. booking on 2026-06-10 when today is 2026-06-05).
  const maxTo = new Date(from);
  maxTo.setUTCDate(from.getUTCDate() + (maxSpanDays - 1));
  if (to > maxTo) to = maxTo;

  const toISODate = d => {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const fromOut = `${toISODate(from)}T00:00:00Z`;
  const toOut = `${toISODate(to)}T23:59:59Z`;
  return { from: fromOut, to: toOut };
}

/**
 * Build a unique list of all practitioners from the grouped array returned by getPractitionersByClinic.
 * @param {Array<{clinic_id: string, clinic_name: string, practitioners: Array<Object>}>} groups
 * @returns {Array<Object>} Array of unique practitioner objects.
 */
async function uniquePractitionersFromGroups(groups) {
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

/**
 * Format a Date or ISO string for display in WhatsApp slot lists and confirmation
 * messages. Uses a fixed locale (en-GB) and explicit options so output is identical
 * regardless of the Node.js process locale on any server: e.g. "17 Jun 2026, 08:00"
 *
 * @param {Date|string} dateOrIso
 * @returns {string}
 */
function formatSlotDateTime(dateOrIso, tz) {
  const dt = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (isNaN(dt.getTime())) return String(dateOrIso);
  return dt.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(tz ? { timeZone: tz } : {}),
  });
}

function formatSlotItem(slot, idx, opts = {}) {
  const dt = new Date(slot.slot);
  return `${idx}. ${formatSlotDateTime(dt)}`; // no tz: standalone util not used in class methods
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
async function enrichAppointmentsForDisplay(appointments, clinikoAPI, tz) {
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
    appt._display_dt = formatSlotDateTime(appt.starts_at, tz);
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
  prevLabel = null,
  header = ''
}) {
  if (!Array.isArray(items)) return '';
  const start = page * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  let text = pageItems.map((item, idx) => formatFn(item, idx + 1 + start)).join('\n');
  if (page > 0 && prevLabel) text += `\n${prevLabel}`;
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
  return `${idx}. ${main.join(' — ')}\n   ${dt.toLocaleString()}`;
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
 * Sort appointment types: New/Initial first, Follow-Up second, everything else third.
 * Within each group, sort alphabetically.
 * @param {Array<{name: string}>} types
 * @returns {Array<{name: string}>}
 */
function sortAppointmentTypes(types) {
  const rank = (name) => {
    const n = String(name || "").toLowerCase();
    if (/\b(new|initial)\b/.test(n)) return 0;
    if (/\bfollow.?up\b/.test(n)) return 1;
    return 2;
  };
  return [...types].sort((a, b) => {
    const rd = rank(a.name) - rank(b.name);
    if (rd !== 0) return rd;
    return String(a.name).localeCompare(String(b.name));
  });
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
      RESCHEDULE_CONFIRM_INTENT: 'RESCHEDULE_CONFIRM_INTENT',
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
      try { context = JSON.parse(context); } catch {}
    }
    return (context && context.region) || 'SG';
  }

  _regionTz(session) {
    return REGION_TZ[this._getSessionRegion(session)] || 'Asia/Singapore';
  }

  // --- Slot list pagination helpers ---

  // Returns the 0-based start index for a given slot page.
  // Page 0 holds SLOT_LIST_PAGE_FIRST slots; page 1+ hold SLOT_LIST_PAGE_REST each.
  _slotPageStart(page) {
    if (page === 0) return 0;
    return SLOT_LIST_PAGE_FIRST + (page - 1) * SLOT_LIST_PAGE_REST;
  }

  // Returns how many slot rows fit on a given page (before nav rows are added).
  _slotPageCount(page) {
    return page === 0 ? SLOT_LIST_PAGE_FIRST : SLOT_LIST_PAGE_REST;
  }

  // Builds a WhatsApp interactive list for slot selection.
  // Interactive row IDs are global 1-based numbers matching the slot index.
  // Nav rows use IDs 'prev' and 'next'. Text fallback uses the old P/M format
  // so text-mode users see global numbers and type them as before.
  _buildSlotList(slots, page, header, tz) {
    const start = this._slotPageStart(page);
    const count = this._slotPageCount(page);
    const hasPrev = page > 0;
    const pageSlots = slots.slice(start, start + count);
    const hasNext = slots.length > start + count;

    const rows = pageSlots.map((slot, i) => ({
      id: String(start + i + 1),
      title: formatSlotDateTime(slot.slot || slot.starts_at || slot.appointment_start, tz),
    }));
    if (hasPrev) rows.push({ id: 'prev', title: '← Previous' });
    if (hasNext) rows.push({ id: 'next', title: 'More slots →' });

    const interactive = {
      type: 'list',
      body: { text: header },
      action: {
        button: 'Select slot',
        sections: [{ rows: rows.map(r => ({ id: r.id, title: r.title })) }]
      }
    };

    const textLines = pageSlots.map((slot, i) =>
      `${start + i + 1}. ${formatSlotDateTime(slot.slot || slot.starts_at || slot.appointment_start, tz)}`
    ).join('\n');
    const navText = [hasPrev ? 'P. Previous slots' : null, hasNext ? 'M. More slots' : null].filter(Boolean).join('\n');
    const textFallback = header + '\n\n' + textLines + (navText ? '\n' + navText : '') + '\n\nReply with the number to pick a slot, or 0️⃣ Back.';

    return new MessageEnvelope(interactive, textFallback);
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
      [this.STATES.RESCHEDULE_CONFIRM_INTENT]: this.handleRescheduleIntentConfirmState.bind(this),
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
  async renderBookingMethodMenu(session) {
    return list('How would you like to book?', 'Choose method', [
      { id: '1', title: 'By last visit' },
      { id: '2', title: 'Soonest available' },
      { id: '3', title: 'Specific date' },
      { id: '4', title: 'Specific physio' },
      { id: '5', title: 'Specific clinic' }
    ]);
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
    let context = session.context;
    if (context && typeof context === 'string') {
      try { context = JSON.parse(context); } catch {}
    }
    if (context && context.region) {
      const regionLabels = {
        HK: 'Hong Kong 🇭🇰',
        SG: 'Singapore 🇸🇬',
        IN: 'India 🇮🇳',
        PH: 'Philippines 🇵🇭'
      };
      if (regionLabels[context.region]) {
        region = `🌏 *Your region*: ${regionLabels[context.region]}\n`;
      }
    }

    if (session.verified) {
      const body =
        `${region}What would you like to do?\n\n` +
        `Type "9" to logout, "region" to change region.`;
      return list(body, 'Select option', [
        { id: '1', title: 'Book Appointment' },
        { id: '2', title: 'Cancel Appointment' },
        { id: '3', title: 'Reschedule' }
      ]);
    } else {
      const body =
        `👋 *Welcome to ProHealthAsia*\n\n` +
        `${region}Please select an option:\n\n` +
        `Type "region" anytime to change region.`;
      return list(body, 'Select option', [
        { id: '1', title: 'Book or Manage' },
        { id: '2', title: 'View Fees' },
        { id: '3', title: 'View Locations' },
        { id: '4', title: 'Register' }
      ]);
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
  /**
 * Returns raw reply — may be a MessageEnvelope or plain string.
 * Callers that need to send interactive messages (e.g. the webhook) use this.
 * Callers that only need text (tests, /test-message) use handleMessage().
 */
async handleMessageEnvelope(message, phoneNumber) {
    try {
      console.log('🤖 HANDLE_MSG entered phone_tail:', (phoneNumber||'').slice(-4), 'msg_preview:', (message||'').slice(0,20));
      if (!this.isInitialized) {
        await this.initialize();
      }
      this.logger.debug('Handling message:', { message, phoneNumber });
      let session = await this.sessionManager.getOrCreateSession(phoneNumber);
      if (!session) {
        this.logger.warn(`Failed to create session for ${phoneNumber}`);
        return 'Sorry, there was an issue starting your session. Please try again.';
      }

      // FIXED: First message always starts in INTRO (this restores the original working flow)
      if (!session.conversation_state) {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.INTRO
        });
        session.conversation_state = this.STATES.INTRO;
      }

      const currentState = session.conversation_state || this.STATES.INTRO;
      console.log('🗺️ STATE_CHECK session_id:', session.id?.slice(-6), 'raw_state:', JSON.stringify(session.conversation_state), 'currentState:', currentState, 'known:', !!this.stateHandlers[currentState]);

      // Global restart-intent interception: must run before the unknown-state guard so that
      // sessions with stale/unrecognized states still route to the menu on fresh-start words,
      // rather than falling through to handleFallbackState.
      const _globalText = (message || '').trim().toLowerCase();
      if (['hi', 'hello', 'hey', 'start', 'restart', 'home'].includes(_globalText)) {
        return await this.goToInteractiveMenu(session);
      }

      // Global region-change interception: if the user types "region" from any state other
      // than INTRO, reset the session (logout) and prompt for region on a clean session.
      // From INTRO, fall through to handleIntroState which already handles region selection.
      if ((_globalText === 'region' || _globalText === 'change region') && currentState !== this.STATES.INTRO) {
        const phone = session.phone_number || session.phoneNumber;
        await this.sessionManager.deleteSessionAndData(session.id);
        const freshSession = await this.sessionManager.getOrCreateSession(phone, true);
        return await this.handleIntroState(freshSession, 'region');
      }

      if (!this.stateHandlers[currentState]) {
        console.log('⚠️ UNKNOWN_STATE fallback triggered raw_state:', JSON.stringify(session.conversation_state), 'msg:', (message||'').slice(0,20));
        return await this.handleFallbackState(session, message);
      }

      // Region-binding wrapper
      const response = await this.withSessionRegion(session, async () => {
        return await this.stateHandlers[currentState](session, message);
      });

      if (session.id) {
        await this.sessionManager.db.addChatHistory(session.id, message, String(response));
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

  /** Convenience wrapper — always returns a plain string (text fallback for envelopes). */
  async handleMessage(message, phoneNumber) {
    return String(await this.handleMessageEnvelope(message, phoneNumber));
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

    let context = (session.context && typeof session.context === 'string')
      ? JSON.parse(session.context)
      : (session.context || {});
    const text = (message || '').trim().toLowerCase();

    // Helper: re-fetch session and render main menu with fresh context
    const renderMenuFresh = async () => {
      const fresh = await this.sessionManager.getSession(session.id);
      return await this.renderMainMenu(fresh || session);
    };

    // Auto-estimate region from phone if not set
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

    // Show region selection if needed
    if (!context.region || text === 'region' || text === 'change region' || context.awaiting_region_selection) {
      context.awaiting_region_selection = true;
      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        if (idx >= 0 && idx < regionCodes.length) {
          context.region = regionCodes[idx];
          delete context.awaiting_region_selection;
          await this.sessionManager.updateSession(session.id, { context });
          return await renderMenuFresh();
        }
      } else if (regionCodes.some(code => text.includes(regionLabels[code].toLowerCase()))) {
        const found = regionCodes.find(code => text.includes(regionLabels[code].toLowerCase()));
        context.region = found;
        delete context.awaiting_region_selection;
        await this.sessionManager.updateSession(session.id, { context });
        return await renderMenuFresh();
      }

      await this.sessionManager.updateSession(session.id, { context });
      return list('Please select your region:', 'Select region',
        regionCodes.map((code, i) => ({ id: String(i + 1), title: regionLabels[code] }))
      );
    }

    // Region is set → show Intro main menu for non-verified user
    if (!text || ['menu', 'hi', 'hello', 'hey', '0', 'back'].includes(text)) {
      return await this.renderMainMenu(session);
    }

    // Only "1" (book/manage) transitions to VERIFY (email + DOB)
    if (text === '1' || text.includes('book') || text.includes('manage')) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VERIFY,
        verified: false
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleVerifyState(updatedSession, '');
    }

    // Other options stay in Intro and call their handlers
    if (text === '2' || text.includes('fee')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VIEW_FEES });
      const fresh = await this.sessionManager.getSession(session.id);
      return await this.handleViewFeesState(fresh, '');
    }
    if (text === '3' || text.includes('location')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VIEW_LOCATIONS });
      const fresh = await this.sessionManager.getSession(session.id);
      return await this.handleViewLocationsState(fresh, '');
    }
    if (text === '4' || text.includes('register')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.REGISTER_PATIENT });
      const fresh = await this.sessionManager.getSession(session.id);
      return await this.handleRegisterPatientState(fresh, '');
    }

    return `Sorry, I didn't understand that.\n\n` + await this.renderMainMenu(session);
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
   * Handle user identity verification state.
   * - Allows user to go back to Intro menu with "0/menu/back".
   * - On verification failure, returns region-specific support info.
   * @param {object} session
   * @param {string} message
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

    // DOB parser: accepts "dd mm yyyy", "dd/mm/yyyy", "dd-mm-yyyy", "dd.mm.yyyy"
    const parseDob = (raw) => {
      const m = String(raw || '').trim().match(/^(\d{1,2})(?:[\s\/\-\.])+(\d{1,2})(?:[\s\/\-\.])+(\d{4})$/);
      if (!m) return null;
      const [, dd, mm, yyyy] = m;
      const d = new Date(Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10)));
      return isNaN(d.getTime()) ? null : `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    };

    const FAIL_PROMPT = buttons(
      "We couldn't verify those details. Please check your email and date of birth and try again.",
      [
        { id: '1', title: 'Try again' },
        { id: '2', title: 'Email us' },
        { id: '3', title: 'Main menu' }
      ]
    );

    // Handle the post-failure 3-option prompt
    if (data.verify_error_prompt === true) {
      if (text === '1') {
        // Restart from email
        const fresh = { verify_error_prompt: false, awaiting_email: true };
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: JSON.stringify(fresh) });
        return 'To verify your identity, please enter the email address you used to register with us.\n\n(0️⃣ Back to menu)';
      }
      if (text === '2') {
        const region = this._getSessionRegion(session);
        this.logger.info('[Verify] User requested outreach after failed verification', { sessionId: session.id, region });
        try {
          const emailPayload = await this._composeSupportEmailPayloadNoSlots(session, data);
          if (emailPayload && Array.isArray(emailPayload.to) && emailPayload.to.length) {
            emailPayload.subject = `[Verify Failed] Contact request — ${region} — ${session.phone_number || session.phoneNumber || ''}`;
            await this._postEmail(emailPayload);
          }
        } catch (e) {
          this.logger.error('[Verify] Failed to send outreach email', { error: e?.message || e, sessionId: session.id });
        }
        delete data.verify_error_prompt;
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, data: JSON.stringify(data) });
        const updated = await this.sessionManager.getSession(session.id);
        return `We've sent your details to our support team. They'll be in touch shortly.\n\n` + await this.renderMainMenu(updated);
      }
      if (text === '3') {
        delete data.verify_error_prompt;
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, data: JSON.stringify(data) });
        const updated = await this.sessionManager.getSession(session.id);
        return await this.renderMainMenu(updated);
      }
      // Unknown input in fail prompt — reprint it
      return FAIL_PROMPT;
    }

    // Step 1: ask for email
    if (!data.verify_email) {
      if (!data.awaiting_email) {
        data.awaiting_email = true;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return 'To verify your identity, please enter the email address you used to register with us.\n\n(0️⃣ Back to menu)';
      }
      // Validate and store email
      const email = textRaw.toLowerCase();
      if (!email.includes('@') || !email.includes('.')) {
        return 'That doesn\'t look like a valid email. Please enter a valid email address to proceed.\n\n(0️⃣ Back to menu)';
      }
      data.verify_email = email;
      delete data.awaiting_email;
      data.awaiting_dob = true;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Thanks. Now please enter your date of birth (e.g. 15 03 1985 or 15/03/1985).\n\n(0️⃣ Back to menu)';
    }

    // Step 2: collect and validate DOB
    if (!data.verify_dob) {
      if (!textRaw) {
        return 'Please enter your date of birth (e.g. 15 03 1985 or 15/03/1985).\n\n(0️⃣ Back to menu)';
      }
      const parsed = parseDob(textRaw);
      if (!parsed) {
        return 'That doesn\'t look like a valid date. Please enter as DD MM YYYY or DD/MM/YYYY (e.g. 15 03 1985).\n\n(0️⃣ Back to menu)';
      }
      data.verify_dob = parsed; // stored as YYYY-MM-DD
      delete data.awaiting_dob;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    }

    // Step 3: verify with API (email + dob in YYYY-MM-DD)
    const emailToFind = data.verify_email;
    const dobToFind   = data.verify_dob;

    const cleared = { ...data };
    delete cleared.awaiting_email;
    delete cleared.awaiting_dob;
    delete cleared.verify_email;
    delete cleared.verify_dob;

    try {
      const patient = await this.clinikoAPI.findPatientByEmailAndDob(emailToFind, dobToFind);

      if (patient && patient.id) {
        // Merge email into context so it survives subsequent data resets
        const existingCtx = (() => { try { return typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {}); } catch { return {}; } })();
        await this.sessionManager.updateSession(session.id, {
          verified: true,
          patient_id: patient.id,
          conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
          context: JSON.stringify({ ...existingCtx, email: patient.email || existingCtx.email || '' }),
          data: JSON.stringify(cleared)
        });
        const updated = await this.sessionManager.getSession(session.id);
        return 'Verification successful!\n\n' + await this.goToInteractiveMenu(updated);
      }

      // Verification failed — show 3-option prompt, stay in VERIFY state
      cleared.verify_error_prompt = true;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: JSON.stringify(cleared) });
      const region = this._getSessionRegion(session);
      const support = getSupportInfo(region);
      return buttons(
        `We couldn't verify those details. Please check your email and date of birth and try again, or contact support.\n\n${support}`,
        [
          { id: '1', title: 'Try again' },
          { id: '2', title: 'Email us' },
          { id: '3', title: 'Main menu' }
        ]
      );

    } catch (e) {
      this.logger.error('[handleVerifyState] API error during verification', { err: e?.message });
      cleared.verify_error_prompt = true;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: JSON.stringify(cleared) });
      return FAIL_PROMPT;
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
      // Verified users stay on the verified menu; going to INTRO would show the unverified landing
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.renderMainMenu(updatedSession);
    }
    if (text === '9' || text.includes('logout')) {
      await this.sessionManager.deleteSessionAndData(session.id);
      const updatedSession = await this.sessionManager.getOrCreateSession(
        session.phone_number || session.phoneNumber,
        true
      );
      // Explicitly clear any seeded verified state from prior sessions
      await this.sessionManager.updateSession(updatedSession.id, {
        verified: false,
        verification_status: 'unverified',
        patient_id: null,
        conversation_state: this.STATES.INTRO
      });
      const freshSession = await this.sessionManager.getSession(updatedSession.id);
      return '✅ All your data has been deleted and you are logged out.\n\n' +
        await this.renderMainMenu(freshSession);
    }

    if (text === '1' || text.includes('book')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS });
      return await this.renderBookingMethodMenu(session);
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
      return await this.goToInteractiveMenu(session);
    }
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
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      return await this.handleBookSpecificClinic(session, '');
    }
    return 'Please reply with a valid booking method (1-5).';
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

    // 0 — go back one choice step (navBack)
    if (text === '0' || text === 'back') {
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

    // 1 — go to main booking menu
    if (text === '1') {
      delete data.no_slots_prompt;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: JSON.stringify(data)
      });
      return await this.renderMainMenu(session);
    }

    // 2 — email us (sends transcript to support + user)
    if (text === '2') {
      let emailPayload = null;
      try {
        emailPayload = await this._composeSupportEmailPayloadNoSlots(session, data);
      } catch (e) {
        this.logger.error('[NoSlots] Failed to compose support email payload', { error: e?.message || e, sessionId: session.id });
      }

      if (emailPayload && Array.isArray(emailPayload.to) && emailPayload.to.length) {
        try {
          const body = JSON.stringify({ to: emailPayload.to, subject: emailPayload.subject, text: emailPayload.text });
          await new Promise((resolve, reject) => {
            const mailer = getMailerConfig();
            const client = mailer.protocol === 'https:' ? require('https') : require('http');
            const req = client.request(
              {
                method: 'POST',
                host: mailer.hostname,
                port: mailer.port,
                path: mailer.path,
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
              },
              (res) => {
                res.resume();
                if (res.statusCode === 200) {
                  this.logger.info('[NoSlots] Support email sent', { to: emailPayload.to, subject: emailPayload.subject, sessionId: session.id });
                  resolve();
                } else {
                  reject(new Error(`Mailer returned HTTP ${res.statusCode}`));
                }
              }
            );
            req.on('error', reject);
            req.write(body);
            req.end();
          });
        } catch (e) {
          this.logger.error('[NoSlots] Failed to send support email', { error: e?.message || e, sessionId: session.id });
        }
      } else {
        this.logger.warn('[NoSlots] No recipients resolved for support email — email not sent', { sessionId: session.id });
      }

      let context = session.context;
      if (context && typeof context === 'string') { try { context = JSON.parse(context); } catch {} }
      const region = (context && context.region) || emailPayload?.meta?.region || 'SG';
      const userPhone = session.phone_number || session.phoneNumber || emailPayload?.meta?.phone || '';

      delete data.no_slots_prompt;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: JSON.stringify(data)
      });
      return `Thanks! Our ${region} support team will be in touch shortly.\n\n` + await this.renderMainMenu(session);
    }

    // 3 — message us (show support phone number)
    if (text === '3') {
      let context = session.context;
      if (context && typeof context === 'string') { try { context = JSON.parse(context); } catch {} }
      const region = (context && context.region) || this._getSessionRegion(session) || 'SG';
      const info = REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG;

      delete data.no_slots_prompt;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: JSON.stringify(data)
      });
      return `You can reach our ${region} support team at ${info.phone}.\n\n` + await this.renderMainMenu(session);
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
        formatFn: (p, i) => `${i}. ${getPractitionerDisplayName(p.practitioner)}\n   Last seen: ${formatSlotDateTime(p.last_seen, this._regionTz(session))}`,
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

        data.appointment_type_list = sortAppointmentTypes(
          Array.from(buckets.values()).map(v => ({ name: v.displayName, norm_name: normName(v.displayName), ids: Array.from(v.ids) }))
        );
        data.appt_type_page = 0;
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

      if (/^m(ore)?$/i.test(text)) {
        data.appt_type_page = (Number(data.appt_type_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
      }

      if (/^\d+$/.test(text)) {
        const page = data.appt_type_page || 0;
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
        page: data.appt_type_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
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
        const _hsInfo = REGION_SUPPORT_INFO[this._getSessionRegion(session)] || REGION_SUPPORT_INFO.SG;
        return buttons(`No available slots for that combination.\n\nOr message us: ${_hsInfo.phone}\n\n(Reply 0 to go back one step)`, [
          { id: '1', title: 'Booking menu' },
          { id: '2', title: 'Email us' },
          { id: '3', title: 'Message us' }
        ]);
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
      session.conversation_state = this.STATES.SELECT_SLOT;
      session.data = JSON.stringify(slotData);

      const header = `${data.selected_appt_type.name} • ${getPractitionerDisplayName(data.selected_physio)} • ${data.selected_clinic.business_name}`;
      return this._buildSlotList(filtered, 0, header, this._regionTz(session));
    }

    // Fallback
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    return await this.goToInteractiveMenu(session);
  }

  /**
   * Book soonest available appointment.
   * Navigation-only changes. Fixes multi-ID type handling and back-stack.
   *
   * Why: Cliniko may assign different appointment_type IDs per practitioner
   * for the same human-readable name. Using a single ID collapses the physio
   * list to one person. Build a name→IDs map and aggregate across IDs.
   *
   * Steps: choose_type → choose_physio → choose_clinic → select_slot
   * Back: returns to the last step that had multiple options.
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

    // Use shared normalizer if present
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
     * True if this practitioner has at least one slot for the given type NAME
     * in the standard soonest window across any of their clinics.
     */
    const practitionerHasSlotsForTypeName = async (practitioner, typeNorm) => {
      const clinics = await clinicsForPractitioner(practitioner.id);
      if (!clinics.length) return false;
      const { from, to } = normalizeDateWindow();
      for (const c of clinics) {
        const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: String(c.id),
          practitioner_id: String(practitioner.id),
          from,
          to
        });
        const any = (raw || []).some(s => normName(s.appointment_type_name) === typeNorm);
        if (any) return true;
      }
      return false;
    };

    /**
     * Build physio list that offers the TYPE NAME and has at least one slot.
     */
    const buildAvailablePhysiosForTypeName = async (typeNorm) => {
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      const phys = []; const seen = new Set();
      // First collect by TYPE NAME
      for (const g of groups || []) {
        for (const p of g.practitioners || []) {
          if (seen.has(p.id)) continue;
          const types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
          if ((types || []).some(t => normName(t.name) === typeNorm)) {
            seen.add(p.id);
            phys.push(p);
          }
        }
      }
      // Filter out those without any slots in window
      const available = [];
      for (const p of phys) {
        if (await practitionerHasSlotsForTypeName(p, typeNorm)) available.push(p);
      }
      return available;
    };

    // Handle pending generic no-slots prompt but keep Soonest semantics intact
    if (data.no_slots_prompt && data.no_slots_prompt.context === 'soonest') {
      if (text === '1') { // Try another type
        delete data.no_slots_prompt;
        data.selection_step = 'choose_type';
        data.suppress_auto_advance = true; // prevent planForward from re-selecting the only type
        // clear downstream selections
        delete data.selected_appt_type; delete data.practitioner_list; delete data.selected_physio; delete data.clinic_list; delete data.selected_clinic;
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }
      if (text === '2') { // Try another physio
        delete data.no_slots_prompt;
        data.selection_step = 'choose_physio';
        delete data.selected_physio; delete data.clinic_list; delete data.selected_clinic;
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }
      if (text === '3') { // Try another clinic
        delete data.no_slots_prompt;
        data.selection_step = 'choose_clinic';
        delete data.selected_clinic;
        delete data.clinic_list; // force re-fetch so stale zero-slot list is not reused
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }
      // Any other input falls through and re-renders current step
    } else if (data.no_slots_prompt) {
      // Legacy context: fall back to generic handler
      const ret = await this._handleNoSlotsDecision(session, data, this.STATES.BOOK_SOONEST, this.handleBookSoonest, textRaw);
      if (ret) return ret;
    }

    // Contextual Back
    if (["0", "menu", "back"].includes(text)) {
      if (!data.selection_step || data.selection_step === 'choose_type') {
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
        return await this.goToInteractiveMenu(session);
      }

      if (data.selection_step === 'choose_physio') {
        // Go back to types
        const { list, map } = await buildTypeCatalogue();
        data.appointment_type_list = list; data.appt_type_name_to_ids_norm = map; data.appt_type_page = 0;
        delete data.selected_appt_type; delete data.practitioner_list; delete data.selected_physio;
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

      if (data.selection_step === 'choose_clinic') {
        // Back to physios for same type
        const typeNorm = normName(data.selected_appt_type?.name || '');
        const physios = typeNorm ? await buildAvailablePhysiosForTypeName(typeNorm) : [];
        if (physios.length > 1) {
          data.practitioner_list = physios; data.practitioner_page = 0; delete data.selected_physio;
          data.selection_step = 'choose_physio';
          await sync({ conversation_state: this.STATES.BOOK_SOONEST });
          const reply = formatPaginatedList({
            items: physios,
            formatFn: formatPhysioItem,
            page: 0,
            pageSize: MAX_SLOT_ITEMS,
            moreLabel: 'M. More practitioners',
            header: `Select a practitioner for ${data.selected_appt_type?.name || ''}:`
          }) + `\n\nReply with number. (0️⃣ Back)`;
          return reply;
        }
        // else back to types
        const { list, map } = await buildTypeCatalogue();
        data.appointment_type_list = list; data.appt_type_name_to_ids_norm = map; data.appt_type_page = 0;
        delete data.selected_appt_type; delete data.practitioner_list; delete data.selected_physio; delete data.clinic_list; delete data.selected_clinic;
        data.selection_step = 'choose_type';
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        const reply2 = formatPaginatedList({
          items: list,
          formatFn: (a, i) => `${i}. ${a.name}`,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More types',
          header: 'Choose appointment type:'
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply2;
      }

      // Fallback to booking options
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
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

    // ===== choose_type =====
    if (data.selection_step === 'choose_type') {
      const apptTypes = data.appointment_type_list || [];
      const page = data.appt_type_page || 0;

      const { advanced } = planForward(data, 'choose_type', apptTypes.length, () => { data.selected_appt_type = apptTypes[0]; });

      if (!advanced && /^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
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

      // Build AVAILABLE practitioners for this type name
      const typeNorm = data.selected_appt_type.norm_name || normName(data.selected_appt_type.name);
      const practitioners = await buildAvailablePhysiosForTypeName(typeNorm);

      data.practitioner_list = practitioners; data.practitioner_page = 0;
      data.selection_step = 'choose_physio';
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });

      navPush(data, 'choose_physio', { had_multiple_options: practitioners.length > 1, auto: practitioners.length === 1 });
      await sync();

      if (practitioners.length === 0) {
        // No physios have slots for this type → let user pick another type
        data.no_slots_prompt = { context: 'soonest' };
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return buttons(
          `No practitioners have available slots for ${data.selected_appt_type.name} in the next few days.`,
          [{ id: '1', title: 'Try another type' }]
        );
      }

      if (practitioners.length > 1) {
        const reply = formatPaginatedList({
          items: practitioners,
          formatFn: formatPhysioItem,
          page: 0,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More practitioners',
          header: `Select a practitioner for ${data.selected_appt_type.name}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }

      // Auto-advance to clinic when only one physio
      data.selected_physio = practitioners[0];
      data.selection_step = 'choose_clinic';
      await sync();
      return await this.handleBookSoonest(session, '');
    }

    // Paging in choose_physio
    if (data.selection_step === 'choose_physio' && (text === 'm' || text === 'more')) {
      data.practitioner_page = (data.practitioner_page || 0) + 1;
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
      return await this.handleBookSoonest(session, '');
    }

    // ===== choose_physio =====
    if (data.selection_step === 'choose_physio') {
      const practitionerList = data.practitioner_list || [];
      const page = data.practitioner_page || 0;

      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= practitionerList.length) return 'Invalid practitioner selection. Reply with a number from the list.';
        data.selected_physio = practitionerList[idx];
        data.selection_step = 'choose_clinic';
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }

      const reply = formatPaginatedList({
        items: practitionerList,
        formatFn: formatPhysioItem,
        page,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More practitioners',
        header: `Select a practitioner for ${data.selected_appt_type?.name || ''}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // Paging in choose_clinic
    if (data.selection_step === 'choose_clinic' && (text === 'm' || text === 'more')) {
      data.clinic_page = (data.clinic_page || 0) + 1;
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
      return await this.handleBookSoonest(session, '');
    }

    // ===== choose_clinic → SELECT_SLOT =====
    if (data.selection_step === 'choose_clinic') {
      // Prefilter clinics to only those with slots for selected physio & type
      if (!Array.isArray(data.clinic_list)) {
        const allClinics = await clinicsForPractitioner(data.selected_physio.id);
        const typeNorm = normName(data.selected_appt_type.name);
        const { from, to } = normalizeDateWindow();
        const withSlots = [];
        for (const c of allClinics) {
          const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
            business_id: String(c.id),
            practitioner_id: String(data.selected_physio.id),
            from,
            to
          });
          const any = (raw || []).some(s => normName(s.appointment_type_name) === typeNorm);
          if (any) withSlots.push(c);
        }
        data.clinic_list = withSlots; data.clinic_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });

        if (withSlots.length === 0) {
          // This physio actually has no slots for this type → go back to physio selection
          data.no_slots_prompt = { context: 'soonest' };
          data.selection_step = 'choose_physio';
          delete data.selected_physio; // force re-pick
          // Rebuild physio list to exclude zero-slot physio
          const rebuilt = await buildAvailablePhysiosForTypeName(typeNorm);
          data.practitioner_list = rebuilt; data.practitioner_page = 0;
          await sync({ conversation_state: this.STATES.BOOK_SOONEST });
          if (rebuilt.length === 0) {
            // No available physios left → go back to type
            data.selection_step = 'choose_type';
            delete data.selected_appt_type; delete data.practitioner_list;
            await sync({ conversation_state: this.STATES.BOOK_SOONEST });
            return await this.handleBookSoonest(session, '');
          }
          const reply = formatPaginatedList({
            items: rebuilt,
            formatFn: formatPhysioItem,
            page: 0,
            pageSize: MAX_SLOT_ITEMS,
            moreLabel: 'M. More practitioners',
            header: `No slots found. Select another practitioner for ${data.selected_appt_type.name}:`
          }) + `\n\nReply with number. (0️⃣ Back)`;
          return reply;
        }

        if (withSlots.length === 1) {
          navPush(data, 'choose_clinic', { had_multiple_options: false, auto: true });
          data.selected_clinic = withSlots[0];
          await sync();
        } else if (withSlots.length > 1) {
          navPush(data, 'choose_clinic', { had_multiple_options: true, auto: false });
          await sync();
        }
      }

      const clinics = data.clinic_list || [];
      const page = data.clinic_page || 0;

      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        if (idx < 0 || idx >= clinics.length) return 'Invalid clinic selection. Reply with a number from the list.';
        data.selected_clinic = clinics[idx];
        await sync();
      }

      if (!data.selected_clinic) {
        const reply = formatPaginatedList({
          items: clinics,
          formatFn: (c, i) => `${i}. ${c.business_name}`,
          page,
          pageSize: MAX_SLOT_ITEMS,
          moreLabel: 'M. More clinics',
          header: `Clinics for ${getPractitionerDisplayName(data.selected_physio)}:`
        }) + `\n\nReply with number. (0️⃣ Back)`;
        return reply;
      }

      // Fetch slots for selected combination
      const { from, to } = normalizeDateWindow();
      const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: String(data.selected_clinic.id),
        practitioner_id: String(data.selected_physio.id),
        from,
        to
      });

      const targetNorm = normName(data.selected_appt_type.name);
      const filtered = deduplicateSlots((raw || []).filter(s => normName(s.appointment_type_name) === targetNorm));

      if (!filtered.length) {
        // Extremely unlikely since clinics are prefiltered, but handle defensively.
        data.no_slots_prompt = { context: 'soonest' };
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return buttons(`No slots found for ${data.selected_appt_type?.name}.`, [
          { id: '1', title: 'Try another type' },
          { id: '2', title: 'Try another physio' },
          { id: '3', title: 'Try another clinic' }
        ]);
      }

      const slotData = {
        slot_list: filtered,
        slot_page: 0,
        last_selection_flow: 'soonest',
        prev_state_data: {
          selected_physio: data.selected_physio,
          selected_clinic: data.selected_clinic,
          selected_appt_type: data.selected_appt_type
        }
      };

      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(slotData) });
      session.conversation_state = this.STATES.SELECT_SLOT;
      session.data = JSON.stringify(slotData);

      const header = `${data.selected_appt_type.name} • ${getPractitionerDisplayName(data.selected_physio)} • ${data.selected_clinic.business_name}`;
      return this._buildSlotList(filtered, 0, header, this._regionTz(session));
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
   * - Stable indices and back behavior identical to other flows.
   *
   * Steps: choose_date -> choose_type -> choose_physio -> choose_clinic -> SELECT_SLOT
   *
   * @param {object} session
   * @param {string} message
   * @returns {Promise<string>}
   */
  async handleBookSpecificDate(session, message) {
    // ----- safe load -----
    let data;
    try { data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {}); } catch { data = {}; }
    if (!data || typeof data !== 'object') data = {};
    if (!data.navigation_chain) data.navigation_chain = [];

    const raw = String(message || '');
    const text = raw.trim().toLowerCase();
    const sync = async (patch = {}) => {
      session.data = JSON.stringify(data);
      if (patch.conversation_state) session.conversation_state = patch.conversation_state;
      await this.sessionManager.updateSession(session.id, { ...patch, data: session.data });
    };
    const normName = (s) => (typeof normalizeTypeName === 'function' ? normalizeTypeName(s) : String(s || '').toLowerCase().trim());
    const ymdLocal = (d) => { const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; };

    // ----- no-slots decision (must run before back/nav to handle "1","2","3" replies) -----
    if (data.no_slots_prompt) {
      const ret = await this._handleNoSlotsDecision(session, data, this.STATES.BOOK_SPECIFIC_DATE, this.handleBookSpecificDate, raw);
      if (ret) return ret;
    }

    // ----- global back/menu -----
    if (text === 'back' || text === 'menu') {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }
    if (text === '0' && data.selection_step && data.selection_step !== 'choose_date') {
      const current = data.selection_step;
      const { step, popped } = typeof navBack === 'function' ? navBack(data) : { step: null };
      if (step && step !== current) {
        if (typeof clearForwardStateForPopped === 'function') clearForwardStateForPopped(data, popped);
        data.selection_step = step;
        data.suppress_auto_advance = true;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        // no recursion
        return await this.handleBookSpecificDate(session, '');
      }
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }

    // ----- init -----
    if (!data.selection_step) {
      data.selection_step = 'choose_date';
      data.date_page = 0;
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
    }

    // =====================================================================
    // choose_date — 10 dates from tomorrow, skip Sundays, 5 per page
    // =====================================================================
    if (data.selection_step === 'choose_date') {
      const MAX_DATE_ITEMS = 5;
      const MAX_DATE_PAGES = 2;

      // build 10 forward dates excluding Sundays
      const candidates = [];
      let d = new Date();
      d.setHours(0,0,0,0);
      d.setDate(d.getDate() + 1);
      while (candidates.length < MAX_DATE_ITEMS * MAX_DATE_PAGES) {
        if (d.getDay() !== 0) candidates.push(new Date(d));
        d.setDate(d.getDate() + 1);
      }

      const page = Math.max(0, Math.min(Number(data.date_page) || 0, MAX_DATE_PAGES - 1));
      const pageItems = candidates.slice(page * MAX_DATE_ITEMS, page * MAX_DATE_ITEMS + MAX_DATE_ITEMS);

      // numeric pick FIRST (sanitize digits)
      const numStr = text.replace(/[^\d]/g, '');
      if (numStr) {
        const idx = parseInt(numStr, 10) - 1; // 0..4
        const picked = pageItems[idx];
        if (picked) {
          // advance state without recursion
          data.selected_date = ymdLocal(picked);
          data.selection_step = 'choose_type';
          if (typeof navPush === 'function') navPush(data, 'choose_type', { had_multiple_options: true, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });

          // ----- INLINE RENDER: choose_type -----
          if (!Array.isArray(data.appointment_type_list)) {
            const groups = await this.clinikoAPI.getPractitionersByClinic();
            const allTypes = await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
            const buckets = new Map();
            for (const t of allTypes || []) {
              if (!t || !t.name) continue;
              if (/UWC/i.test(t.name)) continue;
              const display = String(t.name).replace(/\s+/g,' ').replace(/([A-Za-z])\(/g,'$1 (').replace(/\s+\)/g,')').trim();
              const n = normName(display);
              if (!buckets.has(n)) buckets.set(n, { displayName: display, ids: new Set() });
              buckets.get(n).ids.add(String(t.id));
            }
            data.appointment_type_list = Array.from(buckets.values())
              .map(v => ({ name: v.displayName, ids: Array.from(v.ids), norm: normName(v.displayName) }))
              data.appointment_type_list = sortAppointmentTypes(data.appointment_type_list);
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          }

          const headerDate = new Date(`${data.selected_date}T00:00:00Z`).toLocaleDateString();
          const reply = formatPaginatedList({
            items: data.appointment_type_list || [],
            formatFn: (a,i)=>`${i}. ${a.name}`,
            page: 0,
            pageSize: MAX_SLOT_ITEMS,
            moreLabel: 'M. More types',
            header: `Select visit type for ${headerDate}:`
          }) + `\n\nReply with number. (0️⃣ Back)`;
          return reply;
        }
      }

      // page back
      if (text === '0') {
        if (page > 0) {
          data.date_page = page - 1;
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        } else {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
          return await this.goToInteractiveMenu(session);
        }
      }

      // page forward
      if (text === 'm' || text === 'more') {
        if (page < (MAX_DATE_PAGES - 1)) {
          data.date_page = page + 1;
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        }
      }

      // render date page
      const cur = Math.max(0, Math.min(Number(data.date_page) || 0, MAX_DATE_PAGES - 1));
      const slice = candidates.slice(cur * MAX_DATE_ITEMS, cur * MAX_DATE_ITEMS + MAX_DATE_ITEMS);
      const list = slice.map((dt, i) => `${i + 1}. ${dt.toLocaleDateString()}`).join('\n');
      const more = cur < (MAX_DATE_PAGES - 1) ? `\nM. More dates` : '';
      const hint = cur < (MAX_DATE_PAGES - 1) ? ' or M for more' : '';
      return `Pick a date (Page ${cur + 1}/${MAX_DATE_PAGES}):\n${list}${more}\n\nReply with number${hint}. (0️⃣ Back)`;
    }

    // =====================================================================
    // choose_type
    // =====================================================================
    if (data.selection_step === 'choose_type') {
      if (!Array.isArray(data.appointment_type_list)) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const allTypes = await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
        const buckets = new Map();
        for (const t of allTypes || []) {
          if (!t || !t.name) continue;
          if (/UWC/i.test(t.name)) continue;
          const display = String(t.name).replace(/\s+/g,' ').replace(/([A-Za-z])\(/g,'$1 (').replace(/\s+\)/g,')').trim();
          const n = normName(display);
          if (!buckets.has(n)) buckets.set(n, { displayName: display, ids: new Set() });
          buckets.get(n).ids.add(String(t.id));
        }
        data.appointment_type_list = sortAppointmentTypes(
          Array.from(buckets.values()).map(v => ({ name: v.displayName, ids: Array.from(v.ids), norm: normName(v.displayName) }))
        );
        data.appt_type_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

      if (/^m(ore)?$/i.test(text)) {
        data.appt_type_page = (Number(data.appt_type_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

      const numOnly = text.replace(/[^\d]/g, '');
      if (numOnly) {
        const page = data.appt_type_page || 0;
        const idx = parseInt(numOnly, 10) - 1;
        const list = data.appointment_type_list || [];
        if (idx >= 0 && idx < list.length) {
          data.selected_appt_type = list[idx];
          data.selection_step = 'choose_physio';
          if (typeof navPush === 'function') navPush(data, 'choose_physio', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          return await this.handleBookSpecificDate(session, '');
        }
      }

      const headerDate = new Date(`${data.selected_date}T00:00:00Z`).toLocaleDateString();
      const reply = formatPaginatedList({
        items: data.appointment_type_list || [],
        formatFn: (a,i)=>`${i}. ${a.name}`,
        page: data.appt_type_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
        header: `Select visit type for ${headerDate}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // =====================================================================
    // choose_physio — physios who offer that type
    // =====================================================================
    if (data.selection_step === 'choose_physio') {
      if (!Array.isArray(data.practitioner_list)) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const practitioners = await getPractitionersForTypeName(groups || [], this.clinikoAPI, data.selected_appt_type?.name || '');
        data.practitioner_list = (practitioners || []).map(p => ({ id: String(p.id), ...p }));
        data.practitioner_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        const list = data.practitioner_list || [];
        if (idx >= 0 && idx < list.length) {
          data.selected_physio = list[idx];
          data.selection_step = 'choose_clinic';
          if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          return await this.handleBookSpecificDate(session, '');
        }
      }

      const headerDate = new Date(`${data.selected_date}T00:00:00Z`).toLocaleDateString();
      const reply = formatPaginatedList({
        items: data.practitioner_list || [],
        formatFn: (p,i)=>`${i}. ${getPractitionerDisplayName ? getPractitionerDisplayName(p) : (p.display_name||p.name)}`,
        page: data.practitioner_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More physios',
        header: `Choose a physio for ${data.selected_appt_type?.name || 'visit'} on ${headerDate}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // =====================================================================
    // choose_clinic — clinics where that physio works (exclude UWC)
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
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

      if (/^\d+$/.test(text)) {
        const list = data.clinic_list || [];
        const idx = parseInt(text, 10) - 1;
        if (idx >= 0 && idx < list.length) {
          data.selected_clinic = list[idx];
          data.selection_step = 'view_slots';
          if (typeof navPush === 'function') navPush(data, 'view_slots', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          return await this.handleBookSpecificDate(session, '');
        }
      }

      const headerDate = new Date(`${data.selected_date}T00:00:00Z`).toLocaleDateString();
      const reply = formatPaginatedList({
        items: data.clinic_list || [],
        formatFn: (c,i)=>`${i}. ${getBusinessDisplayName ? getBusinessDisplayName(c) : c.business_name}`,
        page: data.clinic_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More clinics',
        header: `Select a clinic for ${getPractitionerDisplayName(data.selected_physio)} on ${headerDate}:`
      }) + `\n\nReply with number. (0️⃣ Back)`;
      return reply;
    }

    // =====================================================================
    // view_slots — exact selected date via normalizeDateWindow
    // =====================================================================
    if (data.selection_step === 'view_slots') {
      const date = data.selected_date; // 'YYYY-MM-DD'
      const { from, to } = normalizeDateWindow(date, date, 1);

      const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: String(data.selected_clinic.id),
        practitioner_id: String(data.selected_physio.id),
        from,
        to
      });

      const typeNorm = normName(data.selected_appt_type?.name || '');
      const slots = deduplicateSlots((raw || []).filter(s => normName(s.appointment_type_name) === typeNorm));
      if (!slots.length) {
        // Pop view_slots off the nav stack so a single "0" goes back to choose_clinic,
        // not back into view_slots (which would just re-fail and need a second "0").
        if (typeof navBack === 'function') navBack(data);
        data.selection_step = 'choose_clinic';
        delete data.clinic_list; // force clinic list to re-render fresh
        // Offer support contact option, consistent with other no-slots flows.
        data.no_slots_prompt = true;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        const _sdInfo = REGION_SUPPORT_INFO[this._getSessionRegion(session)] || REGION_SUPPORT_INFO.SG;
        return buttons(
          `No slots for ${data.selected_appt_type?.name} on that date at ${getBusinessDisplayName(data.selected_clinic) || 'this clinic'}.\n\nOr message us: ${_sdInfo.phone}\n\n(Reply 0 to go back one step)`,
          [
            { id: '1', title: 'Booking menu' },
            { id: '2', title: 'Email us' },
            { id: '3', title: 'Message us' }
          ]
        );
      }

      const slotData = {
        slot_list: slots,
        slot_page: 0,
        last_selection_flow: 'date',
        prev_state_data: {
          selected_physio: data.selected_physio,
          selected_clinic: data.selected_clinic,
          selected_appt_type: data.selected_appt_type,
          selected_date: data.selected_date
        }
      };
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.SELECT_SLOT, data: JSON.stringify(slotData) });
      session.conversation_state = this.STATES.SELECT_SLOT;
      session.data = JSON.stringify(slotData);

      const header = `${data.selected_appt_type?.name} • ${getPractitionerDisplayName(data.selected_physio)} • ${getBusinessDisplayName(data.selected_clinic)} • ${new Date(`${date}T00:00:00Z`).toLocaleDateString()}`;
      return this._buildSlotList(slots, 0, header, this._regionTz(session));
    }

    // fallback
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    return await this.goToInteractiveMenu(session);
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
    const sync = async (patch = {}) => {
      session.data = JSON.stringify(data);
      if (patch.conversation_state) session.conversation_state = patch.conversation_state;
      await this.sessionManager.updateSession(session.id, { ...patch, data: session.data });
    };

    const normName = (s) => (typeof normalizeTypeName === 'function' ? normalizeTypeName(s) : String(s || '').toLowerCase().trim());

    // ---------- no-slots decision (must run before back/nav to handle "1","2","3" replies) ----------
    if (data.no_slots_prompt) {
      const ret = await this._handleNoSlotsDecision(session, data, this.STATES.BOOK_SPECIFIC_PHYSIO, this.handleBookSpecificPhysio, textRaw);
      if (ret) return ret;
    }

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

      if (/^m(ore)?$/i.test(text)) {
        data.practitioner_page = (Number(data.practitioner_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      if (/^\d+$/.test(text)) {
        const idx = parseInt(text,10) - 1;
        const list = data.practitioner_list || [];
        if (idx >= 0 && idx < list.length) {
          data.selected_physio = list[idx];
          data.selection_step = 'choose_type';
          if (typeof navPush === 'function') navPush(data, 'choose_type', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          return await this.handleBookSpecificPhysio(session, '');
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
          const display = String(t.name).replace(/\s+/g,' ').replace(/([A-Za-z])\(/g,'$1 (').replace(/\s+\)/g,')').trim();
          const n = normName(display);
          if (!buckets.has(n)) buckets.set(n, { displayName: display, ids: new Set() });
          buckets.get(n).ids.add(String(t.id));
        }
        data.appointment_type_list = sortAppointmentTypes(
          Array.from(buckets.values()).map(v => ({ name: v.displayName, ids: Array.from(v.ids), norm: normName(v.displayName) }))
        );
        data.appt_type_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      if (/^m(ore)?$/i.test(text)) {
        data.appt_type_page = (Number(data.appt_type_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      if (/^\d+$/.test(text)) {
        const page = data.appt_type_page || 0;
        const idx = parseInt(text,10) - 1;
        const list = data.appointment_type_list || [];
        if (idx >= 0 && idx < list.length) {
          data.selected_appt_type = list[idx];
          data.selection_step = 'choose_clinic';
          if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          return await this.handleBookSpecificPhysio(session, '');
        }
      }

      const reply = formatPaginatedList({
        items: data.appointment_type_list || [],
        formatFn: (a,i)=>`${i}. ${a.name}`,
        page: data.appt_type_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
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
        const idx = parseInt(text, 10) - 1;
        if (idx >= 0 && idx < list.length) {
          data.selected_clinic = list[idx];
          data.selection_step = 'view_slots';
          if (typeof navPush === 'function') navPush(data, 'view_slots', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          return await this.handleBookSpecificPhysio(session, '');
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
      if (!slots.length) {
        data.no_slots_prompt = true;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO,
          data: JSON.stringify(data)
        });
        session.conversation_state = this.STATES.BOOK_SPECIFIC_PHYSIO;
        session.data = JSON.stringify(data);
        const _spInfo = REGION_SUPPORT_INFO[this._getSessionRegion(session)] || REGION_SUPPORT_INFO.SG;
        return buttons(
          `No slots found for ${data.selected_appt_type?.name || 'this appointment type'} at ${getBusinessDisplayName(data.selected_clinic) || 'this clinic'}.\n\nOr message us: ${_spInfo.phone}\n\n(Reply 0 to go back one step)`,
          [
            { id: '1', title: 'Booking menu' },
            { id: '2', title: 'Email us' },
            { id: '3', title: 'Message us' }
          ]
        );
      }

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
      session.conversation_state = this.STATES.SELECT_SLOT;
      session.data = JSON.stringify(slotData);

      const header = `${data.selected_appt_type?.name} • ${getPractitionerDisplayName(data.selected_physio)} • ${getBusinessDisplayName(data.selected_clinic)}`;
      return this._buildSlotList(slots, 0, header, this._regionTz(session));
    }

    // fallback
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    return await this.goToInteractiveMenu(session);
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
    const sync = async (patch = {}) => {
      session.data = JSON.stringify(data);
      if (patch.conversation_state) session.conversation_state = patch.conversation_state;
      await this.sessionManager.updateSession(session.id, { ...patch, data: session.data });
    };

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
        const idx = parseInt(numStr, 10) - 1;
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
        data.appointment_type_list = sortAppointmentTypes(
          Array.from(buckets.values()).map(v => ({ name: v.display, norm_name: normName(v.display), ids: Array.from(v.ids) }))
        );
        data.appt_type_page = 0;
        data.appt_type_name_to_ids_norm = Object.fromEntries((data.appointment_type_list || []).map(x => [x.norm_name, x.ids]));

        const fwd = typeof planForward === 'function' ? planForward(data, 'choose_type', data.appointment_type_list.length, () => {
          data.selected_appt_type = data.appointment_type_list[0];
          data.selection_step = 'choose_physio';
        }) : { advanced: false };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (fwd.advanced) return await this.handleBookSpecificClinic(session, '');
      }

      if (/^m(ore)?$/i.test(text)) {
        data.appt_type_page = (Number(data.appt_type_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      }

      if (numStr && !data.selected_appt_type) {
        const page = data.appt_type_page || 0;
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
        page: data.appt_type_page || 0,
        pageSize: MAX_SLOT_ITEMS,
        moreLabel: 'M. More types',
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
        const idx = parseInt(numStr, 10) - 1;
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
      session.conversation_state = this.STATES.SELECT_SLOT;
      session.data = JSON.stringify(slotData);

      const header = `${data.selected_appt_type?.name} • ${getPractitionerDisplayName ? getPractitionerDisplayName(data.selected_physio) : ''} • ${getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic) : ''}`;
      return this._buildSlotList(slots, 0, header, this._regionTz(session));
    }

    // fallback
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    return await this.goToInteractiveMenu(session);
  }

  /**
   * Handles user selection of an appointment slot in any workflow leading to SELECT_SLOT state.
   * - Adds consistent 3-option no-slots handling:
   *   1. Go back one level
   *   2. Have someone reach out (region-specific support email is logged)
   *   3. Go to main menu
   * - Keeps time-only slot lines (header shows context).
   * - "Back" returns to the originating flow via last_selection_flow.
   * @param {object} session - The user session object.
   * @param {string} message - The user's input (expected: slot number).
   * @returns {Promise<string>} Message to send to the user.
   */
  async handleSelectSlotState(session, message) {
    const log = this.logger.child({ component: 'SelectSlot', sessionId: session?.id });
    let data;
    try {
      data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    } catch (e) { data = {}; }
    const slots = Array.isArray(data.slot_list) ? data.slot_list : [];
    let text = (message || '').trim().toLowerCase();

    // If awaiting no-slots decision (3 options), process it first
    if (data.no_slots_prompt) {
      // SELECT_SLOT can be reached from multiple flows; route back using last_selection_flow
      // We choose the appropriate backHandler below based on prev flow
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

    if (text === 'm' || text === 'more' || text === 'next') {
      data.slot_page = (data.slot_page || 0) + 1;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      log.info('Slots page advanced', { page: data.slot_page });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleSelectSlotState(updatedSession, '');
    }

    if (text === 'p' || text === 'prev') {
      data.slot_page = Math.max(0, (data.slot_page || 0) - 1);
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleSelectSlotState(updatedSession, '');
    }

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

    // When no slots are present in this state (edge case), offer 3-option prompt
    if (!slots.length) {
      // Prepare no-slots prompt and let helper process next user reply
      data.no_slots_prompt = true;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_SLOT,
        data: JSON.stringify(data)
      });
      const _ssInfo = REGION_SUPPORT_INFO[this._getSessionRegion(session)] || REGION_SUPPORT_INFO.SG;
      return buttons(`No available slots to show.\n\nOr message us: ${_ssInfo.phone}\n\n(Reply 0 to go back one step)`, [
        { id: '1', title: 'Booking menu' },
        { id: '2', title: 'Email us' },
        { id: '3', title: 'Message us' }
      ]);
    }

    const page = data.slot_page || 0;
    if (!isNaN(text) && text !== '') {
      const start = this._slotPageStart(page);
      const count = this._slotPageCount(page);
      const idx = parseInt(text, 10) - 1;
      if (isNaN(idx) || idx < start || idx >= Math.min(start + count, slots.length)) {
        return 'Invalid slot selection. Please reply with a number from the list, or 0️⃣ to go back.';
      }
      const selectedSlot = slots[idx];
      data.selected_slot = selectedSlot;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.CONFIRM_BOOKING,
        data: JSON.stringify(data)
      });
      const dt = new Date(selectedSlot.slot);
      log.info('Slot chosen', {
        practitioner_id: selectedSlot.practitioner_id,
        business_id: selectedSlot.business_id,
        appt_type_id: selectedSlot.appointment_type_id,
        slot: selectedSlot.slot
      });

      // Build concise confirmation with context in header
      const headerParts = [];
      if (data.prev_state_data?.selected_appt_type?.name) headerParts.push(`${data.prev_state_data.selected_appt_type.name}`);
      if (data.prev_state_data?.selected_physio?.display_name || data.prev_state_data?.selected_physio?.first_name) headerParts.push(`${data.prev_state_data.selected_physio.display_name || data.prev_state_data.selected_physio.first_name}`);
      if (data.prev_state_data?.selected_clinic?.business_name) headerParts.push(`${data.prev_state_data.selected_clinic.business_name}`);
      const header = headerParts.length ? headerParts.join(' • ') : (selectedSlot.practitioner_name || 'Appointment');

      return buttons(
        `You have selected:\n\n• ${header}\n• ${formatSlotDateTime(dt, this._regionTz(session))}`,
        [
          { id: 'yes', title: 'Confirm booking' },
          { id: '0',   title: 'Go back' }
        ]
      );
    }

    // Build a single header if context exists
    let header = 'Available slots:';
    if (data.prev_state_data?.selected_appt_type || data.prev_state_data?.selected_physio || data.prev_state_data?.selected_clinic) {
      const parts = [];
      if (data.prev_state_data?.selected_appt_type?.name) parts.push(data.prev_state_data.selected_appt_type.name);
      if (data.prev_state_data?.selected_physio?.display_name || data.prev_state_data?.selected_physio?.first_name) {
        parts.push(data.prev_state_data.selected_physio.display_name || data.prev_state_data.selected_physio.first_name);
      }
      if (data.prev_state_data?.selected_clinic?.business_name) parts.push(data.prev_state_data.selected_clinic.business_name);
      header = parts.join(' • ');
    }

    return this._buildSlotList(slots, page, header, this._regionTz(session));
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
      return await this.renderBookingMethodMenu(session);
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
      const enrichedArr = await enrichAppointmentsForDisplay([enrichableSlot], this.clinikoAPI, this._regionTz(session));
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
        // Send booking confirmation email (best-effort)
        try {
          const { subject, html, text } = bookingConfirmed({
            practitioner: enrichedSlot._practitioner_display || enrichedSlot.practitioner_name || '—',
            clinic:       enrichedSlot._business_display || '—',
            dateTime:     formatSlotDateTime(dt, this._regionTz(session)),
            apptType:     enrichedSlot._appointment_type_display || enrichedSlot.appointment_type_name || '',
          });
          const ctx = (() => { try { return typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {}); } catch { return {}; } })();
          const region = String(ctx.region || 'SG').trim();
          const supportEmail = (REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG).email;
          const userEmail = String(ctx.email || session.email || '').trim();
          const to = [];
          if (supportEmail) to.push(supportEmail);
          if (userEmail)    to.push(userEmail);
          await this._postEmail({ to, subject, html, text });
        } catch (e) {
          this.logger.error('[Booking] Confirmation email send failed', { error: e?.message || e, sessionId: session.id });
        }
        // --- Debug: Booking success, show enriched details ---
        return (
          `✅ Your appointment is booked for:\n` +
          `👨‍⚕️ *${enrichedSlot._practitioner_display || enrichedSlot.practitioner_name}*\n` +
          `🏥 *${enrichedSlot._business_display || ''}*\n` +
          `🗓️ ${formatSlotDateTime(dt, this._regionTz(session))}\n\n` +
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
    return buttons(
      `You have selected:\n\n` +
      `👨‍⚕️ *${enrichedSlot._practitioner_display || enrichedSlot.practitioner_name}*\n` +
      `🏥 *${enrichedSlot._business_display || ''}*\n` +
      `🗓️ ${formatSlotDateTime(dt, this._regionTz(session))}`,
      [
        { id: 'yes', title: 'Confirm booking' },
        { id: '0',   title: 'Go back' }
      ]
    );
  }

  // ========== VIEW FEES / LOCATIONS / REGISTER (REUSE) ==========

  async handleViewFeesState(session, message) {
    const region = this._getSessionRegion(session);

    const FEE_DATA = {
      SG: [
        { name: 'Prohealth In Touch Physiotherapy', initial: 'SGD 190', followup: 'SGD 160' },
        { name: 'UWC East',  initial: 'SGD 170', followup: 'SGD 140' },
        { name: 'UWC Dover', initial: 'SGD 175', followup: 'SGD 145' },
      ],
      HK: [
        { name: 'Prohealth Hong Kong', initial: 'HKD 1,200', followup: 'HKD 900' },
      ],
      IN: [
        { name: 'Prohealth India', initial: 'INR 2,500', followup: 'INR 1,800' },
      ],
      PH: [
        { name: 'Prohealth Philippines', initial: 'PHP 2,800', followup: 'PHP 2,200' },
      ],
    };

    const clinics = FEE_DATA[region] || FEE_DATA.SG;
    const lines = clinics.map(c =>
      `🏥 *${c.name}*\n• Initial: ${c.initial}\n• Follow-up: ${c.followup}`
    ).join('\n\n');

    const fees = `💰 *Fee Structure by Clinic*\n\n${lines}`;
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
    const fresh = await this.sessionManager.getSession(session.id);
    return fees + '\n\n' + await this.renderMainMenu(fresh);
  }

  async handleViewLocationsState(session, message) {
    const clinics = await this.clinikoAPI.getClinics();
    const displayText = clinics.map(c => formatClinicForWhatsApp(c)).join('\n\n');
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
    const fresh = await this.sessionManager.getSession(session.id);
    return `Here are our clinic locations:\n\n${displayText}\n\n` + await this.renderMainMenu(fresh);
  }

  /**
   * Handle patient registration flow with support for "0/back/menu".
   * - At any prompt, typing "0"/"back"/"menu" cancels registration and returns to the Intro menu.
   * - Preserves your required fields order: first_name -> last_name -> email.
   * - Uses only ClinikoAPI.registerNewPatient; does not change Logger or API contracts.
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

    // Collect required fields in order
    const required = ['first_name', 'last_name', 'email'];
    let next = null;
    for (const f of required) {
      if (!data[f]) { next = f; break; }
    }

    if (next) {
      if (text) {
        data[next] = text;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        log.info('Collected field', { field: next });
      }
      if (!data.first_name) return "Please tell me your first name:\n(0️⃣ Back)";
      if (!data.last_name)  return "Got it. What's your last name?\n(0️⃣ Back)";
      if (!data.email)      return "Thanks. Lastly, what's your email address?\n(0️⃣ Back)";
    }

    // All fields collected → register
    const phoneNumber = session.phone_number || session.phoneNumber;
    if (!data.email || !phoneNumber) {
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.INTRO,
        verified: false
      });
      const updated = await this.sessionManager.getSession(session.id);
      log.warn('Missing email or phone for registration');
      return "We need both email and phone number to complete registration.\n\n" + await this.renderMainMenu(updated);
    }

    const patient = {
      first_name: data.first_name,
      last_name:  data.last_name,
      email:      data.email,
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
        // Extract the new patient's ID from the Cliniko response
        const newPatientId = result?.id || result?.patient?.id || null;
        if (!newPatientId) {
          this.logger.warn('[Register] Cliniko response missing patient id', { result });
        }
        // Persist patient_id on the session + store email in context (survives data resets)
        const existingCtx = (() => { try { return typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {}); } catch { return {}; } })();
        await this.sessionManager.updateSession(session.id, {
          patient_id: newPatientId ? String(newPatientId) : undefined,
          verified: true,
          conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
          context: JSON.stringify({ ...existingCtx, email: patient.email || '' }),
          data: JSON.stringify({})
        });
        const updated = await this.sessionManager.getSession(session.id);
        log.info('Registration success', { email: patient.email, patient_id: newPatientId });
        return `✅ You've been registered!\n\n` + await this.renderMainMenu(updated);
      }
      log.warn('Registration returned falsy result');
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      return "Sorry, we couldn't complete registration right now.\n\n" + await this.renderMainMenu(session);
    } catch (e) {
      log.error('Registration error', { err: e?.message || e });
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      return "We hit an error while registering you. Please try again later.\n\n" + await this.renderMainMenu(session);
    }
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

    futureAppts = await enrichAppointmentsForDisplay(futureAppts, this.clinikoAPI, this._regionTz(session));

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
      ? `You have one upcoming appointment:\n\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}`
      : `You selected:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}`;
    return buttons(`${intro}\n\nConfirm cancellation?`, [
      { id: 'yes', title: 'Yes, cancel' },
      { id: '0',   title: 'Go back' }
    ]);
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
    const text = (message || '').trim().toLowerCase();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});

    // Back/menu
    if (["0", "menu", "back"].includes(text)) {
      delete data.cancel_appt_list; delete data.selected_cancel_appt; delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }

    // Require explicit yes
    if (text !== 'yes') {
      const appt = data.selected_cancel_appt;
      const intro = appt
        ? `You are cancelling:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}`
        : 'Confirm cancellation?';
      return buttons(`${intro}\n\nConfirm cancellation?`, [
        { id: 'yes', title: 'Yes, cancel' },
        { id: '0',   title: 'Go back' }
      ]);
    }

    const appt = data.selected_cancel_appt;
    if (!appt || !appt.id) {
      delete data.cancel_appt_list; delete data.selected_cancel_appt; delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
    }

    const result = await this.clinikoAPI.cancelSpecificAppointment(appt.id.toString());

    delete data.cancel_appt_list; delete data.selected_cancel_appt; delete data.selected_cancel_appt_idx;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });

    if (result && result.success) {
      // Send cancellation confirmation email (best-effort)
      try {
        const emailPayload = await this._composeSupportEmailPayloadCancelled(session, data, appt, { failed: false });
        await this._postEmail(emailPayload);
      } catch (e) {
        this.logger.error('[Cancel] Email send failed', { error: e?.message || e, sessionId: session.id });
      }
      return `✅ Your appointment has been cancelled.\n\n` + await this.goToInteractiveMenu(session);
    }

    // Cancellation failed — send contact/failure email
    try {
      const emailPayload = await this._composeSupportEmailPayloadCancelled(session, data, appt, { failed: true });
      await this._postEmail(emailPayload);
    } catch (e) {
      this.logger.error('[Cancel] Failure email send failed', { error: e?.message || e, sessionId: session.id });
    }
    return `❌ Could not cancel your appointment. ${result?.message || ''}\n\n` + await this.goToInteractiveMenu(session);
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

    futureAppts = await enrichAppointmentsForDisplay(futureAppts, this.clinikoAPI, this._regionTz(session));

    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.reschedule_appt_list = futureAppts;
    data.selected_reschedule_appt = undefined;
    data.selected_reschedule_appt_idx = undefined;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });

    if (futureAppts.length === 1) {
      data.selected_reschedule_appt = futureAppts[0];
      data.selected_reschedule_appt_idx = 0;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this._rescheduleShowConfirm(session, data, true);
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
    const noSlotsResult = await this._handleNoSlotsDecision(session, data, this.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE, this.handleSelectAppointmentToRescheduleState, message);
    if (noSlotsResult !== null) return noSlotsResult;

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
    return await this._rescheduleShowConfirm(session, data, false);
  } 

  /**
   * Step 1 of reschedule: show appointment details and ask for YES/NO confirmation.
   * Transitions to RESCHEDULE_CONFIRM_INTENT state.
   */
  async _rescheduleShowConfirm(session, data, isSingle) {
    const appt = data.selected_reschedule_appt;
    if (!appt) {
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
    }
    data.is_single_reschedule_appt = isSingle;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.RESCHEDULE_CONFIRM_INTENT,
      data: JSON.stringify(data)
    });
    const intro = isSingle
      ? `You have one upcoming appointment:\n\n*${appt._practitioner_display} — ${appt._appointment_type_display}*\n${appt._display_dt}`
      : `You selected to reschedule:\n*${appt._practitioner_display} — ${appt._appointment_type_display}*\n${appt._display_dt}`;
    return buttons(`${intro}\n\nWould you like to proceed?`, [
      { id: 'yes', title: 'Yes, reschedule' },
      { id: '0',   title: 'Go back' }
    ]);
  }

  /**
   * Step 2 of reschedule: fetch available slots and show the paginated list.
   * Transitions to CONFIRM_RESCHEDULE state.
   */
  async _rescheduleFetchAndShowSlots(session, data) {
    const appt = data.selected_reschedule_appt;
    if (!appt) {
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
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      data.no_slots_prompt = true;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE,
        data: JSON.stringify(data)
      });
      const _rsInfo = REGION_SUPPORT_INFO[this._getSessionRegion(session)] || REGION_SUPPORT_INFO.SG;
      return buttons(`Sorry, no available slots for rescheduling this appointment.\n\nOr message us: ${_rsInfo.phone}\n\n(Reply 0 to go back one step)`, [
        { id: '1', title: 'Booking menu' },
        { id: '2', title: 'Email us' },
        { id: '3', title: 'Message us' }
      ]);
    }
    data.available_times = availableTimes;
    data.slot_page = 0;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.CONFIRM_RESCHEDULE,
      data: JSON.stringify(data)
    });
    const intro = data.is_single_reschedule_appt
      ? `You have one upcoming appointment:\n\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}`
      : `You selected to reschedule:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}`;
    const header = intro + '\n\nPlease choose a new slot:';
    return this._buildSlotList(availableTimes, 0, header, this._regionTz(session));
  }

  /**
   * Handle the reschedule intent confirmation (YES/NO before slot list is shown).
   */
  async handleRescheduleIntentConfirmState(session, message) {
    const text = (message || '').trim().toLowerCase();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const appt = data.selected_reschedule_appt;

    if (text === 'yes') {
      return await this._rescheduleFetchAndShowSlots(session, data);
    }

    if (['0', 'menu', 'back'].includes(text)) {
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      delete data.is_single_reschedule_appt;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }

    // Unknown input — re-show confirm prompt
    if (!appt) {
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Could not find the selected appointment. Please try again.\n\n' + await this.goToInteractiveMenu(session);
    }
    const intro = data.is_single_reschedule_appt
      ? `You have one upcoming appointment:\n\n*${appt._practitioner_display} — ${appt._appointment_type_display}*\n${appt._display_dt}`
      : `You selected to reschedule:\n*${appt._practitioner_display} — ${appt._appointment_type_display}*\n${appt._display_dt}`;
    return buttons(`${intro}\n\nWould you like to proceed?`, [
      { id: 'yes', title: 'Yes, reschedule' },
      { id: '0',   title: 'Go back' }
    ]);
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
    const text = (message || '').trim();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const appt = data.selected_reschedule_appt;
    const availableTimes = data.available_times || [];
    let slot_page = data.slot_page || 0;

    // Pagination — next
    if (['m', 'more', 'next'].includes(text.toLowerCase())) {
      slot_page = slot_page + 1;
      data.slot_page = slot_page;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.CONFIRM_RESCHEDULE, data: JSON.stringify(data) });
      const rescheduleHeader = appt
        ? `You are rescheduling:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n\nPlease choose a new slot:`
        : 'Please choose a new slot:';
      return this._buildSlotList(availableTimes, slot_page, rescheduleHeader, this._regionTz(session));
    }

    // Pagination — previous
    if (['p', 'prev'].includes(text.toLowerCase())) {
      slot_page = Math.max(0, slot_page - 1);
      data.slot_page = slot_page;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.CONFIRM_RESCHEDULE, data: JSON.stringify(data) });
      const rescheduleHeader = appt
        ? `You are rescheduling:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}\n\nPlease choose a new slot:`
        : 'Please choose a new slot:';
      return this._buildSlotList(availableTimes, slot_page, rescheduleHeader, this._regionTz(session));
    }

    // Back
    if (['0', 'menu', 'back'].includes(text.toLowerCase())) {
      delete data.reschedule_appt_list; delete data.selected_reschedule_appt; delete data.selected_reschedule_appt_idx; delete data.available_times; delete data.slot_page;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }

    // Parse selection — global 1-based index matching _buildSlotList row IDs
    const start = this._slotPageStart(slot_page);
    const count = this._slotPageCount(slot_page);
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || idx < start || idx >= Math.min(start + count, availableTimes.length) || !availableTimes[idx]) {
      return 'Invalid slot selection. Please reply with the number of your chosen slot, "M" for more, or "0" to go back.' +
        (appt ? `\n\nYou are rescheduling:\n${appt._practitioner_display} — ${appt._appointment_type_display}\n${appt._display_dt}` : '');
    }

    const slot = availableTimes[idx];
    const appointment_type_id = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    const business_id = extractIdFromClinikoRef(appt.business, 'businesses');
    const patient_id = session.patient_id;
    const practitioner_id = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const starts_at = slot.starts_at || slot.appointment_start || slot.slot;
    let ends_at = slot.ends_at || slot.appointment_end;
    if (!ends_at && starts_at) ends_at = new Date(new Date(starts_at).getTime() + 30 * 60000).toISOString();

    if (!business_id || !practitioner_id || !appointment_type_id || !patient_id || !starts_at) {
      delete data.reschedule_appt_list; delete data.selected_reschedule_appt; delete data.selected_reschedule_appt_idx; delete data.available_times; delete data.slot_page;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return 'Could not retrieve all necessary details for rescheduling. Please try again later or contact the clinic.';
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

    delete data.reschedule_appt_list; delete data.selected_reschedule_appt; delete data.selected_reschedule_appt_idx; delete data.available_times; delete data.slot_page;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });

    if (result && result.success) {
      // Send reschedule confirmation email (best-effort)
      const newApptSummary = { starts_at, practitioner: appt._practitioner_display, clinic: appt._business_display, appointment_type: appt._appointment_type_display };
      try {
        const emailPayload = await this._composeSupportEmailPayloadRescheduled(session, data, appt, newApptSummary, { failed: false });
        await this._postEmail(emailPayload);
      } catch (e) {
        this.logger.error('[Reschedule] Email send failed', { error: e?.message || e, sessionId: session.id });
      }
      return `✅ Your appointment has been rescheduled to:\n${formatSlotDateTime(starts_at, this._regionTz(session))}\n\n` + await this.goToInteractiveMenu(session);
    }

    // Reschedule failed — send contact/failure email
    try {
      const newApptSummary = { starts_at, practitioner: appt._practitioner_display, clinic: appt._business_display, appointment_type: appt._appointment_type_display };
      const emailPayload = await this._composeSupportEmailPayloadRescheduled(session, data, appt, newApptSummary, { failed: true });
      await this._postEmail(emailPayload);
    } catch (e) {
      this.logger.error('[Reschedule] Failure email send failed', { error: e?.message || e, sessionId: session.id });
    }
    return `❌ Could not reschedule your appointment. ${result?.message || ''}\n\n` + await this.goToInteractiveMenu(session);
  }

  /**
   * Build the email payload for the "no slots → contact me" path.
   * Formats a readable transcript. If bot messages are not recorded in history,
   * it flags that limitation so support knows context is partial.
   *
   * @param {object} session - session row/object
   * @param {object} data    - parsed session.data
   * @returns {Promise<{to:string[],subject:string,text:string,meta:object}>}
   */
  async _composeSupportEmailPayloadNoSlots(session, data) {
    const safeParse = (v) => { try { return typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); } catch { return {}; } };
    const s = session || {};
    const d = (data && typeof data === 'object') ? data : safeParse(s.data);
    const ctx = safeParse(s.context);

    // Region, contact
    const region = String(ctx.region || d.region || 'SG').trim();
    const phone  = String(s.phone_number || s.phoneNumber || d.phone || '').trim();
    const userEmail = String(ctx.email || s.email || d.email || '').trim();
    const regionDesk = (typeof REGION_SUPPORT_INFO === 'object' && REGION_SUPPORT_INFO && REGION_SUPPORT_INFO[region] && REGION_SUPPORT_INFO[region].email)
      ? REGION_SUPPORT_INFO[region].email : null;
    const supportEmail = regionDesk || process.env.SUPPORT_EMAIL || process.env.DEFAULT_SUPPORT_EMAIL || '';

    const to = [];
    if (supportEmail) to.push(supportEmail);
    if (userEmail)   to.push(userEmail);

    // Compose meta
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

    // Build transcript, prefer getConversationTranscript(), fallback to db.getChatHistory()
    let rows = [];
    try {
      if (this.sessionManager?.getConversationTranscript) {
        const t = await this.sessionManager.getConversationTranscript(s.id);
        if (Array.isArray(t)) rows = t;
      }
      if ((!rows || !rows.length) && this.sessionManager?.db?.getChatHistory) {
        const arr = await this.sessionManager.db.getChatHistory(s.id);
        if (Array.isArray(arr)) rows = arr;
      }
    } catch (_) { /* ignore */ }

    // Normalize, keep last N
    const MAX_LINES = 60; // cap for email
    const norm = (r) => {
      const ts  = r.timestamp || r.created_at || r.time || '';
      const dir = r.direction || r.from || r.sender || r.role || '';
      const who = /out/i.test(dir) || /bot|system/i.test(dir) ? 'Bot' : 'User';
      const body = r.text || r.body || r.message || r.content || '';
      return { ts, who, body: String(body || '').trim() };
    };
    const lines = (rows || []).map(norm).filter(x => x.body);
    const hasBot = lines.some(x => x.who === 'Bot');
    const recent = lines.slice(-MAX_LINES);

    // Pretty print blocks with timestamps
    const fmtTs = (ts) => {
      try { return new Date(ts).toLocaleString(); } catch { return ts || ''; }
    };
    const transcript = recent.map(x => `[${fmtTs(x.ts)}] ${x.who}: ${x.body}`).join('\n');

    // Header block
    const headerBlock =
      `Region: ${region}\n` +
      `Phone: ${phone || '—'}\n` +
      `Email: ${userEmail || '—'}\n` +
      `Date: ${meta.selected_date || '—'}\n` +
      (meta.selected_clinic ? `Clinic: ${meta.selected_clinic.business_name || meta.selected_clinic.name || meta.selected_clinic}\n` : '') +
      (meta.selected_physio ? `Physio: ${meta.selected_physio.display_name || meta.selected_physio.name || meta.selected_physio}\n` : '') +
      (meta.selected_appt_type ? `Type: ${meta.selected_appt_type.name || meta.selected_appt_type}\n` : '');

    const caveat = hasBot ? '' : '\nNote: Bot prompts are not recorded in this history. Transcript may include only user messages.\n';

    const subject = `[No Slots] Contact request — ${region} — ${phone || (userEmail || 'unknown')}`;
    const text =
      `User requested a callback when no slots were available.\n` +
      headerBlock +
      caveat +
      (transcript ? `\n--- Transcript (most recent ${Math.min(recent.length, MAX_LINES)} lines) ---\n${transcript}` : '');

    return { to, subject, text, meta };
  }

  /**
   * POST an email payload to the local mailer service (127.0.0.1:8089).
   * Accepts { to, subject, html?, text? } — same shape returned by all
   * _compose* methods and by EmailTemplates functions.
   * Failures are logged but never thrown — email is best-effort.
   *
   * @param {object} payload
   * @returns {Promise<void>}
   */
  async _postEmail(payload) {
    if (!payload || !Array.isArray(payload.to) || !payload.to.length) {
      this.logger.warn('[Email] _postEmail called with no recipients — skipped', { subject: payload?.subject });
      return;
    }
    try {
      const body = JSON.stringify({
        to:      payload.to,
        subject: payload.subject || '',
        html:    payload.html   || '',
        text:    payload.text   || '',
      });

      // Debug: log full outgoing payload so we can confirm recipients and content
      this.logger.info('[Email] Sending payload', {
        to:      payload.to,
        subject: payload.subject,
        hasHtml: !!(payload.html),
        textPreview: (payload.text || '').slice(0, 200),
      });

      await new Promise((resolve, reject) => {
        const mailer = getMailerConfig();
        const client = mailer.protocol === 'https:' ? require('https') : require('http');
        const req = client.request(
          {
            method: 'POST',
            host: mailer.hostname,
            port: mailer.port,
            path: mailer.path,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          },
          (res) => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
              if (res.statusCode === 200) {
                this.logger.info('[Email] Mailer accepted', { to: payload.to, subject: payload.subject, mailerResponse: raw.trim() });
                resolve();
              } else {
                this.logger.error('[Email] Mailer rejected', { status: res.statusCode, body: raw.trim(), to: payload.to, subject: payload.subject });
                reject(new Error(`Mailer HTTP ${res.statusCode}: ${raw.trim()}`));
              }
            });
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    } catch (e) {
      this.logger.error('[Email] _postEmail failed', { error: e?.message || e, subject: payload?.subject });
    }
  }

  /**
   * Build the email payload for a cancel event (success or failure/contact).
   * Uses the HTML template from EmailTemplates.js.
   *
   * @param {object} session
   * @param {object} data         - parsed session.data
   * @param {object} appt         - enriched appointment object
   * @param {object} [opts]
   * @param {boolean} [opts.failed] - true when the cancel API call failed
   * @returns {Promise<{to:string[], subject:string, html:string, text:string}>}
   */
  async _composeSupportEmailPayloadCancelled(session, data, appt, { failed = false } = {}) {
    const s   = session || {};
    const d   = (data && typeof data === 'object') ? data : (() => { try { return JSON.parse(s.data || '{}'); } catch { return {}; } })();
    const ctx = (() => { try { return typeof s.context === 'string' ? JSON.parse(s.context) : (s.context || {}); } catch { return {}; } })();

    const region     = String(ctx.region || d.region || 'SG').trim();
    const phone      = String(s.phone_number || s.phoneNumber || d.phone || '').trim();
    const supportEmail = (REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG).email;

    // Resolve user email from session data
    const userEmail = String(ctx.email || s.email || d.email || appt?.patient_email || '').trim();

    const to = [];
    if (supportEmail) to.push(supportEmail);
    if (userEmail)    to.push(userEmail);

    const practitioner = appt?._practitioner_display || appt?.practitioner || '—';
    const clinic       = appt?._business_display      || appt?.clinic       || '—';
    const dateTime     = appt?.starts_at ? formatSlotDateTime(appt.starts_at, this._regionTz(session)) : '—';
    const apptType     = appt?._appointment_type_display || appt?.appointment_type || '';

    const { subject, html, text } = appointmentCancelled({ practitioner, clinic, dateTime, apptType });

    const prefixedSubject = failed
      ? `[Cancel Failed] ${subject.replace('Your Appointment Has Been Cancelled', `Contact Required — ${region} — ${phone || userEmail || 'unknown'}`)}`
      : `[Cancelled] ${region} — ${phone || userEmail || 'unknown'} — ${subject}`;

    return { to, subject: prefixedSubject, html, text };
  }

  /**
   * Build the email payload for a reschedule event (success or failure/contact).
   * Uses the HTML template from EmailTemplates.js.
   *
   * @param {object} session
   * @param {object} data         - parsed session.data
   * @param {object} oldAppt      - the original appointment object
   * @param {object} newAppt      - the new appointment object (or attempted new slot)
   * @param {object} [opts]
   * @param {boolean} [opts.failed] - true when the reschedule API call failed
   * @returns {Promise<{to:string[], subject:string, html:string, text:string}>}
   */
  async _composeSupportEmailPayloadRescheduled(session, data, oldAppt, newAppt, { failed = false } = {}) {
    const s   = session || {};
    const d   = (data && typeof data === 'object') ? data : (() => { try { return JSON.parse(s.data || '{}'); } catch { return {}; } })();
    const ctx = (() => { try { return typeof s.context === 'string' ? JSON.parse(s.context) : (s.context || {}); } catch { return {}; } })();

    const region     = String(ctx.region || d.region || 'SG').trim();
    const phone      = String(s.phone_number || s.phoneNumber || d.phone || '').trim();
    const supportEmail = (REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG).email;

    // Resolve user email from context (survives data resets) or session data
    const userEmail = String(ctx.email || s.email || d.email || '').trim();

    const to = [];
    if (supportEmail) to.push(supportEmail);
    if (userEmail)    to.push(userEmail);

    const practitioner  = oldAppt?._practitioner_display  || oldAppt?.practitioner  || '—';
    const clinic        = oldAppt?._business_display       || oldAppt?.clinic        || '—';
    const apptType      = oldAppt?._appointment_type_display || oldAppt?.appointment_type || '';
    const oldDateTime   = oldAppt?.starts_at ? formatSlotDateTime(oldAppt.starts_at, this._regionTz(session)) : '—';
    const newDateTime   = newAppt?.starts_at ? formatSlotDateTime(newAppt.starts_at, this._regionTz(session)) : '—';

    const { subject, html, text } = appointmentRescheduled({ practitioner, clinic, oldDateTime, newDateTime, apptType });

    const prefixedSubject = failed
      ? `[Reschedule Failed] Contact Required — ${region} — ${phone || userEmail || 'unknown'}`
      : `[Rescheduled] ${region} — ${phone || userEmail || 'unknown'} — ${subject}`;

    return { to, subject: prefixedSubject, html, text };
  }


} // End of Class

module.exports = ChatbotEngine;
