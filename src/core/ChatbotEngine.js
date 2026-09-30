// File: /src/core/ChatbotEngine.js

const { buttons, list, MessageEnvelope } = require('./MessageBuilder');
const ClinikoAPI = require('../api/ClinikoAPI.js');
const { formatClinicForWhatsApp } = require('./ClinicFormatter');
const { checkDatabaseHealth, checkAPIHealth } = require('../routes/health.js');
const SessionManager = require('./SessionManager');
const Logger = require('./Logger.js');
const axios = require('axios');
const { bookingConfirmed, appointmentCancelled, cancellationBlocked, appointmentRescheduled, rescheduleBlocked } = require('../../prohealth-mailer/EmailTemplates');
const { REGION_SUPPORT_INFO, REGION_FEES, getRegionFeesForLanguage, hasCapability } = require('../config/regions');
const { LANGUAGE_LABELS } = require('../config/languages');

// LANGUAGE_LABELS entries may carry a "(English gloss)" suffix for readability
// (e.g. "廣東話 (Cantonese)") — match against the base label and the gloss
// separately, rather than the whole string, so typing "cantonese" alone still works.
function matchesLanguageLabel(text, code) {
  const label = LANGUAGE_LABELS[code].toLowerCase();
  const glossMatch = label.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const base = (glossMatch ? glossMatch[1] : label).trim();
  const gloss = glossMatch ? glossMatch[2].trim() : null;
  return text.includes(base) || (!!gloss && text.includes(gloss));
}
const { t } = require('../config/strings');
const { translateInsurerName } = require('../config/insurerTranslations');
const { translateServiceName } = require('../config/serviceTranslations');
const { translateClinicName } = require('../config/clinicTranslations');
const { translatePractitionerName } = require('../config/practitionerTranslations');
const { translateApptTypeName } = require('../config/apptTypeTranslations');
const {
  getAllAppointmentTypesForAllPractitioners,
  getPractitionersForType,
  getPractitionersForTypeIds,
  getPractitionersForTypeName,
  parseApptCategory,
  parseApptPatientType,
  buildFunnelCatalogue,
  resolveApptFromFunnel,
  _markPartial,
} = require('./_appointmentTypeHelpers');
const { bulkAll } = require('./BulkContext');
const NluRouter = require('./NluRouter');


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
const SLOT_LIST_PAGE_FIRST = 8;  // page 0: up to 8 slots + next + back = 10 rows max
const SLOT_LIST_PAGE_REST  = 7;  // page 1+: up to 7 slots + prev + next + back = 10 rows max
const MAX_DATE_ITEMS = 5;
const MAX_DATE_PAGES = 2; // 2 pages of 5 = 10 business days (excluding Sundays)
// Appointments starting within this window cannot be cancelled or rescheduled
// via WhatsApp — front desk must be contacted directly since cancellation
// fees may apply.
const APPOINTMENT_CHANGE_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
// Interactive selection list page sizes — kept small so the Send button stays
// visible on Mac WhatsApp Desktop without scrolling past the list rows.
const INTERACTIVE_SELECT_PAGE_FIRST = 5; // page 0: up to 5 items + next + back = 7
const INTERACTIVE_SELECT_PAGE_REST  = 4; // page 1+: up to 4 items + prev + next + back = 7

function interactivePageStart(page) {
  return page === 0 ? 0 : INTERACTIVE_SELECT_PAGE_FIRST + (page - 1) * INTERACTIVE_SELECT_PAGE_REST;
}
function interactivePageSize(page) {
  return page === 0 ? INTERACTIVE_SELECT_PAGE_FIRST : INTERACTIVE_SELECT_PAGE_REST;
}

const REGION_TZ = {
  SG: 'Asia/Singapore',
  HK: 'Asia/Hong_Kong',
  IN: 'Asia/Kolkata',
  PH: 'Asia/Manila',
};

// ====== NAVIGATION HELPERS ======

// normalizeTypeName is centralized in _slotHelpers.js so both menu-driven
// matching here and NLU slot extraction (NluRouter/Phase 2+) use identical rules.
const { normalizeTypeName } = require('./_slotHelpers.js');

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
  choose_type: ['selected_appt_type', 'insurer_page', 'practitioner_list', 'practitioner_page', 'selected_physio', 'clinic_list', 'clinic_page', 'selected_clinic', 'funnel_catalogue', 'funnel_step', 'funnel_sel'],
  choose_physio: ['selected_physio', 'clinic_list', 'clinic_page', 'selected_clinic', 'appt_types_for_physio', 'appt_type_page', 'selected_appt_type', 'physio_tier_step', 'physio_tier_sel', 'physio_tier_groups', 'physio_tier_names', 'physio_funnel_step', 'physio_funnel_sel', 'physio_categories'],
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
      // When returning to choose_type, restart the funnel
      toClear.add('funnel_step');
      toClear.add('funnel_sel');
    }
    if (fr.selection_step === 'choose_type') {
      toClear.add('selected_appt_type');
      toClear.add('practitioner_list');
      toClear.add('practitioner_page');
      toClear.add('clinic_list');
      toClear.add('clinic_page');
      toClear.add('selected_clinic');
      toClear.add('funnel_catalogue');
      toClear.add('funnel_step');
      toClear.add('funnel_sel');
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

/**
 * Format a Date or ISO string as a date-only string (no time), for the
 * Specific Date flow's date-picker rows and prompt headers. Same fixed-locale
 * rationale as formatSlotDateTime: dt.toLocaleDateString() with no locale arg
 * depends on the server process's resolved locale, which is unset/minimal on
 * Cloud Run — it silently renders Western numeric dates (e.g. "8/29/2026")
 * inside otherwise fully-translated yue/zh prompts. e.g. "29 Aug 2026".
 *
 * @param {Date|string} dateOrIso
 * @returns {string}
 */
function formatDateOnly(dateOrIso) {
  const dt = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (isNaN(dt.getTime())) return String(dateOrIso);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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
 * @param {string} [language] - defaults to 'en'; translated via practitionerTranslations when yue/zh
 * @param {Object} [logger]
 * @returns {string}
 */
function getPractitionerDisplayName(practitioner, language, logger) {
  if (!practitioner) return 'Practitioner';
  // Prefer the structured first/last name over Cliniko's own display_name —
  // Cliniko lets clinics set display_name to a first-name-only value per
  // practitioner (confirmed live for several HK practitioners), which both
  // undertranslates (yue/zh lookups are keyed by full name) and looks
  // inconsistent in English. Only fall back to display_name when first/last
  // are both unavailable.
  const name = (practitioner.first_name || practitioner.last_name
        ? [practitioner.first_name, practitioner.last_name].filter(Boolean).join(' ')
        : practitioner.display_name) || 'Practitioner';
  return translatePractitionerName(name, language || 'en', logger);
}

/**
 * Returns a displayable appointment type name from an appointment type object.
 * @param {Object|null|undefined} apptType
 * @param {string} [language] - defaults to 'en'; translated via apptTypeTranslations when yue/zh
 * @param {Object} [logger]
 * @returns {string}
 */
function getAppointmentTypeDisplayName(apptType, language, logger) {
  if (!apptType) return 'Appointment';
  if (apptType.name) return translateApptTypeName(apptType.name, language || 'en', logger);
  return 'Appointment';
}

/**
 * Returns a displayable business name from a business object.
 * @param {Object|null|undefined} business
 * @param {string} [language] - defaults to 'en'; translated via clinicTranslations when yue/zh
 * @param {Object} [logger]
 * @returns {string}
 */
function getBusinessDisplayName(business, language, logger) {
  if (!business) return '';
  const name = business.business_name || business.display_name || '';
  return translateClinicName(name, language || 'en', logger);
}

/**
 * Enriches appointments with display fields (_practitioner_display, _appointment_type_display, etc.)
 * by fetching all relevant related objects in parallel.
 * @param {Array<Object>} appointments
 * @param {ClinikoAPI} clinikoAPI
 * @returns {Promise<Array<Object>>} Enriched appointments
 */
async function enrichAppointmentsForDisplay(appointments, clinikoAPI, tz, language) {
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

  // Fetch all entities in parallel — each inner fan-out goes through bulkAll
  // for the same throttling as every other Cliniko fan-out (see
  // fix/fanout-batching-consistency); the outer Promise.all just combines
  // three already-independent bulk operations, not a fan-out itself.
  const [practitioners, apptTypes, businesses] = await Promise.all([
    bulkAll([...practitionerIds], id => clinikoAPI.getPractitionerById(id).then(obj => [id, obj])),
    bulkAll([...apptTypeIds], id => clinikoAPI.getAppointmentTypeById(id).then(obj => [id, obj])),
    bulkAll([...businessIds], id => clinikoAPI.getBusinessById(id).then(obj => [id, obj]))
  ]);

  // bulkAll's overall deadline can leave an entry undefined (never settled in
  // time) instead of the [id, obj] pair Object.fromEntries requires — filter
  // those out; the missing* checks below already treat a missing map entry
  // the same as any other fetch failure.
  const practitionerMap = Object.fromEntries(practitioners.filter(Boolean));
  const apptTypeMap = Object.fromEntries(apptTypes.filter(Boolean));
  const businessMap = Object.fromEntries(businesses.filter(Boolean));

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

    appt._practitioner_display = getPractitionerDisplayName(practitionerObj, language);
    appt._appointment_type_display = getAppointmentTypeDisplayName(apptTypeObj, language);
    appt._business_display = getBusinessDisplayName(businessObj, language);
    appt._display_dt = formatSlotDateTime(appt.starts_at, tz);
  }

  // Single summary log at the end
  console.log(`[ENRICH] Completed enrichment for ${appointments.length} appointments`);
  
  return appointments;
}

/**
 * Build a WhatsApp interactive list envelope for selection menus.
 * Manages the 10-row limit with prev/next/back nav rows.
 * rowFn(item, 1-based-global-idx) → { title, description? }
 * Titles over 24 chars are truncated; the full text becomes the description.
 * fixedPageSize overrides the default variable sizing (use for date picker).
 */
function buildInteractiveSelectionList({ header, items, rowFn, page = 0, fixedPageSize = null, language = 'en' }) {
  if (!Array.isArray(items)) items = [];

  const hasPrev = page > 0;
  const pageSize = fixedPageSize !== null
    ? fixedPageSize
    : (hasPrev ? INTERACTIVE_SELECT_PAGE_REST : INTERACTIVE_SELECT_PAGE_FIRST);
  const start = fixedPageSize !== null
    ? page * fixedPageSize
    : (page === 0 ? 0 : INTERACTIVE_SELECT_PAGE_FIRST + (page - 1) * INTERACTIVE_SELECT_PAGE_REST);

  const pageItems = items.slice(start, start + pageSize);
  const hasNext = items.length > start + pageSize;

  const rows = pageItems.map((item, i) => {
    const localIdx = i + 1;
    const { title: rawTitle, description: rawDesc } = rowFn(item, localIdx);
    const safeTitle = rawTitle.length > 24 ? rawTitle.slice(0, 23) + '…' : rawTitle;
    const description = rawDesc !== undefined ? rawDesc : (rawTitle.length > 24 ? rawTitle.slice(0, 72) : undefined);
    return { id: String(localIdx), title: safeTitle, ...(description ? { description: String(description).slice(0, 72) } : {}) };
  });

  if (hasPrev) rows.push({ id: 'prev', title: t(language, 'listNav.previousLabel') });
  if (hasNext) rows.push({ id: 'next', title: t(language, 'listNav.moreLabel') });
  rows.push({ id: 'back', title: t(language, 'listNav.backLabel') });

  const textLines = pageItems.map((item, i) => {
    const { title } = rowFn(item, i + 1);
    return `${i + 1}. ${title}`;
  });
  if (hasPrev) textLines.push(t(language, 'listNav.prevNavText'));
  if (hasNext) textLines.push(t(language, 'listNav.moreNavText'));
  textLines.push(t(language, 'listNav.backNavText'));
  const numberedList = textLines.join('\n');
  const textFallback = header + '\n\n' + numberedList + '\n\n' + t(language, 'listNav.replyWithNumberInstruction');

  // Include numbered options in the body so users can type a number if the
  // interactive picker doesn't fire (e.g. Mac WhatsApp Desktop).
  const bodyText = (header + '\n\n' + numberedList + '\n\n' + t(language, 'listNav.tapToSelectInstruction')).slice(0, 1024);

  const interactive = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: t(language, 'listNav.selectOptionButton'),
      sections: [{ rows }]
    }
  };

  return new MessageEnvelope(interactive, textFallback);
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
 * Sort practitioners alphabetically by display name.
 * @param {Array<Object>} practitioners
 * @returns {Array<Object>}
 */
function sortPractitioners(practitioners) {
  return [...practitioners].sort((a, b) =>
    getPractitionerDisplayName(a).localeCompare(getPractitionerDisplayName(b))
  );
}

/**
 * Derive gender from a practitioner's title field.
 * Returns 'male', 'female', or null (unknown / no title).
 */
function practitionerGender(p) {
  const t = (p && p.title) ? String(p.title).trim() : '';
  if (t === 'Mr') return 'male';
  if (t === 'Ms' || t === 'Miss' || t === 'Mrs') return 'female';
  return null;
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
 * Prepend a plain-text prefix to a MessageEnvelope's body and text fallback.
 * Keeps the reply as an interactive envelope rather than coercing to a string.
 * Clamps the combined interactive body to WHATSAPP_SAFE_REPLY_LENGTH.
 *
 * @param {string} prefix
 * @param {MessageEnvelope} envelope
 * @returns {MessageEnvelope}
 */
function prependTextToEnvelope(prefix, envelope) {
  if (!envelope || !envelope.interactive) return envelope;
  const combined = prefix + '\n\n' + envelope.interactive.body.text;
  envelope.interactive.body.text = combined.length <= WHATSAPP_SAFE_REPLY_LENGTH
    ? combined
    : combined.slice(0, WHATSAPP_SAFE_REPLY_LENGTH);
  envelope._textFallback = prefix + '\n\n' + envelope._textFallback;
  return envelope;
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
      SELECT_PREFERRED_INSURER: 'SELECT_PREFERRED_INSURER',
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

  /**
   * SG-only: when the (name, category) collision fix produces two type-list
   * entries with the same display name (e.g. "Physiotherapist" as both a real
   * Physiotherapy type and a Sports Massage type), the patient can't tell them
   * apart in the WhatsApp list. Append "(<service>)" to each colliding entry,
   * using the same Cliniko category data the bucketing fix already relies on.
   */
  _disambiguateSGTypeNames(list) {
    const nameCounts = new Map();
    for (const entry of list) nameCounts.set(entry.name, (nameCounts.get(entry.name) || 0) + 1);
    return list.map(entry => {
      if (nameCounts.get(entry.name) <= 1) return entry;
      // Prefer disambiguating by service (the original name-collision case —
      // e.g. "Physiotherapist" under Physiotherapy vs Sports Massage). When
      // the colliding entries share the same service too (the tier-merge
      // case below can produce two same-named, same-service entries that
      // differ only by duration — e.g. two "Sports Massage" rows), fall back
      // to duration instead.
      const collidingSameName = list.filter(e => e.name === entry.name);
      const allSameService = collidingSameName.every(e => e.service === entry.service);
      if (!allSameService && entry.service) return { ...entry, name: `${entry.name} (${entry.service})` };
      if (allSameService && entry.duration) return { ...entry, name: `${entry.name} (${entry.duration}min)` };
      return entry;
    });
  }

  /**
   * Every service (category) that has at least one REAL patientType
   * (New/Follow-up) entry anywhere in the raw type list — used to decide
   * whether a tier-merged entry's display name should fall back to "New
   * Patient" (the service has a real split elsewhere, e.g. SG's insured
   * Physiotherapy types) or to its own (adjective-stripped) name.
   * @param {Array<{name:string, category:string}>} allTypes - raw Cliniko types
   * @returns {Set<string>}
   */
  _servicesWithPatientTypeSplit(allTypes) {
    const set = new Set();
    for (const t of allTypes || []) {
      if (!t || !t.name) continue;
      const { service } = parseApptCategory(t.category);
      if (service && parseApptPatientType(t.name)) set.add(service);
    }
    return set;
  }

  /**
   * Leading practitioner-rate-tier adjective a Cliniko type name can carry
   * (e.g. "Senior Physiotherapist"). Deliberately a small, curated list, not
   * "any name without a detected patientType" — that broader heuristic was
   * tried and found to be a real regression: ordinary distinct visit names
   * that simply don't match the New/Follow-up regex (e.g. "Initial Visit"
   * vs "Return Visit") got wrongly collapsed together (confirmed live via a
   * failing NLU regression test after merging main into an NLU branch).
   */
  static TIER_ADJECTIVE_RE = /^(senior|junior|lead|principal|associate)\s+/i;

  /**
   * Base names (adjective-stripped, lowercased) that appear with 2+ distinct
   * real Cliniko names in the raw type list — i.e. an actual tier-adjective
   * pair exists (e.g. "Physiotherapist" AND "Senior Physiotherapist" both
   * present). Only these are safe to merge; a lone "Senior X" with no plain
   * "X" counterpart is left alone (name-only bucketing already handles it).
   * @param {Array<{name:string}>} allTypes - raw Cliniko types
   * @returns {Set<string>}
   */
  _tierBaseNamesWithVariants(allTypes) {
    const map = new Map(); // baseNorm -> Set(realNameNorm)
    for (const t of allTypes || []) {
      if (!t || !t.name) continue;
      const display = String(t.name).replace(/\s+/g, ' ').trim();
      const base = display.replace(ChatbotEngine.TIER_ADJECTIVE_RE, '').trim().toLowerCase();
      if (!map.has(base)) map.set(base, new Set());
      map.get(base).add(display.toLowerCase());
    }
    const result = new Set();
    for (const [base, variants] of map) if (variants.size > 1) result.add(base);
    return result;
  }

  /**
   * Full clinic-wide raw type list, used ONLY to detect genuine tier-
   * adjective pairs across practitioners — a single physio's own type list
   * can never reveal this: Cliniko splits tiers as different id records
   * assigned to different practitioners, so any one physio only ever holds
   * ONE variant (confirmed live 2026-09-30: computing tierBaseNames from
   * just Jade's own types never saw "Senior Physiotherapist", since only
   * other practitioners hold that id — her own "Physiotherapist" entry
   * never merged with the real insured "New Patient" bucket as a result).
   * Needed by handleBookHistory / handleBookSpecificPhysio specifically —
   * every other choose_type builder already scans all practitioners
   * anyway. Only fetched when the region has the 'physioTiers' capability,
   * so there's no extra live cost for regions where this can never matter
   * (e.g. HK) — and ClinikoAPI's own group/type caching (see "ClinikoAPI
   * caching" tests) means this is typically a cache hit in real sessions
   * regardless, since other steps already warm it.
   * @param {object} session
   * @returns {Promise<Array>}
   */
  async _clinicWideTypesForTierDetection(session) {
    if (!hasCapability(this._getSessionRegion(session), 'physioTiers')) return [];
    const groups = await this.clinikoAPI.getPractitionersByClinic();
    return await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
  }

  /**
   * Determine the choose_type bucket key + display name for a raw Cliniko
   * appointment type, collapsing practitioner-rate-tier variants (e.g. SG's
   * "Physiotherapist" vs "Senior Physiotherapist" — same service/duration/
   * insurer, no real New/Follow-up split) into one bucket instead of
   * exposing them as separate session types — confirmed live 2026-09-29:
   * these are the same visit, priced per practitioner, not different visits.
   * Gated by the 'physioTiers' region capability (config-driven, see
   * src/config/regions.js), NOT a region literal — but this must still be
   * opt-in per region rather than unconditional: a type with no real
   * New/Follow-up split can legitimately be a genuine same-name-different-
   * category collision (e.g. a generically-named type under two distinct
   * categories) that the ORIGINAL name+service bucketing already handles
   * correctly for every region, including regions without this capability —
   * applying the tier-merge unconditionally there would silently change
   * that region's bucketing (confirmed via a regression test: doing this
   * without the gate changed HK's same-name-different-category merge
   * behavior, violating the "HK must not change at all" constraint).
   * Also requires an actual detected tier-adjective PAIR
   * (_tierBaseNamesWithVariants), not just "no patientType" — that broader
   * rule wrongly merged ordinary distinct types like "Initial Visit"/
   * "Return Visit" (confirmed live regression, see TIER_ADJECTIVE_RE's doc).
   * @param {object} t - raw Cliniko type ({ id, name, category, duration_in_minutes })
   * @param {(s:string)=>string} normName
   * @param {boolean} isSG - still used for the ORIGINAL (name, service) collision bucketing, unrelated to the tier-merge below
   * @param {Set<string>} servicesWithPatientTypeSplit - from _servicesWithPatientTypeSplit()
   * @param {boolean} hasTierMerge - hasCapability(region, 'physioTiers')
   * @param {Set<string>} tierBaseNamesWithVariants - from _tierBaseNamesWithVariants()
   * @returns {{ bucketKey: string, displayName: string, service: string, duration: number|undefined }}
   */
  _bucketApptType(t, normName, isSG, servicesWithPatientTypeSplit, hasTierMerge, tierBaseNamesWithVariants) {
    const display = String(t.name).replace(/\s+/g, ' ').replace(/([A-Za-z])\(/g, '$1 (').replace(/\s+\)/g, ')').trim();
    const { service, insurer } = parseApptCategory(t.category);
    const duration = t.duration_in_minutes;
    const patientType = parseApptPatientType(t.name);
    const baseName = display.replace(ChatbotEngine.TIER_ADJECTIVE_RE, '').trim();
    const baseNorm = baseName.toLowerCase();
    if (hasTierMerge && !patientType && service && tierBaseNamesWithVariants && tierBaseNamesWithVariants.has(baseNorm)) {
      // Use the SAME bucket key formula as the "real name" branch below —
      // this is deliberate, not an oversight. Coverage (self-pay vs Bupa vs
      // Cigna) is already a distinct, existing question (_stepTypeInsurer,
      // "How is this covered?"), so a tier-merged self-pay entry renamed to
      // "New Patient" should simply JOIN whatever real insured "New Patient"
      // bucket already exists for this service — appearing as one more
      // `entries` row (insurer: null) that _stepTypeInsurer already knows
      // how to offer as a "Self-pay" option — not become a second,
      // separately-labeled menu row that duplicates what that step already
      // does. (An earlier version of this fix instead gave it its own
      // "New Patient (Self-pay)" row with a distinct bucket key; found via a
      // live menu check to be architecturally wrong — insurer disambiguation
      // belongs entirely to _stepTypeInsurer, never to the type-name label.)
      const mergedName = servicesWithPatientTypeSplit.has(service) ? 'New Patient' : baseName;
      const n = normName(mergedName);
      const bucketKey = isSG ? `${n} ${service || ''}` : n;
      return { bucketKey, displayName: mergedName, service, duration };
    }
    const n = normName(display);
    const bucketKey = isSG ? `${n} ${service || ''}` : n;
    return { bucketKey, displayName: display, service, duration };
  }

  /**
   * Returns the language code for this session, or 'en' if not set.
   * @param {object} session
   * @returns {string}
   */
  _getSessionLanguage(session) {
    let context = session.context;
    if (context && typeof context === 'string') {
      try { context = JSON.parse(context); } catch {}
    }
    return (context && context.language) || 'en';
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
  _buildSlotList(slots, page, header, tz, language = 'en') {
    const start = this._slotPageStart(page);
    const count = this._slotPageCount(page);
    const hasPrev = page > 0;
    const pageSlots = slots.slice(start, start + count);
    const hasNext = slots.length > start + count;

    const rows = pageSlots.map((slot, i) => ({
      id: String(start + i + 1),
      title: formatSlotDateTime(slot.slot || slot.starts_at || slot.appointment_start, tz),
    }));
    if (hasPrev) rows.push({ id: 'prev', title: t(language, 'slotSelection.previousLabel') });
    if (hasNext) rows.push({ id: 'next', title: t(language, 'slotSelection.moreLabel') });
    rows.push({ id: 'back', title: t(language, 'slotSelection.backLabel') });

    const interactive = {
      type: 'list',
      body: { text: header },
      action: {
        button: t(language, 'slotSelection.selectButton'),
        sections: [{ rows: rows.map(r => ({ id: r.id, title: r.title })) }]
      }
    };

    const textLines = pageSlots.map((slot, i) =>
      `${start + i + 1}. ${formatSlotDateTime(slot.slot || slot.starts_at || slot.appointment_start, tz)}`
    ).join('\n');
    const navText = [hasPrev ? t(language, 'slotSelection.prevNavText') : null, hasNext ? t(language, 'slotSelection.moreNavText') : null].filter(Boolean).join('\n');
    const textFallback = header + '\n\n' + textLines + (navText ? '\n' + navText : '') + '\n\n' + t(language, 'slotSelection.replyToPickInstruction');

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
      t(this._getSessionLanguage(session), 'common.unexpectedError') + "\n\n" +
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
      [this.STATES.SELECT_PREFERRED_INSURER]: this.handleSelectPreferredInsurerState.bind(this),
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
      // If no region or language is set, route through handleIntroState so that gate is shown first.
      // Bypassing this caused unknown-region users to see the main menu twice: once from
      // goToInteractiveMenu (no region), then again after handleIntroState consumed their
      // first menu selection as a region pick.
      const ctx = (() => { try { return typeof fresh.context === 'string' ? JSON.parse(fresh.context) : (fresh.context || {}); } catch { return {}; } })();
      if (!ctx.region || !ctx.language) {
        return await this.handleIntroState(fresh, '');
      }
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
    const language = this._getSessionLanguage(session);
    return list(t(language, 'bookingMenu.title'), t(language, 'bookingMenu.subtitle'), [
      { id: '1', title: t(language, 'bookingMenu.byLastVisit') },
      { id: '2', title: t(language, 'bookingMenu.soonest'), description: t(language, 'bookingMenu.soonestDesc') },
      { id: '3', title: t(language, 'bookingMenu.specificDate') },
      { id: '4', title: t(language, 'bookingMenu.specificPhysio') },
      { id: '5', title: t(language, 'bookingMenu.specificClinic') },
      { id: '0', title: t(language, 'bookingMenu.back') },
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

    const language = this._getSessionLanguage(session);

    if (session.verified) {
      const body = `${region}${t(language, 'mainMenu.verifiedBody')}`;
      return list(body, 'Select option', [
        { id: '1',           title: t(language, 'mainMenu.book') },
        { id: '2',           title: t(language, 'mainMenu.cancel') },
        { id: '3',           title: t(language, 'mainMenu.reschedule') },
        { id: 'preferences', title: t(language, 'mainMenu.changePreferences') },
        { id: 'region',      title: t(language, 'mainMenu.changeCountry') },
        { id: 'language',    title: t(language, 'mainMenu.changeLanguage') },
        { id: '9',           title: t(language, 'mainMenu.logout') },
      ]);
    } else {
      const body = `${t(language, 'mainMenu.welcomeHeader')}${region}${t(language, 'mainMenu.unverifiedPrompt')}`;
      return list(body, 'Select option', [
        { id: '1',        title: t(language, 'mainMenu.register') },
        { id: '2',        title: t(language, 'mainMenu.bookOrManage') },
        { id: '3',        title: t(language, 'mainMenu.viewFees') },
        { id: '4',        title: t(language, 'mainMenu.viewLocations') },
        { id: 'region',   title: t(language, 'mainMenu.changeCountry') },
        { id: 'language', title: t(language, 'mainMenu.changeLanguage') },
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
        // No session exists yet, so no language preference to read — English is unavoidable here.
        return 'Sorry, there was an issue starting your session. Please try again.';
      }

      // conversation_state defaults to 'INTRO' at the DB column level, so it's always
      // truthy for a freshly created session — it can't be used to detect first contact.
      // Absence of chat history is the reliable signal instead.
      try {
        const priorHistory = await this.sessionManager.db.getChatHistory(session.id, 1);
        session._isFirstContactMessage = !priorHistory || priorHistory.length === 0;
      } catch {
        session._isFirstContactMessage = false;
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
        let priorCtx = session.context;
        if (priorCtx && typeof priorCtx === 'string') { try { priorCtx = JSON.parse(priorCtx); } catch { priorCtx = {}; } }
        const priorLanguage = (priorCtx && priorCtx.language) || null;
        const phone = session.phone_number || session.phoneNumber;
        await this.sessionManager.deleteSessionAndData(session.id);
        const freshSession = await this.sessionManager.getOrCreateSession(phone, true);
        // Carry the language preference across the reset — changing region shouldn't
        // force the user to re-pick a language they'd already chosen.
        if (priorLanguage) {
          await this.sessionManager.updateSession(freshSession.id, { context: { language: priorLanguage } });
        }
        const updatedFresh = await this.sessionManager.getSession(freshSession.id);
        return await this.handleIntroState(updatedFresh, 'region');
      }

      // Global language-change interception: unlike region, language doesn't affect Cliniko
      // tenant/API routing, so this does NOT reset the session — it just re-prompts in place.
      if ((_globalText === 'language' || _globalText === 'change language') && currentState !== this.STATES.INTRO) {
        let ctx = session.context;
        if (ctx && typeof ctx === 'string') { try { ctx = JSON.parse(ctx); } catch { ctx = {}; } }
        ctx = ctx || {};
        ctx.awaiting_language_selection = true;
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, context: ctx });
        const updated = await this.sessionManager.getSession(session.id);
        return await this.handleIntroState(updated, 'language');
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
        const historyText = Array.isArray(response) ? response.map(String).join('\n\n') : String(response);
        await this.sessionManager.db.addChatHistory(session.id, message, historyText);
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
      // Session lookup itself failed, so no language preference to read — English is unavoidable here.
      return (
          "We're currently experiencing a technical issue and could not start your session. " +
          "Please try again later. If the problem continues, " +
        getSupportInfo(this._getSessionRegion(session))
      );
    }
  }

  /** Convenience wrapper — always returns a plain string (text fallback for envelopes). */
  async handleMessage(message, phoneNumber) {
    const result = await this.handleMessageEnvelope(message, phoneNumber);
    return Array.isArray(result) ? result.map(String).join('\n\n') : String(result);
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
    const languageCodes = Object.keys(LANGUAGE_LABELS);

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
          this.sessionManager.db.upsertPatientState(session.phone_number || session.phoneNumber, { region: context.region }).catch(() => {});
        }
      }
    }

    // Show region selection if needed — must resolve before language, since Cantonese/Mandarin
    // are only offered for HK (see below); every other region skips the language prompt entirely.
    if (!context.region || text === 'region' || text === 'change region' || context.awaiting_region_selection) {
      context.awaiting_region_selection = true;
      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        if (idx >= 0 && idx < regionCodes.length) {
          context.region = regionCodes[idx];
          delete context.awaiting_region_selection;
          if (context.region !== 'HK' && context.language !== 'en') {
            context.language = 'en';
            delete context.awaiting_language_selection;
          }
          await this.sessionManager.updateSession(session.id, { context });
          this.sessionManager.db.upsertPatientState(session.phone_number || session.phoneNumber, { region: context.region, language: context.language }).catch(() => {});
          // Re-enter (rather than jump to the main menu) so the HK language gate below still runs if needed
          return await this.handleIntroState(await this.sessionManager.getSession(session.id), '');
        }
      } else if (regionCodes.some(code => text.includes(regionLabels[code].toLowerCase()))) {
        const found = regionCodes.find(code => text.includes(regionLabels[code].toLowerCase()));
        context.region = found;
        delete context.awaiting_region_selection;
        if (context.region !== 'HK' && context.language !== 'en') {
          context.language = 'en';
          delete context.awaiting_language_selection;
        }
        await this.sessionManager.updateSession(session.id, { context });
        this.sessionManager.db.upsertPatientState(session.phone_number || session.phoneNumber, { region: context.region, language: context.language }).catch(() => {});
        return await this.handleIntroState(await this.sessionManager.getSession(session.id), '');
      }

      await this.sessionManager.updateSession(session.id, { context });
      return list(t(context.language || 'en', 'region.promptBody'), t(context.language || 'en', 'region.buttonLabel'),
        regionCodes.map((code, i) => ({ id: String(i + 1), title: regionLabels[code] }))
      );
    }

    // Non-HK regions never offer language selection — silently force English if not already,
    // and ignore any stray language-change command instead of falling through to unmatched-text handling.
    if (context.region !== 'HK') {
      if (context.language !== 'en' || context.awaiting_language_selection) {
        context.language = 'en';
        delete context.awaiting_language_selection;
        await this.sessionManager.updateSession(session.id, { context });
        this.sessionManager.db.upsertPatientState(session.phone_number || session.phoneNumber, { language: 'en' }).catch(() => {});
      }
      if (text === 'language' || text === 'change language') {
        return await renderMenuFresh();
      }
    }

    // Show language selection if needed — HK only.
    if (context.region === 'HK' && (!context.language || text === 'language' || text === 'change language' || context.awaiting_language_selection)) {
      context.awaiting_language_selection = true;
      if (/^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        if (idx >= 0 && idx < languageCodes.length) {
          context.language = languageCodes[idx];
          delete context.awaiting_language_selection;
          await this.sessionManager.updateSession(session.id, { context });
          this.sessionManager.db.upsertPatientState(session.phone_number || session.phoneNumber, { language: context.language }).catch(() => {});
          return await renderMenuFresh();
        }
      } else if (text && languageCodes.some(code => matchesLanguageLabel(text, code))) {
        const found = languageCodes.find(code => matchesLanguageLabel(text, code));
        context.language = found;
        delete context.awaiting_language_selection;
        await this.sessionManager.updateSession(session.id, { context });
        this.sessionManager.db.upsertPatientState(session.phone_number || session.phoneNumber, { language: context.language }).catch(() => {});
        return await renderMenuFresh();
      }

      await this.sessionManager.updateSession(session.id, { context });
      const languageList = list('Please select your language / 請選擇語言 / 请选择语言:', 'Select language',
        languageCodes.map((code, i) => ({ id: String(i + 1), title: LANGUAGE_LABELS[code] }))
      );
      // Greetings/menu commands and explicit language-change requests go straight to the
      // list untouched — the ack/"let's start again" prefix is only for genuinely unmatched
      // free text, mirroring the fallback prefix logic further down this method.
      const isGreetingOrMenu = !text || ['menu', 'hi', 'hello', 'hey', '0', 'back'].includes(text);
      const isExplicitLanguageCommand = text === 'language' || text === 'change language';
      if (!isGreetingOrMenu && !isExplicitLanguageCommand) {
        const prefix = session._isFirstContactMessage
          ? `Thanks for reaching out! To make sure I get your booking right, I'll collect a few details step by step — starting with your language.`
          : `Let's start again — here are the options.`;
        return prependTextToEnvelope(prefix, languageList);
      }
      return languageList;
    }

    const language = context.language || 'en';

    // Region is set → show Intro main menu for non-verified user
    if (!text || ['menu', 'hi', 'hello', 'hey', '0', 'back'].includes(text)) {
      return await this.renderMainMenu(session);
    }

    // Unverified menu routing — IDs match display order (1=Register, 2=Book, 3=Fees, 4=Locations)
    if (text === '1' || text.includes('register')) {
      this.logger.analyticsEvent({ event: 'conversation_intent_register', sessionId: session.id, region: context.region, phone_number: session.phone_number || session.phoneNumber, ts: Date.now() });
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.REGISTER_PATIENT });
      const fresh = await this.sessionManager.getSession(session.id);
      return await this.handleRegisterPatientState(fresh, '');
    }
    if (text === '2' || text.includes('book') || text.includes('manage')) {
      this.logger.analyticsEvent({ event: 'conversation_intent_existing', sessionId: session.id, region: context.region, phone_number: session.phone_number || session.phoneNumber, ts: Date.now() });
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.VERIFY,
        verified: false
      });
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.handleVerifyState(updatedSession, '');
    }
    if (text === '3' || text.includes('fee')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VIEW_FEES });
      const fresh = await this.sessionManager.getSession(session.id);
      return await this.handleViewFeesState(fresh, '');
    }
    if (text === '4' || text.includes('location')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VIEW_LOCATIONS });
      const fresh = await this.sessionManager.getSession(session.id);
      return await this.handleViewLocationsState(fresh, '');
    }

    if (text) {
      const nlu = await NluRouter.classifyIntent(text, this.STATES.INTRO, session);
      const matched = NluRouter.isConfident(nlu);
      this.logger.analyticsEvent({ event: 'nlu_intent_classified', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: 'INTRO', intent: nlu.intent, confidence: nlu.confidence, matched });
      if (matched) {
        if (nlu.intent === 'view_fees') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VIEW_FEES });
          const fresh = await this.sessionManager.getSession(session.id);
          return await this.handleViewFeesState(fresh, '');
        }
        if (nlu.intent === 'view_locations') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VIEW_LOCATIONS });
          const fresh = await this.sessionManager.getSession(session.id);
          return await this.handleViewLocationsState(fresh, '');
        }
      }
      this.logger.analyticsEvent({ event: 'nlu_fallback_low_confidence', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: 'INTRO', intent: nlu.intent, confidence: nlu.confidence });
    }

    const fallbackPrefix = session._isFirstContactMessage
      ? `Thanks for reaching out! To make sure I get your booking right, I'll collect a few details step by step — starting with the options below.`
      : `Let's start again — here are the options.`;
    return prependTextToEnvelope(fallbackPrefix, await this.renderMainMenu(session));
  }

  /**
   * Handle fallback for any unknown state or invalid input.
   * @param {object} session
   * @param {string} message
   */
  async handleFallbackState(session, message) {
    return prependTextToEnvelope(t(this._getSessionLanguage(session), 'common.fallbackNotUnderstood'), await this.goToInteractiveMenu(session));
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
    const language = this._getSessionLanguage(session);

    // Back/menu at any time -> Intro + main menu
    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      const updated = await this.sessionManager.getSession(session.id);
      return await this.renderMainMenu(updated);
    }

    // Gateway screen — shown before asking for email, so new patients can self-register
    const GATEWAY_BUTTONS = buttons(
      t(language, 'verifyFlow.gatewayPrompt'),
      [
        { id: '1', title: t(language, 'verifyFlow.gatewayYesRegistered') },
        { id: '2', title: t(language, 'verifyFlow.gatewayRegisterNew') },
        { id: '3', title: t(language, 'verifyFlow.gatewayForgotDetails') },
      ]
    );

    if (!data.verify_email && !data.awaiting_email && !data.verify_error_prompt) {
      if (!data.gateway_prompt) {
        data.gateway_prompt = true;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return GATEWAY_BUTTONS;
      }
      if (text === '1') {
        data.gateway_prompt = false;
        data.awaiting_email = true;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return t(language, 'verifyFlow.enterRegisteredEmail');
      }
      if (text === '2') {
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.REGISTER_PATIENT,
          data: null
        });
        const updated = await this.sessionManager.getSession(session.id);
        return await this.handleRegisterPatientState(updated, '');
      }
      if (text === '3') {
        const region = this._getSessionRegion(session);
        const info = REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG;
        delete data.gateway_prompt;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: this.STATES.INTRO,
          data: JSON.stringify(data)
        });
        const updated = await this.sessionManager.getSession(session.id);
        return prependTextToEnvelope(
          t(language, 'verifyFlow.forgotDetailsContact', { email: info.email }),
          await this.renderMainMenu(updated)
        );
      }
      // Unknown input — re-render gateway with error prefix so text clients see the options
      return prependTextToEnvelope(t(language, 'verifyFlow.gatewayInvalidReply'), GATEWAY_BUTTONS);
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
      t(language, 'verifyFlow.failPromptBody'),
      [
        { id: '1', title: t(language, 'verifyFlow.failPromptTryAgain') },
        { id: '2', title: t(language, 'verifyFlow.failPromptEmailUs') },
        { id: '3', title: t(language, 'verifyFlow.failPromptMainMenu') }
      ]
    );

    // Handle the post-failure 3-option prompt
    if (data.verify_error_prompt === true) {
      if (text === '1') {
        // Restart from email
        const fresh = { verify_error_prompt: false, awaiting_email: true };
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: JSON.stringify(fresh) });
        return t(language, 'verifyFlow.restartEnterEmail');
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
        return prependTextToEnvelope(t(language, 'verifyFlow.outreachSent'), await this.renderMainMenu(updated));
      }
      if (text === '3') {
        delete data.verify_error_prompt;
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, data: JSON.stringify(data) });
        const updated = await this.sessionManager.getSession(session.id);
        return await this.renderMainMenu(updated);
      }
      // Unknown input in fail prompt — reprint with prefix
      return prependTextToEnvelope(t(language, 'verifyFlow.failPromptInvalidReply'), FAIL_PROMPT);
    }

    // Step 1: ask for email
    if (!data.verify_email) {
      if (!data.awaiting_email) {
        data.awaiting_email = true;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        return t(language, 'verifyFlow.restartEnterEmail');
      }
      // Validate and store email
      const email = textRaw.toLowerCase();
      if (!email.includes('@') || !email.includes('.')) {
        return t(language, 'verifyFlow.invalidEmail');
      }
      data.verify_email = email;
      delete data.awaiting_email;
      data.awaiting_dob = true;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return t(language, 'verifyFlow.enterDob');
    }

    // Step 2: collect and validate DOB
    if (!data.verify_dob) {
      if (!textRaw) {
        return t(language, 'verifyFlow.enterDobRetry');
      }
      const parsed = parseDob(textRaw);
      if (!parsed) {
        return t(language, 'verifyFlow.invalidDob');
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
        // Persist verified status outside the session's TTL — the periodic
        // expired-session cleanup deletes session rows, which otherwise silently
        // drops the "returning verified user" carryover after ~30-40 min idle.
        const phoneForState = session.phone_number || session.phoneNumber;
        if (phoneForState) {
          this.sessionManager.db.upsertPatientState(phoneForState, { patient_id: patient.id, verified: true }).catch(() => {});
        }
        const updated = await this.sessionManager.getSession(session.id);
        return prependTextToEnvelope(t(language, 'verifyFlow.verificationSuccessful'), await this.goToInteractiveMenu(updated));
      }

      // Verification failed — show 3-option prompt, stay in VERIFY state
      cleared.verify_error_prompt = true;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: JSON.stringify(cleared) });
      const region = this._getSessionRegion(session);
      const support = getSupportInfo(region);
      this.logger.analyticsEvent({ event: 'verification_failed', reason: 'no_match', sessionId: session.id, region, ts: Date.now() });
      return buttons(
        t(language, 'verifyFlow.noMatchBody', { support }),
        [
          { id: '1', title: t(language, 'verifyFlow.failPromptTryAgain') },
          { id: '2', title: t(language, 'verifyFlow.failPromptEmailUs') },
          { id: '3', title: t(language, 'verifyFlow.failPromptMainMenu') }
        ]
      );

    } catch (e) {
      this.logger.error('[handleVerifyState] API error during verification', { err: e?.message });
      cleared.verify_error_prompt = true;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.VERIFY, data: JSON.stringify(cleared) });
      this.logger.analyticsEvent({ event: 'verification_failed', reason: 'api_error', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now() });
      // Distinct from the "wrong email/DOB" message above — this is a real
      // fetch failure (e.g. Cliniko rate-limited), not a non-matching patient.
      return buttons(
        t(language, 'verifyFlow.apiErrorBody'),
        [
          { id: '1', title: t(language, 'verifyFlow.failPromptTryAgain') },
          { id: '2', title: t(language, 'verifyFlow.failPromptEmailUs') },
          { id: '3', title: t(language, 'verifyFlow.failPromptMainMenu') }
        ]
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

    // Support language change from the verified main menu
    if (text === 'language' || text === 'change language') {
      let context = session.context;
      if (context && typeof context === 'string') {
        try { context = JSON.parse(context); } catch {}
      }
      context = context || {};
      context.awaiting_language_selection = true;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, context });
      const updated = await this.sessionManager.getSession(session.id);
      return await this.handleIntroState(updated, 'language');
    }

    if (['0', 'menu', 'back'].includes(text)) {
      // Verified users stay on the verified menu; going to INTRO would show the unverified landing
      const updatedSession = await this.sessionManager.getSession(session.id);
      return await this.renderMainMenu(updatedSession);
    }
    if (text === 'preferences' || text.includes('preference')) {
      return await this.renderPreferredInsurerMenu(session);
    }
    if (text === '9' || text.includes('logout')) {
      try {
        await this.sessionManager.deleteSessionAndData(session.id);
        const updatedSession = await this.sessionManager.getOrCreateSession(
          session.phone_number || session.phoneNumber,
          true
        );
        await this.sessionManager.updateSession(updatedSession.id, {
          verified: false,
          verification_status: 'unverified',
          patient_id: null,
          conversation_state: this.STATES.INTRO
        });
        const freshSession = await this.sessionManager.getSession(updatedSession.id);
        return prependTextToEnvelope('✅ All your data has been deleted and you are logged out.', await this.renderMainMenu(freshSession));
      } catch (e) {
        this.logger.error('[Logout] deleteSessionAndData failed', { error: e?.message || e, sessionId: session.id });
        return prependTextToEnvelope('You have been logged out.', await this.renderMainMenu(session));
      }
    }

    // 'cancel'/'resched' checked before the 'book' substring check below —
    // "cancel my booking"/"reschedule... booked for tomorrow" both contain
    // "book" and were being caught by that check first, dead-ending the
    // exact free-text cancel/reschedule phrasing this NLU layer exists to
    // catch (2026-09-07 prod incident: free-text cancel misrouted into
    // registration). Live-confirmed against real HK prod phrasing.
    if (text === '2' || text.includes('cancel')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.CANCEL_APPOINTMENT });
      return await this.handleCancelAppointmentState(session, '');
    }
    if (text === '3' || text.includes('resched')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.RESCHEDULE_APPOINTMENT });
      return await this.handleRescheduleAppointmentState(session, '');
    }
    // Word-boundary match — live-confirmed the reorder above wasn't
    // sufficient on its own: "booked"/"booking" (usually describing an
    // EXISTING appointment, e.g. "I have a session booked... need to
    // reschedule") still matched this bare-substring check even when the
    // message contained neither "cancel" nor "resched", so it never got a
    // chance to fall through to the NLU layer below. "book" as a bare word
    // ("I want to book...") still matches; "booked"/"booking" no longer do.
    if (text === '1' || /\bbook\b/.test(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS });
      this.logger.analyticsEvent({ event: 'booking_flow_started', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now() });
      return await this.renderBookingMethodMenu(session);
    }
    if (text) {
      const nlu = await NluRouter.classifyIntent(text, this.STATES.BOOK_MANAGE_OPTIONS, session);
      const matched = NluRouter.isConfident(nlu);
      this.logger.analyticsEvent({ event: 'nlu_intent_classified', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: 'BOOK_MANAGE_OPTIONS', intent: nlu.intent, confidence: nlu.confidence, matched });
      if (matched) {
        if (nlu.intent === 'book_appointment') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS });
          this.logger.analyticsEvent({ event: 'booking_flow_started', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), source: 'nlu' });
          return await this.renderBookingMethodMenu(session);
        }
        if (nlu.intent === 'cancel_appointment') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.CANCEL_APPOINTMENT });
          return await this.handleCancelAppointmentState(session, '');
        }
        if (nlu.intent === 'reschedule_appointment') {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.RESCHEDULE_APPOINTMENT });
          return await this.handleRescheduleAppointmentState(session, '');
        }
      }
      this.logger.analyticsEvent({ event: 'nlu_fallback_low_confidence', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: 'BOOK_MANAGE_OPTIONS', intent: nlu.intent, confidence: nlu.confidence });
    }

    return prependTextToEnvelope(t(this._getSessionLanguage(session), 'common.optionsNotUnderstood'), await this.goToInteractiveMenu(session));
  }

  /**
   * Build and show the live insurer list for the preferences menu. Non-destructive —
   * unlike "region", this does not log the user out. List is built the same way as
   * Book Soonest's funnel (buildFunnelCatalogue), so choices always match real Cliniko data.
   */
  async renderPreferredInsurerMenu(session) {
    let context = session.context;
    if (context && typeof context === 'string') {
      try { context = JSON.parse(context); } catch { context = {}; }
    }
    const current = (context && context.preferred_insurer) || null;

    const groups = await this.clinikoAPI.getPractitionersByClinic();
    const allTypes = await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
    const catalogue = buildFunnelCatalogue(allTypes);
    const insurers = [...new Set(catalogue.map(t => t.insurer).filter(Boolean))].sort((a, b) => a.localeCompare(b));

    const rows = [
      { id: 'none', title: 'No preference / Self-pay' },
      ...insurers.slice(0, 8).map((name, i) => ({ id: String(i + 1), title: name })),
    ];
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.SELECT_PREFERRED_INSURER,
      data: JSON.stringify({ insurer_options: insurers.slice(0, 8) })
    });

    const currentLine = current ? `Current preference: *${current}*\n\n` : '';
    return list(`${currentLine}Select your insurer (or self-pay):`, 'Select insurer', rows);
  }

  /**
   * Handle the preferred-insurer selection made from renderPreferredInsurerMenu.
   * Persists durably to patient_state.preferred_insurer (survives logout, unlike
   * appt_preference) and updates the live session context immediately.
   */
  async handleSelectPreferredInsurerState(session, message) {
    const text = (message || '').trim().toLowerCase();
    if (['0', 'back', 'menu'].includes(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_MANAGE_OPTIONS });
      return await this.renderMainMenu(await this.sessionManager.getSession(session.id));
    }

    let data = session.data;
    if (data && typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = {}; }
    }
    const options = (data && data.insurer_options) || [];

    let chosen; // undefined = invalid selection, null = explicit self-pay
    if (text === 'none') {
      chosen = null;
    } else {
      const idx = parseInt(text, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
        chosen = options[idx - 1];
      }
    }

    if (chosen === undefined) {
      return prependTextToEnvelope(
        'Please select a valid option from the list.',
        await this.renderPreferredInsurerMenu(session)
      );
    }

    const phone = session.phone_number || session.phoneNumber;
    // Empty string (not null) explicitly means "self-pay chosen" — upsertPatientState
    // uses COALESCE, so a null/undefined value would leave the prior preference untouched.
    const storedValue = chosen === null ? '' : chosen;
    if (phone) {
      await this.sessionManager.db.upsertPatientState(phone, { preferred_insurer: storedValue }).catch(() => {});
    }

    let context = session.context;
    if (context && typeof context === 'string') {
      try { context = JSON.parse(context); } catch { context = {}; }
    }
    context = context || {};
    context.preferred_insurer = storedValue;

    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
      context
    });
    const updated = await this.sessionManager.getSession(session.id);
    const confirmMsg = chosen === null
      ? '✅ Preference set to self-pay.'
      : `✅ Preference set to *${chosen}*.`;
    return prependTextToEnvelope(confirmMsg, await this.renderMainMenu(updated));
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

    // Support language change while at booking method menu
    if (text === 'language' || text === 'change language') {
      let context = session.context;
      if (context && typeof context === 'string') {
        try { context = JSON.parse(context); } catch {}
      }
      context = context || {};
      context.awaiting_language_selection = true;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO, context });
      const updated = await this.sessionManager.getSession(session.id);
      return await this.handleIntroState(updated, 'language');
    }

    if (['0', 'menu', 'back'].includes(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_MANAGE_OPTIONS });
      return await this.goToInteractiveMenu(session);
    }
    if (text === '1' || text.includes('history')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_HISTORY, data: null });
      session.data = null;
      return await this.handleBookHistory(session, '');
    }
    if (text === '2' || text.includes('soonest')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SOONEST, data: null });
      session.data = null;
      return await this.handleBookSoonest(session, '');
    }
    // Word-boundary match, not .includes() — 'date' as a bare substring
    // false-positives on "update"/"validate"/"mandate" etc., misrouting
    // unrelated free text into this funnel with data wiped before the NLU
    // layer below ever gets a chance. Live-confirmed risk (see 'clinic' fix
    // just below — same class, "clinical" contains "clinic").
    if (text === '3' || /\bdate\b/.test(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_DATE, data: null });
      session.data = null;
      return await this.handleBookSpecificDate(session, '');
    }
    if (text === '4' || text.includes('physio')) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO, data: null });
      session.data = null;
      return await this.handleBookSpecificPhysio(session, '');
    }
    // Word-boundary match — 'clinic' as a bare substring false-positives on
    // "clinical" (e.g. "clinical pilates", "clinical assessment").
    if (text === '5' || /\bclinic\b/.test(text)) {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC, data: null });
      session.data = null;
      return await this.handleBookSpecificClinic(session, '');
    }
    if (text) {
      const nlu = await NluRouter.classifyIntent(text, this.STATES.BOOKING_METHOD_OPTIONS, session);
      const matched = NluRouter.isConfident(nlu);
      this.logger.analyticsEvent({ event: 'nlu_intent_classified', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: 'BOOKING_METHOD_OPTIONS', intent: nlu.intent, confidence: nlu.confidence, matched });
      if (matched) {
        const BOOKING_METHOD_INTENT_STATES = {
          book_history: [this.STATES.BOOK_HISTORY, this.handleBookHistory],
          book_soonest: [this.STATES.BOOK_SOONEST, this.handleBookSoonest],
          // book_by_type: type named, no specific method/clinic decided — routes
          // into the same BOOK_SOONEST funnel (type -> physio -> clinic), which
          // already resolves this shape of request rather than forcing a
          // method choice first (see NluRouter.js KNOWN_INTENTS comment).
          book_by_type: [this.STATES.BOOK_SOONEST, this.handleBookSoonest],
          book_specific_date: [this.STATES.BOOK_SPECIFIC_DATE, this.handleBookSpecificDate],
          book_specific_physio: [this.STATES.BOOK_SPECIFIC_PHYSIO, this.handleBookSpecificPhysio],
          book_specific_clinic: [this.STATES.BOOK_SPECIFIC_CLINIC, this.handleBookSpecificClinic],
        };
        // Intents whose slots (if any) should be stashed for the target
        // handler to consume — see SLOT_CONSUMING_INTENTS' handlers' own
        // choose_type/choose_date/choose_physio steps (handleBookSpecificClinic,
        // handleBookSoonest, handleBookSpecificDate, handleBookSpecificPhysio).
        const SLOT_CONSUMING_INTENTS = new Set(['book_specific_clinic', 'book_by_type', 'book_specific_date', 'book_specific_physio']);
        let match = BOOKING_METHOD_INTENT_STATES[nlu.intent];
        // Phase 7: a message can carry both date and physio slots at once
        // (e.g. "book with Dr Chan next Tuesday"). Only handleBookSpecificDate's
        // funnel has steps for both (choose_date -> ... -> choose_physio) —
        // handleBookSpecificPhysio's funnel has no date step at all — so any
        // message with both slots present routes there regardless of which
        // single intent NLU picked as primary.
        const hasBothSlots = (nlu.intent === 'book_specific_date' || nlu.intent === 'book_specific_physio')
          && nlu.slots && nlu.slots.date && nlu.slots.physio;
        if (hasBothSlots) {
          match = BOOKING_METHOD_INTENT_STATES.book_specific_date;
        }
        if (match) {
          const [state, handler] = match;
          // Slot pre-fill (Phase 2: appointmentType; Phase 5: date, physio;
          // Phase 7: both date+physio together): stash the raw NLU slot(s)
          // on session.data so the handler can match/apply them once it has
          // the real list to match against. Consumed exactly once inside the
          // handler's own choose_* step.
          let initialData = null;
          if (SLOT_CONSUMING_INTENTS.has(nlu.intent) && nlu.slots) {
            const pending = {};
            if (nlu.slots.appointmentType) pending.appointmentType = nlu.slots.appointmentType;
            if (hasBothSlots) {
              pending.date = nlu.slots.date;
              pending.physio = nlu.slots.physio;
            } else {
              if (nlu.intent === 'book_specific_date' && nlu.slots.date) pending.date = nlu.slots.date;
              if (nlu.intent === 'book_specific_physio' && nlu.slots.physio) pending.physio = nlu.slots.physio;
            }
            if (Object.keys(pending).length) initialData = JSON.stringify({ pending_nlu_slots: pending });
          }
          await this.sessionManager.updateSession(session.id, { conversation_state: state, data: initialData });
          session.data = initialData;
          return await handler.call(this, session, '');
        }
      }
      this.logger.analyticsEvent({ event: 'nlu_fallback_low_confidence', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: 'BOOKING_METHOD_OPTIONS', intent: nlu.intent, confidence: nlu.confidence });
    }

    return prependTextToEnvelope(t(this._getSessionLanguage(session), 'common.invalidBookingMethod'), await this.renderBookingMethodMenu(session));
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

  _buildNoSlotsSummary(session, data) {
    const src = (key) => data[key] || data.prev_state_data?.[key];
    const apptName = src('selected_appt_type')?.name || '';
    const physio   = getPractitionerDisplayName(src('selected_physio'), this._getSessionLanguage(session), this.logger);
    const clinicObj = src('selected_clinic');
    const clinic   = clinicObj?.business_name || (typeof clinicObj === 'string' ? clinicObj : '');
    const userPhone = session.phone_number || session.phoneNumber || '';

    let msg = 'Hi, I tried to book';
    if (apptName) msg += ` a ${apptName}`;
    if (physio)   msg += ` with ${physio}`;
    if (clinic)   msg += ` at ${clinic}`;
    msg += ' but no slots were available.';
    if (userPhone) msg += ` My WhatsApp: ${userPhone}.`;
    return msg;
  }

  _buildWaLink(phone, summary) {
    const num = String(phone).replace(/\D/g, '');
    return `https://wa.me/${num}?text=${encodeURIComponent(summary)}`;
  }

  _getNoSlotsPhone(session, data) {
    const region = this._getSessionRegion(session);
    const info = REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG;
    if (info.clinicPhones) {
      const src = (key) => data[key] || data.prev_state_data?.[key];
      const clinicObj = src('selected_clinic');
      const name = clinicObj?.business_name || (typeof clinicObj === 'string' ? clinicObj : '');
      const match = name.match(/\((WS|WWH|TST|QB)\)/i);
      if (match) return info.clinicPhones[match[1].toUpperCase()] || info.phone;
    }
    return info.phone;
  }

  /**
   * Resolves the support email for a region, using per-clinic email
   * (currently HK's WS/WWH/TST/QB) when clinicName matches one of the
   * clinic codes, else the region's default email. Mirrors
   * _getNoSlotsPhone's per-clinic phone resolution.
   * @param {string} region
   * @param {string} [clinicName] - business/clinic display name, may contain "(WS)" etc.
   */
  _resolveSupportEmail(region, clinicName) {
    const info = REGION_SUPPORT_INFO[region] || REGION_SUPPORT_INFO.SG;
    if (info.clinicEmails && clinicName) {
      const match = String(clinicName).match(/\((WS|WWH|TST|QB)\)/i);
      if (match) return info.clinicEmails[match[1].toUpperCase()] || info.email;
    }
    return info.email;
  }

  /**
   * Central "no results" surface for booking flows (Layer 2 of the 2026-07-19
   * incident fix — see _noSlotsRetry/ClinikoAPI._partial marker/d99d90d).
   *
   * Replaces the old ad hoc pattern (each call site hand-writing
   * `data.no_slots_prompt = {...}; sync(); return buttons(...)`, with
   * retry_step optional and easy to forget) with one path that:
   *  - always sets retry_step, defaulting to the CURRENT selection_step, so
   *    Try Again re-enters this exact step in place instead of falling back
   *    to _handleNoSlotsDecision's generic navBack() and discarding whatever
   *    the user already selected;
   *  - checks the triggering Cliniko result's _partial marker (set by
   *    getAvailableSlotsByBusinessAndDate when an inner fetch failed, e.g. a
   *    429 under concurrent load) to show honest wording — "having trouble
   *    checking availability" instead of asserting confirmed unavailability
   *    when we can't actually be sure.
   *
   * @param {object} session
   * @param {object} data - mutable session.data object (already parsed)
   * @param {string} stateConst - this.STATES.* value for the current handler
   * @param {object} opts
   * @param {string} opts.context - no_slots_prompt.context (drives support email routing)
   * @param {string} opts.confirmedMessage - shown when the result is not marked _partial
   * @param {string} [opts.retryStep] - defaults to data.selection_step
   * @param {Array|Array[]} [opts.result] - the Cliniko result(s) that triggered this;
   *   an array (checked for ._partial) or an array of arrays (checked with .some())
   * @param {string} [opts.retryLabel] - button title for option 1, default 'Try Again'.
   *   Use an honest alternative (e.g. 'Try another physio') when retryStep
   *   actually changes what gets picked, not just re-runs the same fetch.
   * @returns {Promise<object>} buttons() envelope
   */
  async _noSlotsRetry(session, data, stateConst, { context, confirmedMessage, retryStep, result, retryLabel } = {}) {
    const language = this._getSessionLanguage(session);
    const step = retryStep || data.selection_step;
    data.no_slots_prompt = { context, retry_step: step };
    session.conversation_state = stateConst;
    session.data = JSON.stringify(data);
    await this.sessionManager.updateSession(session.id, { conversation_state: stateConst, data: session.data });

    // result may be a single Cliniko result array (check result._partial) or
    // an array of them, e.g. one per clinic in a Promise.all fan-out (check
    // whether any element is _partial) — handle both without the caller
    // needing to tell us which shape it passed.
    const partial = !!(result && (result._partial || (Array.isArray(result) && result.some(r => Array.isArray(r) && r._partial))));
    const body = partial
      ? t(language, 'noSlots.transientFailure')
      : confirmedMessage;
    // If this might just be a transient fetch failure, "Try Again" is the
    // honest label regardless of what a confirmed-empty retryLabel would say
    // (e.g. 'Try another physio' implies this physio is confirmed unavailable,
    // which we can't actually assert here).
    const label = partial ? t(language, 'common.tryAgain') : (retryLabel || t(language, 'common.tryAgain'));

    return buttons(body, [
      { id: '1', title: label },
      { id: '2', title: t(language, 'common.emailUs') },
      { id: '3', title: t(language, 'common.messageOnWhatsApp') },
    ]);
  }

  /**
   * Phase 8: shared mid-flow "restart" check for the three BOOK_SPECIFIC_*
   * mid-flow-correction call sites. Called with the NLU result already
   * classified there (no extra API call) — if the user wants to abandon
   * the current funnel entirely rather than correct one slot, clears the
   * funnel and returns to the booking-method menu, same as the existing
   * literal 'menu' branch each of those handlers already has.
   * Returns the envelope to send, or null if this wasn't a restart.
   */
  async _maybeHandleMidflowRestart(session, result, stateConst) {
    if (!result || result.intent !== 'restart_menu' || !NluRouter.isConfident(result)) return null;
    this.logger.analyticsEvent({ event: 'nlu_midflow_restart', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: stateConst });
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    return await this.goToInteractiveMenu(session);
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
        session.data = JSON.stringify(data);
        if (stateConst) session.conversation_state = stateConst;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: stateConst,
          data: session.data
        });
        return await backHandler.call(this, session, '');
      }
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return await this.goToInteractiveMenu(session);
    }

    // 1 — try again
    if (text === '1') {
      const retryStep = data.no_slots_prompt.retry_step;
      delete data.no_slots_prompt;

      // Caller opted in with a retry_step: the user already made a complete,
      // valid selection and only the final fetch failed (e.g. a transient
      // Cliniko error). Re-run that step in place instead of walking back
      // through navBack, which would discard the selection and force the
      // user to re-answer the whole funnel.
      if (retryStep) {
        data.selection_step = retryStep;
        session.data = JSON.stringify(data);
        if (stateConst) session.conversation_state = stateConst;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: stateConst,
          data: session.data
        });
        return await backHandler.call(this, session, '');
      }

      const { step, popped } = navBack(data);
      if (step) {
        clearForwardStateForPopped(data, popped);
        data.selection_step = step;
        data.suppress_auto_advance = true;
        session.data = JSON.stringify(data);
        if (stateConst) session.conversation_state = stateConst;
        await this.sessionManager.updateSession(session.id, {
          conversation_state: stateConst,
          data: session.data
        });
        return await backHandler.call(this, session, '');
      }
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOKING_METHOD_OPTIONS,
        data: null
      });
      return await this.goToInteractiveMenu(session);
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
      this.logger.analyticsEvent({ event: 'handoff_frontdesk', reason: 'no_slots', sessionId: session.id, region, ts: Date.now() });
      const userPhone = session.phone_number || session.phoneNumber || emailPayload?.meta?.phone || '';

      delete data.no_slots_prompt;
      session.data = JSON.stringify(data);
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: session.data
      });
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'noSlots.supportTeamThanks', { region }), await this.renderMainMenu(session));
    }

    // 3 — message us (open WhatsApp with pre-filled context)
    if (text === '3') {
      let context = session.context;
      if (context && typeof context === 'string') { try { context = JSON.parse(context); } catch {} }
      const region = (context && context.region) || this._getSessionRegion(session) || 'SG';
      const waLink = this._buildWaLink(this._getNoSlotsPhone(session, data), this._buildNoSlotsSummary(session, data));

      delete data.no_slots_prompt;
      session.data = JSON.stringify(data);
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.BOOK_MANAGE_OPTIONS,
        data: session.data
      });
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'noSlots.tapToMessageTeam', { region, link: waLink }), await this.renderMainMenu(session));
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
        return t(this._getSessionLanguage(session), 'bookHistory.verifyRequired');
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
        const practitioner = pracById.get(pid);
        if (!practitioner) continue; // not in the online-booking practitioner list (e.g. a room/resource, not a physio)
        const bid = String(a.business_id || refId(a.business, 'businesses') || '');
        const seen = a.starts_at || a.created_at || a.updated_at || new Date(0).toISOString();
        const prev = byPrac.get(pid);
        if (!prev || new Date(seen) > new Date(prev.last_seen)) {
          byPrac.set(pid, {
            practitioner,
            last_seen: seen,
            last_clinic_id: bid
          });
        }
      }

      const physios = Array.from(byPrac.values()).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
      if (!physios.length) {
        await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
        return t(this._getSessionLanguage(session), 'bookHistory.noPriorVisits');
      }

      data.history_physio_list = physios;
      data.history_physio_page = 0;
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

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.history_physio_page = (data.history_physio_page || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
      }
      if (/^p(rev)?$/i.test(text)) {
        data.history_physio_page = Math.max(0, (data.history_physio_page || 0) - 1);
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
      }

      if (/^\d+$/.test(text)) {
        const page = data.history_physio_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const idx = pageStart + localNum - 1;
        if (localNum < 1 || localNum > Math.min(pageSize, list.length - pageStart) || !list[idx]) return t(this._getSessionLanguage(session), 'bookHistory.invalidNumericSelection');
        data.selected_physio = list[idx].practitioner;
        data.last_clinic_id = list[idx].last_clinic_id || '';
        data.selection_step = 'choose_type';
        navPush(data, 'choose_type', { had_multiple_options: (list.length > 1), auto: false });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        return await this.handleBookHistory(session, '');
      }

      const language = this._getSessionLanguage(session);
      const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: list,
        rowFn: (p) => ({
          title: getPractitionerDisplayName(p.practitioner, this._getSessionLanguage(session), this.logger) || '',
          description: t(language, 'bookHistory.lastSeen', { date: formatSlotDateTime(p.last_seen, this._regionTz(session)) })
        }),
        page: data.history_physio_page || 0,
        header: t(language, 'bookHistory.choosePhysio')
      });
      return reply;
    }

    // ===== choose_type (unique names; exclude Initial/New; map name→ids; exclude UWC) =====
    if (data.selection_step === 'choose_type') {
      if (!Array.isArray(data.appointment_type_list)) {
        const physioId = String(data.selected_physio?.id || data.selected_physio);
        const types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: physioId });

        const isSG = this._getSessionRegion(session) === 'SG';
        const servicesSplit = this._servicesWithPatientTypeSplit(types);
        // Tier pairs can't be detected from this one physio's own type list
        // (see _clinicWideTypesForTierDetection's doc) — use the clinic-wide
        // list for detection only; bucketing itself still uses `types`.
        const tierBaseNames = this._tierBaseNamesWithVariants(await this._clinicWideTypesForTierDetection(session));
        const buckets = new Map(); // bucketKey -> { displayName, entries: [{id, insurer}] }
        for (const t of types || []) {
          if (!t || !t.name) continue;
          if (/UWC/i.test(t.name) || /online\s*booking/i.test(t.name)) continue;
          if (/\b(initial|new\s*clients?)\b/i.test(t.name)) continue; // no Initial/New in history flow
          const { bucketKey, displayName, service, duration } = this._bucketApptType(t, normName, isSG, servicesSplit, hasCapability(this._getSessionRegion(session), 'physioTiers'), tierBaseNames);
          const { insurer } = parseApptCategory(t.category);
          if (!buckets.has(bucketKey)) buckets.set(bucketKey, { displayName, entries: [], service, duration });
          buckets.get(bucketKey).entries.push({ id: String(t.id), insurer: insurer || null });
        }

        let typeList = Array.from(buckets.values()).map(v => ({
          name: v.displayName,
          norm_name: normName(v.displayName),
          ids: v.entries.map(e => e.id),
          entries: v.entries,
          service: v.service,
          duration: v.duration,
        }));
        if (isSG) typeList = this._disambiguateSGTypeNames(typeList);
        data.appointment_type_list = sortAppointmentTypes(typeList);
        data.appt_type_page = 0;
        data.appt_type_name_to_ids_norm = Object.fromEntries(
          (data.appointment_type_list || []).map(x => [x.norm_name, x.ids])
        );

        const fwd = planForward(data, 'choose_type', data.appointment_type_list.length, () => {
          this._applyTypeSelection(data, data.appointment_type_list[0]);
        });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        if (fwd.advanced) return await this.handleBookHistory(session, '');
      }

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.appt_type_page = (Number(data.appt_type_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
      }
if (/^p(rev)?$/i.test(text)) {
  data.appt_type_page = Math.max(0, (Number(data.appt_type_page) || 0) - 1);
  await sync({ conversation_state: this.STATES.BOOK_HISTORY });
}

      if (/^\d+$/.test(text)) {
        const page = data.appt_type_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const list = data.appointment_type_list || [];
        const idx = pageStart + localNum - 1;
        if (localNum < 1 || localNum > Math.min(pageSize, list.length - pageStart) || !list[idx]) return t(this._getSessionLanguage(session), 'bookHistory.invalidApptTypeSelection');
        this._applyTypeSelection(data, list[idx]);
        navPush(data, 'choose_clinic', { had_multiple_options: (list.length > 1), auto: false });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        return await this.handleBookHistory(session, '');
      }

      const reply2 = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: data.appointment_type_list || [],
        rowFn: (a) => ({ title: String(translateApptTypeName(a.name, this._getSessionLanguage(session), this.logger)) }),
        page: data.appt_type_page || 0,
        header: t(this._getSessionLanguage(session), 'bookHistory.chooseApptType', { name: getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger) })
      });
      return reply2;
    }

    // ===== choose_type_insurer: disambiguate insurer when the chosen type name
    // covers multiple insurer/self-pay variants (same display name, different
    // Cliniko appointment-type IDs). Not a navPush frame — Back returns to
    // choose_type, same as Book Soonest's funnel sub-steps. =====
    if (data.selection_step === 'choose_type_insurer') {
      const stepResult = this._stepTypeInsurer(session, data, text);
      if (stepResult.reply) {
        // Persist mutations from _stepTypeInsurer (e.g. insurer_page changes)
        // even while still prompting — otherwise paging never advances.
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        return stepResult.reply;
      }
      data.selection_step = 'choose_clinic';
      await sync({ conversation_state: this.STATES.BOOK_HISTORY });
      return await this.handleBookHistory(session, '');
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
        data.clinic_page = 0;

        const fwd = planForward(data, 'choose_clinic', clinics.length, () => {
          data.selected_clinic = clinics[0];
          data.selection_step = 'view_slots';
        });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        if (fwd.advanced) return await this.handleBookHistory(session, '');
      }

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.clinic_page = (data.clinic_page || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
      }
      if (/^p(rev)?$/i.test(text)) {
        data.clinic_page = Math.max(0, (data.clinic_page || 0) - 1);
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
      }

      if (/^\d+$/.test(text)) {
        const page = data.clinic_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const list = data.clinic_list || [];
        const idx = pageStart + localNum - 1;
        if (localNum < 1 || localNum > Math.min(pageSize, list.length - pageStart) || !list[idx]) return t(this._getSessionLanguage(session), 'bookHistory.invalidClinicSelection');
        data.selected_clinic = list[idx];
        data.selection_step = 'view_slots';
        navPush(data, 'view_slots', { had_multiple_options: (list.length > 1), auto: false });
        await sync({ conversation_state: this.STATES.BOOK_HISTORY });
        return await this.handleBookHistory(session, '');
      }

      const reply3 = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: data.clinic_list || [],
        rowFn: (c) => ({ title: String(c.business_name) }),
        page: data.clinic_page || 0,
        header: t(this._getSessionLanguage(session), 'bookHistory.selectClinic')
      });
      return reply3;
    }

    // ===== view_slots → SELECT_SLOT =====
    if (data.selection_step === 'view_slots') {
      const { from, to } = normalizeDateWindow();
      const physioId = String(data.selected_physio?.id || data.selected_physio);
      const businessId = String(data.selected_clinic?.id);
      const resolvedIds = data.selected_appt_type?.ids;
      const typeNorm = normName(data.selected_appt_type?.name || '');

      const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
        business_id: businessId,
        practitioner_id: physioId,
        from,
        to
      });
      const filtered = deduplicateSlots((raw || []).filter(s =>
        resolvedIds && resolvedIds.length
          ? resolvedIds.includes(String(s.appointment_type_id))
          : normName(s.appointment_type_name) === typeNorm
      ));

      if (!filtered.length) {
        // retry_step defaults to 'view_slots' (the current step) — Try Again
        // re-runs this exact fetch with selected_physio/selected_clinic/
        // selected_appt_type untouched. Pass raw (unfiltered) so the _partial
        // marker survives — filtered is a new array from .filter().
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_HISTORY, {
          context: 'history',
          result: raw,
          confirmedMessage: t(this._getSessionLanguage(session), 'bookHistory.noSlotsForCombo') + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
        });
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

      const header = `${getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger)} • ${getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger)} • ${getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger)}`;
      return this._buildSlotList(filtered, 0, header, this._regionTz(session), this._getSessionLanguage(session));
    }

    // Fallback
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
    return await this.goToInteractiveMenu(session);
  }

  /**
   * Progressive funnel for selecting an appointment type.
   * Guides the patient through: service → patient type → insurer → duration.
   * Offers a "same as last time?" shortcut when a saved preference exists.
   *
   * data.funnel_catalogue must be set by the caller before the first call.
   *
   * Returns { reply: MessageEnvelope } while gathering input, or
   *         { resolved: { name, ids, norm_name } | null } when done.
   */
  /**
   * Set data.selected_appt_type from a bucketed type-list entry ({name, norm_name,
   * ids, entries}), routing to the choose_type_insurer sub-step to disambiguate.
   * Copies the entry so narrowing .ids/.insurer during resolution doesn't mutate
   * the shared appointment_type_list (needed since re-visiting choose_type must
   * see the original, unnarrowed entries again).
   */
  _applyTypeSelection(data, entry) {
    data.selected_appt_type = { ...entry };
    data.selection_step = 'choose_type_insurer';
    data.insurer_page = 0;
  }

  /**
   * Disambiguate which insurer/self-pay variant of a same-named appointment type
   * the user means, using data.selected_appt_type.entries ({id, insurer}[]) set by
   * _applyTypeSelection. Shared across History/SpecificDate/SpecificPhysio/
   * SpecificClinic — mirrors Book Soonest's funnel insurer step (_stepApptFunnel).
   *
   * - No insurer variants at all (self-pay only): resolves immediately, no prompt.
   * - Durable preferred_insurer (from Change Preferences) auto-applies on first
   *   arrival if it's actually offered for this type; falls through to prompting
   *   otherwise, same fallback semantics as the Book Soonest funnel.
   * - Narrows selected_appt_type.ids to just the resolved insurer's id(s) and sets
   *   .insurer, so downstream slot-matching and no-slots messaging are insurer-scoped.
   *
   * @returns {{ reply?: MessageEnvelope }} reply while asking; {} once resolved.
   */
  _stepTypeInsurer(session, data, text) {
    const language = this._getSessionLanguage(session);
    const entries = data.selected_appt_type?.entries || [];
    const insurers = [...new Set(entries.map(e => e.insurer).filter(i => i !== null))].sort();

    const resolve = (chosen) => {
      data.selected_appt_type.ids = entries.filter(e => e.insurer === chosen).map(e => e.id);
      data.selected_appt_type.insurer = chosen;
      delete data.insurer_page;
    };

    if (!insurers.length) {
      resolve(null);
      return {};
    }

    if (text === '' && data.selected_appt_type.insurer === undefined) {
      const preferred = session.context && session.context.preferred_insurer;
      if (preferred === '') { resolve(null); return {}; }
      if (preferred && insurers.includes(preferred)) { resolve(preferred); return {}; }
    }

    const options = ['Self-pay', ...insurers];
    const translatedOptions = options.map(o => o === 'Self-pay'
      ? t(language, 'bookSoonest.funnelSelfPay')
      : translateInsurerName(o, language, this.logger));

    // Same paging convention as _stepApptFunnel's insurer stage — a list beyond
    // a handful of insurers must page like every other interactive list here
    // (2026-07-19 incident: an unpaginated 6+ row list pushed Send off-screen).
    if (/^p(rev)?$/i.test(text)) {
      data.insurer_page = Math.max(0, (data.insurer_page || 0) - 1);
      text = '';
    } else if (/^m(ore)?$|^next$/i.test(text)) {
      data.insurer_page = (data.insurer_page || 0) + 1;
      text = '';
    }

    const page = data.insurer_page || 0;
    const pageStart = interactivePageStart(page);
    const pageSize = interactivePageSize(page);
    const localNum = /^\d+$/.test(text) ? parseInt(text, 10) : -1;
    if (localNum >= 1 && localNum <= Math.min(pageSize, options.length - pageStart)) {
      const picked = options[pageStart + localNum - 1];
      resolve(picked === 'Self-pay' ? null : picked);
      return {};
    }

    const badInput = text !== '';
    const menu = options.length <= 3
      ? buttons(t(language, 'bookSoonest.funnelHowCovered'), translatedOptions.map((o, i) => ({ id: String(i + 1), title: o.slice(0, 20) })))
      : buildInteractiveSelectionList({ language: this._getSessionLanguage(session), header: t(language, 'bookSoonest.funnelHowCovered'), items: translatedOptions, rowFn: (o) => ({ title: o.slice(0, 24) }), page });
    return { reply: badInput ? prependTextToEnvelope(t(language, 'bookSoonest.funnelPleaseChooseFromList'), menu) : menu };
  }

  /**
   * Extra wording appended to a confirmed-empty no-slots message when the
   * resolved appointment type was scoped to a specific insurer (whether
   * picked manually or auto-applied from the durable preferred_insurer).
   * Makes it clear the shortage is insurer-specific, not a hard "fully
   * booked" — and points at where to change it without hunting for it.
   */
  _insurerNoMatchSuffix(selectedApptType, language) {
    const insurer = selectedApptType && selectedApptType.insurer;
    if (!insurer) return '';
    const displayInsurer = translateInsurerName(insurer, language || 'en', this.logger);
    return ` ${t(language || 'en', 'insurerNoMatch.suffix', { insurer: displayInsurer })}`;
  }

  async _stepApptFunnel(session, data, text) {
    const catalogue = data.funnel_catalogue || [];
    const language = this._getSessionLanguage(session);
    // True when text was a real user reply that failed to match — prepend error to re-shown menus.
    // Must be let so it can be reset to false once a step consumes the text via text=''.
    let badInput = text !== '' && text !== 'yes' && text !== 'change';

    // First entry: offer shortcut if preference exists, otherwise start at service
    if (!data.funnel_step) {
      const pref = session.context && session.context.appt_preference;
      if (pref && text === '') {
        const label = this._formatPrefLabel(pref, language);
        if (label) {
          data.funnel_step = 'shortcut';
          return { reply: buttons(t(language, 'bookSoonest.funnelLastTime', { label }), [
            { id: 'yes', title: t(language, 'bookSoonest.funnelYesSame') },
            { id: 'change', title: t(language, 'bookSoonest.funnelChange') },
          ]) };
        }
      }
      data.funnel_step = 'service';
      data.funnel_sel = {};
      data.appt_type_page = 0;
    }

    // Shortcut handler
    if (data.funnel_step === 'shortcut') {
      if (text === 'yes') {
        const pref = session.context && session.context.appt_preference;
        if (pref) {
          const resolved = resolveApptFromFunnel(catalogue, pref);
          if (resolved) return { resolved };
        }
      }
      // "change" or shortcut no longer available → restart funnel
      data.funnel_step = 'service';
      data.funnel_sel = {};
      data.appt_type_page = 0;
      text = '';
    }

    // Auto-advance loop: skip steps with a single option
    let guard = 0;
    while (guard++ < 10) {
      const step = data.funnel_step;
      const sel = data.funnel_sel || {};

      // ── service ──
      if (step === 'service') {
        const services = [...new Set(catalogue.map(t => t.service).filter(Boolean))].sort();
        if (!services.length) return { resolved: null };
        if (services.length === 1 && text === '') {
          sel.service = services[0];
          data.funnel_sel = sel;
          data.funnel_step = 'insurer';
          data.appt_type_page = 0;
          continue;
        }
        const page = data.appt_type_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = /^\d+$/.test(text) ? parseInt(text, 10) : -1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, services.length - pageStart)) {
          sel.service = services[pageStart + localNum - 1];
          data.funnel_sel = sel;
          data.funnel_step = 'insurer';
          data.appt_type_page = 0;
          text = '';
          continue;
        }
        {
          const menu = services.length <= 3
            ? buttons(t(language, 'bookSoonest.funnelWhatType'), services.map((s, i) => ({ id: String(i + 1), title: translateServiceName(s, language, this.logger).slice(0, 20) })))
            : buildInteractiveSelectionList({ language: this._getSessionLanguage(session), header: t(language, 'bookSoonest.funnelWhatType'), items: services, rowFn: (s) => ({ title: translateServiceName(s, language, this.logger).slice(0, 24) }), page });
          return { reply: badInput ? prependTextToEnvelope(t(language, 'bookSoonest.funnelPleaseChooseFromList'), menu) : menu };
        }
      }

      // ── insurer ──
      // Delegates to _stepTypeInsurer, the canonical insurer-selection implementation
      // also used by History/Specific Date/Specific Physio/Specific Clinic (see the
      // CLAUDE.md note on centralizing insurer logic there). data.selected_appt_type
      // is used as scratch space for the call — Book Soonest doesn't set its real
      // selected_appt_type until final_pick resolves, so this is safe as long as it's
      // always cleared before returning to the caller, on every exit path.
      if (step === 'insurer') {
        const filtered = catalogue.filter(t => t.service === sel.service);
        // _stepTypeInsurer handles the zero-insurer-variants case itself (resolves
        // to self-pay immediately, no prompt) — no need to duplicate that check here.
        // NOTE (i18n merge, not yet translated): _stepTypeInsurer is currently
        // hardcoded English ("How is this covered?", "Self-pay", etc.) across all
        // 5 flows that call it. Flagged as a self-audit gap, not fixed in this merge.
        data.selected_appt_type = { entries: filtered.map(t => ({ id: String(t.id), insurer: t.insurer || null })) };
        // _stepTypeInsurer computes and applies its own bad-input prefix — don't
        // double-wrap with this loop's outer `badInput`.
        const stepResult = this._stepTypeInsurer(session, data, text);
        if (stepResult.reply) {
          delete data.selected_appt_type;
          return { reply: stepResult.reply };
        }
        sel.insurer = data.selected_appt_type.insurer;
        delete data.selected_appt_type;
        data.funnel_sel = sel;
        data.funnel_step = 'final_pick';
        data.appt_type_page = 0;
        // Unlike the 'service' step above, this used to fall through to
        // final_pick without clearing text — so the numeric reply that just
        // picked an insurer (e.g. "1" for Self-pay) got silently replayed as
        // a final_pick menu selection, skipping that menu entirely. Confirmed
        // live 2026-09-22: this is the direct mechanism behind Book Soonest
        // "defaulting" to Senior Physiotherapist — whichever combo happened
        // to land at the reused index got auto-picked with no prompt shown.
        text = '';
        continue;
      }

      // ── final_pick: combined patientType + duration selection ──
      if (step === 'final_pick') {
        const filtered = catalogue.filter(t =>
          t.service === sel.service &&
          (t.insurer || null) === (sel.insurer || null)
        );
        const seen = new Set();
        const combos = [];
        for (const t of filtered) {
          const key = `${t.patientType}|${t.duration}`;
          if (!seen.has(key)) { seen.add(key); combos.push({ patientType: t.patientType, duration: t.duration }); }
        }
        combos.sort((a, b) => {
          const order = { new: 0, follow_up: 1 };
          const pa = order[a.patientType] ?? 2, pb = order[b.patientType] ?? 2;
          return pa !== pb ? pa - pb : a.duration - b.duration;
        });
        if (!combos.length) return { resolved: null };
        if (combos.length === 1 && text === '') {
          sel.patientType = combos[0].patientType;
          sel.duration = combos[0].duration;
          data.funnel_sel = sel;
          const resolved = resolveApptFromFunnel(catalogue, sel);
          this._saveFunnelPref(session, sel);
          return { resolved };
        }
        const allSameDuration   = combos.every(c => c.duration    === combos[0].duration);
        const allSamePatientType = combos.every(c => c.patientType === combos[0].patientType);
        const ptLabels = { new: t(language, 'bookSoonest.patientTypeNew'), follow_up: t(language, 'bookSoonest.patientTypeFollowUp') };
        const comboLabel = (c) => {
          const durLabel = `${c.duration}${t(language, 'common.minutesSuffix')}`;
          const ptPart  = !allSamePatientType && c.patientType ? ptLabels[c.patientType] : null;
          const durPart = !allSameDuration ? durLabel : null;
          return [ptPart, durPart].filter(Boolean).join(' ') || durLabel;
        };
        const bodyText = allSameDuration && !allSamePatientType
          ? t(language, 'bookSoonest.funnelNewOrReturning')
          : allSamePatientType && !allSameDuration
            ? t(language, 'bookSoonest.funnelSelectDuration')
            : t(language, 'bookSoonest.funnelSelectApptType');
        const page = data.appt_type_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = /^\d+$/.test(text) ? parseInt(text, 10) : -1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, combos.length - pageStart)) {
          const picked = combos[pageStart + localNum - 1];
          sel.patientType = picked.patientType;
          sel.duration    = picked.duration;
          data.funnel_sel = sel;
          const resolved = resolveApptFromFunnel(catalogue, sel);
          this._saveFunnelPref(session, sel);
          return { resolved };
        }
        {
          const menu = combos.length <= 3
            ? buttons(bodyText, combos.map((c, i) => ({ id: String(i + 1), title: comboLabel(c).slice(0, 20) })))
            : buildInteractiveSelectionList({ language: this._getSessionLanguage(session), header: bodyText, items: combos, rowFn: (c) => ({ title: comboLabel(c).slice(0, 24) }), page });
          return { reply: badInput ? prependTextToEnvelope(t(language, 'bookSoonest.funnelPleaseChooseFromList'), menu) : menu };
        }
      }

      break;
    }
    return { resolved: null };
  }

  _formatPrefLabel(pref, language) {
    if (!pref) return null;
    const parts = [translateServiceName(pref.service, language, this.logger)];
    if (pref.patientType === 'new') parts.push(t(language, 'bookSoonest.patientTypeNew'));
    else if (pref.patientType === 'follow_up') parts.push(t(language, 'bookSoonest.patientTypeFollowUp'));
    if (pref.insurer) parts.push(translateInsurerName(pref.insurer, language, this.logger));
    if (pref.duration) parts.push(`${pref.duration}${t(language, 'common.minutesSuffix')}`);
    return parts.filter(Boolean).join(' · ');
  }

  _saveFunnelPref(session, sel) {
    const phone = session.phone_number || session.phoneNumber;
    const pref = { service: sel.service, patientType: sel.patientType, insurer: sel.insurer || null, duration: sel.duration };
    let ctx = session.context;
    if (typeof ctx === 'string') { try { ctx = JSON.parse(ctx); } catch { ctx = {}; } }
    if (ctx && typeof ctx === 'object') { ctx.appt_preference = pref; session.context = ctx; }
    this.sessionManager.db.upsertPatientState(phone, { appt_preference: JSON.stringify(pref) }).catch(() => {});
  }

  /**
   * Progressive funnel for choosing a physio by gender and treatment category.
   * Steps: gender → category (auto-skipped when only one option).
   * Offers a "same as last time?" shortcut when a saved physio_preference exists.
   *
   * Returns { reply } while gathering input, or {} when the funnel is complete
   * (data.physio_funnel_step === 'done', data.physio_funnel_sel populated).
   */
  async _stepPhysioFunnel(session, data, text, { skipCategory = false } = {}) {
    const pracList = data.practitioner_list || [];

    // First entry
    if (!data.physio_funnel_step) {
      let ctx = session.context;
      if (ctx && typeof ctx === 'string') { try { ctx = JSON.parse(ctx); } catch { ctx = null; } }
      const pref = ctx && ctx.physio_preference;
      if (pref && text === '') {
        // When skipCategory: only show gender in the shortcut label so it's not misleading
        const displayPref = skipCategory ? { gender: pref.gender, category: null } : pref;
        const label = this._formatPhysioPrefLabel(displayPref);
        if (label) {
          data.physio_funnel_step = 'shortcut';
          return { reply: buttons(`Last time: ${label}\nSame preference?`, [
            { id: 'yes', title: 'Yes' },
            { id: 'change', title: 'Change' },
          ]) };
        }
      }
      data.physio_funnel_step = 'gender';
      data.physio_funnel_sel = {};
    }

    if (data.physio_funnel_step === 'shortcut') {
      if (text === 'yes') {
        let ctx = session.context;
        if (ctx && typeof ctx === 'string') { try { ctx = JSON.parse(ctx); } catch { ctx = null; } }
        const pref = ctx && ctx.physio_preference;
        if (pref) {
          data.physio_funnel_sel = {
            gender: pref.gender || null,
            category: skipCategory ? null : (pref.category || null),
          };
          data.physio_funnel_step = 'done';
          return {};
        }
      }
      data.physio_funnel_step = 'gender';
      data.physio_funnel_sel = {};
      text = '';
    }

    if (data.physio_funnel_step === 'gender') {
      const genderMap = ['male', 'female', null];
      const idx = /^\d+$/.test(text) ? parseInt(text, 10) - 1 : -1;
      if (idx >= 0 && idx <= 2) {
        data.physio_funnel_sel = { gender: genderMap[idx], category: null };
        data.physio_funnel_step = 'category';
        text = '';
      } else {
        const badInput = text !== '' && text !== 'yes' && text !== 'change';
        const genderBody = 'Do you have a preference for your physio?\n\n1. Male\n2. Female\n3. No preference\n\nTap a button, or type a number.';
        const menu = buttons(genderBody, [
          { id: '1', title: 'Male' },
          { id: '2', title: 'Female' },
          { id: '3', title: 'No preference' },
        ]);
        menu._textFallback = 'Do you have a preference for your physio?\n\n1. Male\n2. Female\n3. No preference\n\nReply with the number.';
        return { reply: badInput ? prependTextToEnvelope('Please choose an option.', menu) : menu };
      }
    }

    if (data.physio_funnel_step === 'category') {
      const sel = data.physio_funnel_sel || {};

      // Gender-only flows skip the category step entirely
      if (skipCategory) {
        sel.category = null;
        data.physio_funnel_sel = sel;
        data.physio_funnel_step = 'done';
        this._savePhysioPref(session, sel);
        return {};
      }

      // Fetch and cache per-practitioner categories for the gender-filtered set
      if (!data.physio_categories) {
        const genderFiltered = pracList.filter(p => {
          if (!sel.gender) return true;
          const g = practitionerGender(p);
          return g === null || g === sel.gender;
        });
        const allTypes = await Promise.all(
          genderFiltered.map(p => this.clinikoAPI.getAppointmentTypes({ practitioner_id: p.id }))
        );
        data.physio_categories = genderFiltered.map((p, i) => ({
          id: String(p.id),
          categories: [...new Set(
            (allTypes[i] || [])
              .filter(t => t && t.name && !/UWC/i.test(t.name) && !/online\s*booking/i.test(t.name))
              .map(t => parseApptCategory(t.category).service)
              .filter(Boolean)
          )],
        }));
      }

      const genderFiltered = pracList.filter(p => {
        if (!sel.gender) return true;
        const g = practitionerGender(p);
        return g === null || g === sel.gender;
      });
      const catMap = new Map((data.physio_categories || []).map(pc => [pc.id, pc.categories]));
      const allCats = [...new Set(genderFiltered.flatMap(p => catMap.get(String(p.id)) || []))].sort();

      // Auto-advance: zero or one category — nothing meaningful to ask
      if (allCats.length <= 1) {
        sel.category = allCats[0] || null;
        data.physio_funnel_sel = sel;
        data.physio_funnel_step = 'done';
        this._savePhysioPref(session, sel);
        return {};
      }

      const idx = /^\d+$/.test(text) ? parseInt(text, 10) - 1 : -1;
      if (idx >= 0 && idx < allCats.length) {
        sel.category = allCats[idx];
        data.physio_funnel_sel = sel;
        data.physio_funnel_step = 'done';
        this._savePhysioPref(session, sel);
        return {};
      }

      const badInput = text !== '';
      let catMenu;
      if (allCats.length <= 3) {
        const catBody = 'What type of treatment?\n\n' + allCats.map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n\nTap a button, or type a number.';
        catMenu = buttons(catBody, allCats.map((c, i) => ({ id: String(i + 1), title: c.slice(0, 20) })));
        catMenu._textFallback = 'What type of treatment?\n\n' + allCats.map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n\nReply with the number.';
      } else {
        catMenu = list('What type of treatment?', 'Select type', allCats.map((c, i) => ({ id: String(i + 1), title: c.slice(0, 24) })));
      }
      return { reply: badInput ? prependTextToEnvelope('Please choose an option from the list.', catMenu) : catMenu };
    }

    return {};
  }

  /**
   * Filter a practitioner list by the resolved physio preference (gender + category).
   * Practitioners with unknown gender (null title) are included in either gender filter.
   * Falls back to the full list if the filter would produce an empty result.
   */
  _applyPhysioFilter(fullList, sel, physioCategories) {
    if (!sel || !fullList || !fullList.length) return fullList || [];
    let result = fullList;

    if (sel.gender) {
      result = result.filter(p => {
        const g = practitionerGender(p);
        return g === null || g === sel.gender;
      });
    }

    if (sel.category && physioCategories && physioCategories.length) {
      const catMap = new Map(physioCategories.map(pc => [pc.id, pc.categories]));
      result = result.filter(p => {
        const cats = catMap.get(String(p.id)) || [];
        return cats.length === 0 || cats.includes(sel.category);
      });
    }

    return result.length > 0 ? result : fullList;
  }

  /**
   * Physio-tier funnel (e.g. SG: standard vs senior physio) — asked BEFORE
   * the gender-preference funnel, only when the region has the 'physioTiers'
   * capability (config-driven, src/config/regions.js — not a region literal)
   * AND the resolved (possibly tier-merged) appointment type actually spans
   * more than one real Cliniko type name across the candidate practitioners.
   * A no-op everywhere else (HK included), matching _stepPhysioFunnel's
   * 'done' sentinel shape. Confirmed live 2026-09-29: SG's "Physiotherapist"
   * vs "Senior Physiotherapist" is exactly this shape — same visit, priced
   * per practitioner, no longer shown as separate appointment types (see
   * resolveApptFromFunnel / _bucketApptType), but the choice of WHICH
   * practitioner (tier) still needs to be made somewhere — here, before
   * gender, not as a type-selection menu item.
   *
   * @param {object} session
   * @param {object} data - data.selected_appt_type.ids and
   *   data.practitioner_list must already be set by the caller. Generic
   *   across all 5 booking flows — uses ids (always present, from whichever
   *   choose_type builder ran), not Book Soonest's norm_names specifically.
   * @param {string} text
   * @returns {Promise<{reply}|{}>}
   */
  async _stepPhysioTierFunnel(session, data, text) {
    const region = this._getSessionRegion(session);
    const ids = data.selected_appt_type && data.selected_appt_type.ids;
    if (!hasCapability(region, 'physioTiers') || !Array.isArray(ids) || ids.length < 2) {
      data.physio_tier_step = 'done';
      return { skipped: true };
    }

    if (!data.physio_tier_groups) {
      const pracList = data.practitioner_list || [];
      // Match by the resolved type's own ids, NOT by name — a practitioner
      // can hold an unrelated type sharing the same literal name under a
      // different category (confirmed live 2026-09-29: Chris Wong and Teck
      // Woon Tan both hold a Sports-Massage type literally named
      // "Physiotherapist", which would otherwise wrongly classify them into
      // the standard Physiotherapy tier). ids are already category-safe —
      // resolveApptFromFunnel only ever collects matches sharing the same
      // service/patientType/insurer/duration.
      const idsSet = new Set((data.selected_appt_type.ids || []).map(String));
      const groups = {};
      await Promise.all(pracList.map(async (p) => {
        const types = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: p.id });
        const match = (types || []).find(t => idsSet.has(String(t.id)));
        if (match) groups[String(p.id)] = normalizeTypeName(match.name);
      }));
      data.physio_tier_groups = groups;
      data.physio_tier_names = [...new Set(Object.values(groups))];
    }

    if (data.physio_tier_names.length < 2) {
      data.physio_tier_step = 'done';
      return { skipped: true };
    }

    // NOTE: a real selection here consumes `text` — the caller must re-enter
    // with a CLEARED text afterward (never fall through with the same text
    // to the next gate), or a valid tier-menu numeric reply like "1" would
    // get silently replayed as a gender-menu selection next — the same
    // failure class as the insurer→final_pick text-leak bug fixed 2026-09-22.
    const idx = /^\d+$/.test(text) ? parseInt(text, 10) - 1 : -1;
    if (idx >= 0 && idx < data.physio_tier_names.length) {
      data.physio_tier_sel = data.physio_tier_names[idx];
      data.physio_tier_step = 'done';
      return { resolved: true };
    }

    const badInput = text !== '';
    const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
    const options = data.physio_tier_names.map((n, i) => ({ id: String(i + 1), title: titleCase(n).slice(0, 20) }));
    const body = 'Which physio would you like?\n\n' + options.map((o, i) => `${i + 1}. ${o.title}`).join('\n') + '\n\nTap a button, or type a number.';
    const menu = buttons(body, options);
    menu._textFallback = body.replace('Tap a button, or type a number.', 'Reply with the number.');
    return { reply: badInput ? prependTextToEnvelope('Please choose an option.', menu) : menu };
  }

  /**
   * Filter a practitioner list by the resolved physio-tier preference.
   * Practitioners with no known tier membership (shouldn't happen once
   * _stepPhysioTierFunnel has run, but defensive) are included regardless.
   * Falls back to the full list if the filter would produce an empty result.
   */
  _applyPhysioTierFilter(fullList, tierSel, tierGroups) {
    if (!tierSel || !tierGroups || !fullList || !fullList.length) return fullList || [];
    const result = fullList.filter(p => {
      const tier = tierGroups[String(p.id)];
      return !tier || tier === tierSel;
    });
    return result.length > 0 ? result : fullList;
  }

  _savePhysioPref(session, sel) {
    const phone = session.phone_number || session.phoneNumber;
    const pref = { gender: sel.gender || null, category: sel.category || null };
    let ctx = session.context;
    if (typeof ctx === 'string') { try { ctx = JSON.parse(ctx); } catch { ctx = {}; } }
    if (ctx && typeof ctx === 'object') { ctx.physio_preference = pref; session.context = ctx; }
    this.sessionManager.db.upsertPatientState(phone, { physio_preference: JSON.stringify(pref) }).catch(() => {});
  }

  _formatPhysioPrefLabel(pref) {
    if (!pref) return null;
    const parts = [];
    if (pref.gender === 'male') parts.push('Male');
    else if (pref.gender === 'female') parts.push('Female');
    if (pref.category) parts.push(pref.category);
    return parts.length ? parts.join(' · ') : null;
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
      data.funnel_catalogue = buildFunnelCatalogue(allTypes);
      const isSG = this._getSessionRegion(session) === 'SG';
      const servicesSplit = this._servicesWithPatientTypeSplit(allTypes);
      const tierBaseNames = this._tierBaseNamesWithVariants(allTypes);
      const buckets = new Map(); // bucketKey -> { displayName, ids:Set }
      for (const t of allTypes || []) {
        if (!t || !t.name) continue;
        if (/UWC/i.test(t.name) || /online\s*booking/i.test(t.name)) continue;
        const { bucketKey, displayName, service, duration } = this._bucketApptType(t, normName, isSG, servicesSplit, hasCapability(this._getSessionRegion(session), 'physioTiers'), tierBaseNames);
        if (!buckets.has(bucketKey)) buckets.set(bucketKey, { displayName, ids: new Set(), service, duration });
        buckets.get(bucketKey).ids.add(String(t.id));
      }
      let list = Array.from(buckets.values())
        .map(b => ({ name: b.displayName, id: Array.from(b.ids)[0], norm_name: normName(b.displayName), service: b.service, duration: b.duration }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (isSG) list = this._disambiguateSGTypeNames(list);
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
     * True if this practitioner has at least one slot for any of the given
     * type NAMES (a single name, or a merged bucket's set of real Cliniko
     * names — e.g. SG's "Physiotherapist" + "Senior Physiotherapist", which
     * are the same bookable visit split only by practitioner rate tier) in
     * the standard soonest window across any of their clinics.
     */
    const practitionerHasSlotsForTypeName = async (practitioner, typeNorms) => {
      const norms = typeNorms instanceof Set ? typeNorms : new Set([typeNorms]);
      const clinics = await clinicsForPractitioner(practitioner.id);
      if (!clinics.length) return { hasSlots: false, partial: false };
      const { from, to } = normalizeDateWindow();
      let partial = false;
      for (const c of clinics) {
        const raw = await this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: String(c.id),
          practitioner_id: String(practitioner.id),
          from,
          to
        });
        if (raw && raw._partial) partial = true;
        const any = (raw || []).some(s => norms.has(normName(s.appointment_type_name)));
        if (any) return { hasSlots: true, partial };
      }
      return { hasSlots: false, partial };
    };

    /**
     * Build physio list that offers any of the given TYPE NAMES and has at
     * least one slot. Marks the returned array _partial if any practitioner's
     * type or slot fetch failed, so a resulting empty list surfaces as
     * "trouble checking availability, try again" (via _noSlotsRetry) rather
     * than a confirmed "no one has slots" — matching the same convention
     * already used by getAllAppointmentTypesForAllPractitioners and friends.
     */
    const buildAvailablePhysiosForTypeName = async (typeNorms) => {
      const norms = typeNorms instanceof Set ? typeNorms : new Set([typeNorms]);
      const groups = await this.clinikoAPI.getPractitionersByClinic();
      // Collect unique practitioners across all clinics
      const allPractitioners = [...new Map(
        (groups || []).flatMap(g => g.practitioners || []).map(p => [p.id, p])
      ).values()];
      // Filter by type name — bulkAll flags this as bulk so SendMessage
      // throttles concurrency instead of firing ~30-40 requests at once.
      const allTypes = await bulkAll(allPractitioners,
        p => this.clinikoAPI.getAppointmentTypes({ practitioner_id: p.id })
      );
      // bulkAll's own overall deadline (not just per-item failure) can also mark
      // the whole array _partial, with unsettled entries left undefined — check
      // both, and the `(allTypes[i] || [])` below already tolerates the latter.
      const hadTypeFetchFailure = !!allTypes._partial || allTypes.some(t => t && t._partial);
      const phys = allPractitioners.filter((p, i) =>
        (allTypes[i] || []).some(t => norms.has(normName(t.name)))
      );
      // Filter by slot availability — same throttling
      const slotResults = await bulkAll(phys,
        p => practitionerHasSlotsForTypeName(p, norms)
      );
      const hadSlotFetchFailure = !!slotResults._partial || slotResults.some(r => r && r.partial);
      const result = phys.filter((_, i) => (slotResults[i] || {}).hasSlots);
      return (hadTypeFetchFailure || hadSlotFetchFailure) ? _markPartial(result) : result;
    };

    if (data.no_slots_prompt) {
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
        const { list, map } = await buildTypeCatalogue(); // also rebuilds data.funnel_catalogue
        data.appointment_type_list = list; data.appt_type_name_to_ids_norm = map; data.appt_type_page = 0;
        delete data.selected_appt_type; delete data.practitioner_list; delete data.selected_physio;
        delete data.funnel_step; delete data.funnel_sel;
        delete data.physio_tier_step; delete data.physio_tier_sel; delete data.physio_tier_groups; delete data.physio_tier_names;
        delete data.physio_funnel_step; delete data.physio_funnel_sel; delete data.physio_categories;
        data.selection_step = 'choose_type';
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }

      if (data.selection_step === 'choose_clinic') {
        // Back to physios for same type — use the real merged Cliniko names
        // (norm_names), never the possibly-overridden display name (e.g.
        // "New Patient" for SG's tier-merged self-pay Physiotherapy), which
        // wouldn't match any real slot's appointment_type_name.
        const typeNorms = (data.selected_appt_type?.norm_names && data.selected_appt_type.norm_names.length)
          ? new Set(data.selected_appt_type.norm_names)
          : new Set([normName(data.selected_appt_type?.name || '')].filter(Boolean));
        const physios = typeNorms.size ? await buildAvailablePhysiosForTypeName(typeNorms) : [];
        if (physios.length > 1) {
          data.practitioner_list = sortPractitioners(physios); data.practitioner_page = 0; delete data.selected_physio;
          data.physio_tier_step = 'done'; // skip tier funnel on back — pref already captured
          data.physio_funnel_step = 'done'; // skip funnel on back — pref already captured
          data.selection_step = 'choose_physio';
          await sync({ conversation_state: this.STATES.BOOK_SOONEST });
          const effectiveList = this._applyPhysioTierFilter(
            this._applyPhysioFilter(data.practitioner_list, data.physio_funnel_sel, data.physio_categories),
            data.physio_tier_sel,
            data.physio_tier_groups
          );
          const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
            items: effectiveList,
            rowFn: (p) => ({ title: getPractitionerDisplayName(p, this._getSessionLanguage(session), this.logger) || `${p.first_name||''} ${p.last_name||''}`.trim() || '' }),
            page: 0,
            header: t(this._getSessionLanguage(session), 'bookSoonest.selectPhysio', { name: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) || '' })
      });
          return reply;
        }
        // else back to types
        const { list, map } = await buildTypeCatalogue(); // also rebuilds data.funnel_catalogue
        data.appointment_type_list = list; data.appt_type_name_to_ids_norm = map; data.appt_type_page = 0;
        delete data.selected_appt_type; delete data.practitioner_list; delete data.selected_physio; delete data.clinic_list; delete data.selected_clinic;
        delete data.funnel_step; delete data.funnel_sel;
        data.selection_step = 'choose_type';
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
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

    // Paging in choose_type — the insurer sub-step pages itself via the shared
    // _stepTypeInsurer's own data.insurer_page, so this generic appt_type_page
    // interception must not swallow p/m/next while the funnel is at that stage.
    if (data.selection_step === 'choose_type' && data.funnel_step !== 'insurer' && /^p(rev)?$/i.test(text)) {
      data.appt_type_page = Math.max(0, (data.appt_type_page || 0) - 1);
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
    }
    if (data.selection_step === 'choose_type' && data.funnel_step !== 'insurer' && (text === 'm' || text === 'more' || text === 'next')) {
      data.appt_type_page = (data.appt_type_page || 0) + 1;
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
      return await this.handleBookSoonest(session, '');
    }

    // ===== confirm_type_suggestion (Phase 2 NLU slot suggestion): "Did you
    // mean X?" for a medium-confidence appointment-type slot match. Never
    // auto-applied and never silently discarded — the user decides. Declining,
    // an unrecognized reply, or reaching this step with no live suggestion
    // (e.g. via Back after it was already resolved) all converge on the same
    // unmodified choose_type funnel — no duplicated rendering logic. =====
    if (data.selection_step === 'confirm_type_suggestion') {
      if (data.suggested_appt_type && text === 'confirm_type') {
        data.selected_appt_type = data.suggested_appt_type;
        delete data.suggested_appt_type;
        data.selection_step = 'choose_type';
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }
      if (data.suggested_appt_type && text === '') {
        return buttons(`Did you mean *${data.suggested_appt_type.name}*?`, [
          { id: 'confirm_type', title: 'Yes' },
          { id: 'change_type', title: 'Choose from list' },
        ]);
      }
      delete data.suggested_appt_type;
      data.selection_step = 'choose_type';
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
      return await this.handleBookSoonest(session, '');
    }

    // ===== choose_type — funnel =====
    if (data.selection_step === 'choose_type') {
      if (!Array.isArray(data.funnel_catalogue)) {
        const { list, map } = await buildTypeCatalogue();
        data.appointment_type_list = list; data.appt_type_name_to_ids_norm = map; data.appt_type_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
      }

      if (!(data.funnel_catalogue || []).length) {
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_SOONEST, {
          context: 'soonest',
          confirmedMessage: t(this._getSessionLanguage(session), 'bookSoonest.noApptTypesAvailable'),
        });
      }

      // Phase 2: consume a pending NLU appointment-type slot exactly once, now
      // that funnel_catalogue/appointment_type_list exist to match it against.
      // Same discipline as handleBookSpecificClinic: the raw LLM value only
      // picks which existing catalogue entry to apply, never bypasses it —
      // matched via appointment_type_list's norm_name, then mapped to the
      // funnel_catalogue entry sharing that id.
      const pendingSlot = data.pending_nlu_slots && data.pending_nlu_slots.appointmentType;
      if (data.pending_nlu_slots) delete data.pending_nlu_slots.appointmentType;
      if (pendingSlot && typeof pendingSlot.value === 'string' && !data.selected_appt_type) {
        const slotNorm = normName(pendingSlot.value);
        const matchedListEntry = (data.appointment_type_list || []).find(t => t.norm_name === slotNorm)
          || (data.appointment_type_list || []).find(t => t.norm_name.includes(slotNorm) || slotNorm.includes(t.norm_name));
        const matchedCatalogueEntry = matchedListEntry
          ? (data.funnel_catalogue || []).find(f => String(f.id) === String(matchedListEntry.id))
          : null;
        if (matchedCatalogueEntry && NluRouter.isSlotAutofillable(pendingSlot)) {
          data.selected_appt_type = matchedCatalogueEntry;
          navPush(data, 'choose_type', { had_multiple_options: (data.funnel_catalogue || []).length > 1, auto: true });
          await sync({ conversation_state: this.STATES.BOOK_SOONEST });
          return await this.handleBookSoonest(session, '');
        }
        if (matchedCatalogueEntry && NluRouter.isSlotSuggestable(pendingSlot)) {
          data.suggested_appt_type = matchedCatalogueEntry;
          data.selection_step = 'confirm_type_suggestion';
          navPush(data, 'confirm_type_suggestion', { had_multiple_options: true });
          await sync({ conversation_state: this.STATES.BOOK_SOONEST });
          return buttons(`Did you mean *${matchedCatalogueEntry.name}*?`, [
            { id: 'confirm_type', title: 'Yes' },
            { id: 'change_type', title: 'Choose from list' },
          ]);
        }
      }

      if (!data.selected_appt_type) {
        const funnelResult = await this._stepApptFunnel(session, data, text);
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        if (funnelResult.reply) return funnelResult.reply;
        if (!funnelResult.resolved) {
          return await this._noSlotsRetry(session, data, this.STATES.BOOK_SOONEST, {
            context: 'soonest',
            confirmedMessage: t(this._getSessionLanguage(session), 'bookSoonest.noApptTypesAvailable'),
          });
        }
        data.selected_appt_type = funnelResult.resolved;
        await sync();
      }

      // Build AVAILABLE practitioners for this type — use the real merged
      // Cliniko names (norm_names) when present, never the possibly-
      // overridden display name (e.g. "New Patient" for SG's tier-merged
      // self-pay Physiotherapy), which wouldn't match any real slot's
      // appointment_type_name.
      const typeNorms = (data.selected_appt_type.norm_names && data.selected_appt_type.norm_names.length)
        ? new Set(data.selected_appt_type.norm_names)
        : new Set([data.selected_appt_type.norm_name || normName(data.selected_appt_type.name)]);
      const practitioners = await buildAvailablePhysiosForTypeName(typeNorms);

      data.practitioner_list = sortPractitioners(practitioners); data.practitioner_page = 0;
      data.selection_step = 'choose_physio';
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });

      if (practitioners.length === 0) {
        // No physios have slots for this type (no navPush so back goes to booking menu).
        // retry_step: 'choose_type' — selection_step was already advanced to 'choose_physio'
        // above, but Try Again should re-enter choose_type with selected_appt_type intact,
        // re-running the physio search instead of restarting the funnel.
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_SOONEST, {
          context: 'soonest',
          retryStep: 'choose_type',
          result: practitioners,
          confirmedMessage: t(this._getSessionLanguage(session), 'bookSoonest.noPhysiosForType', { name: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) })
            + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
        });
      }

      navPush(data, 'choose_physio', { had_multiple_options: practitioners.length > 1, auto: practitioners.length === 1 });
      await sync();

      if (practitioners.length > 1) {
        // Route through the choose_physio block below instead of rendering the
        // list here directly — that block runs the gender-preference funnel
        // (_stepPhysioFunnel) before it renders anything. Rendering the raw
        // list here first meant the funnel's first-ever run got triggered
        // later by an unrelated "next"/pagination reply, popping up a gender
        // prompt mid-pagination with no context (found live 2026-09-22).
        return await this.handleBookSoonest(session, '');
      }

      // Auto-advance to clinic when only one physio
      data.selected_physio = practitioners[0];
      data.selection_step = 'choose_clinic';
      await sync();
      return await this.handleBookSoonest(session, '');
    }

    // Paging in choose_physio
    if (data.selection_step === 'choose_physio' && /^p(rev)?$/i.test(text)) {
      data.practitioner_page = Math.max(0, (data.practitioner_page || 0) - 1);
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
    }
    if (data.selection_step === 'choose_physio' && (text === 'm' || text === 'more' || text === 'next')) {
      data.practitioner_page = (data.practitioner_page || 0) + 1;
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
      return await this.handleBookSoonest(session, '');
    }

    // ===== choose_physio =====
    if (data.selection_step === 'choose_physio') {
      const practitionerList = data.practitioner_list || [];
      const page = data.practitioner_page || 0;

      // Physio-tier funnel (SG-style: standard vs senior physio, config-gated,
      // asked before gender) — a no-op wherever the region has no physioTiers
      // capability or this type wasn't tier-merged into >1 real Cliniko name.
      // Only recurse with a cleared text when it actually displayed a prompt;
      // an instant no-op must fall through to the gender gate below using the
      // SAME text, or a real numeric physio selection sent on the very same
      // turn this gate resolves would be silently discarded (confirmed as a
      // real bug via a regression test: seeding physio_funnel_step done but
      // physio_tier_step unset, then sending "1", used to just re-render the
      // list instead of selecting row 1).
      if (data.physio_tier_step !== 'done') {
        const fr = await this._stepPhysioTierFunnel(session, data, text);
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        if (fr.reply) return fr.reply;
        if (!fr.skipped) return await this.handleBookSoonest(session, '');
      }

      // Gender-only preference funnel (no category step — type already chosen)
      if (data.physio_funnel_step !== 'done') {
        const fr = await this._stepPhysioFunnel(session, data, text, { skipCategory: true });
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        if (fr.reply) return fr.reply;
        return await this.handleBookSoonest(session, '');
      }

      const effectiveList = this._applyPhysioTierFilter(
        this._applyPhysioFilter(practitionerList, data.physio_funnel_sel, data.physio_categories),
        data.physio_tier_sel,
        data.physio_tier_groups
      );

      if (/^\d+$/.test(text)) {
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const idx = pageStart + localNum - 1;
        if (localNum < 1 || localNum > Math.min(pageSize, effectiveList.length - pageStart) || !effectiveList[idx]) return t(this._getSessionLanguage(session), 'bookSoonest.invalidPhysioSelection');
        data.selected_physio = effectiveList[idx];
        data.selection_step = 'choose_clinic';
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });
        return await this.handleBookSoonest(session, '');
      }

      const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: effectiveList,
        rowFn: (p) => ({ title: getPractitionerDisplayName(p, this._getSessionLanguage(session), this.logger) || `${p.first_name||''} ${p.last_name||''}`.trim() || '' }),
        page,
        header: t(this._getSessionLanguage(session), 'bookSoonest.selectPhysio', { name: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) || '' })
      });
      return reply;
    }

    // Paging in choose_clinic
    if (data.selection_step === 'choose_clinic' && /^p(rev)?$/i.test(text)) {
      data.clinic_page = Math.max(0, (data.clinic_page || 0) - 1);
      await sync({ conversation_state: this.STATES.BOOK_SOONEST });
    }
    if (data.selection_step === 'choose_clinic' && (text === 'm' || text === 'more' || text === 'next')) {
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
        const slotResults0 = await bulkAll(allClinics, c => this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: String(c.id),
          practitioner_id: String(data.selected_physio.id),
          from,
          to
        }));
        const withSlots = allClinics.filter((c, i) =>
          (slotResults0[i] || []).some(s => normName(s.appointment_type_name) === typeNorm)
        );
        data.clinic_list = withSlots; data.clinic_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SOONEST });

        if (withSlots.length === 0) {
          // Do NOT silently rebuild the physio list / reset the funnel here —
          // a zero-clinic result from this prefilter can come from a genuinely
          // fully-booked physio OR from a transient Cliniko fetch failure
          // (e.g. a 429 under concurrent load) that getAvailableSlotsByBusinessAndDate
          // swallows into an empty array indistinguishable from "confirmed
          // zero" (flagged via slotResults0[i]._partial when that happened).
          // Treating it as confirmed and cascading through a physio rebuild
          // and funnel reset discards the user's already-resolved selections
          // with no explanation. retry_step re-runs this exact prefilter —
          // with selected_physio/selected_appt_type/funnel state untouched —
          // instead of restarting the funnel.
          delete data.clinic_list; delete data.clinic_page;
          return await this._noSlotsRetry(session, data, this.STATES.BOOK_SOONEST, {
            context: 'soonest',
            retryStep: 'choose_clinic',
            result: slotResults0,
            confirmedMessage: t(this._getSessionLanguage(session), 'bookSoonest.noSlotsForTypeAndPhysio', { type: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger), physio: getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger) })
              + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
          });
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
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const idx = pageStart + localNum - 1;
        if (localNum < 1 || localNum > Math.min(pageSize, clinics.length - pageStart) || !clinics[idx]) return t(this._getSessionLanguage(session), 'bookSoonest.invalidClinicSelection');
        data.selected_clinic = clinics[idx];
        await sync();
      }

      if (!data.selected_clinic) {
        const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
          items: clinics,
          rowFn: (c) => ({ title: String(c.business_name) }),
          page,
          header: t(this._getSessionLanguage(session), 'bookSoonest.selectClinic', { name: getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger) })
      });
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

      // Match by appointment_type_id when the funnel resolved specific ids (insurer-aware),
      // falling back to name match otherwise — see Phase 0c: name-only matching let a slot
      // under a different insurer/self-pay id silently win the same-time dedup.
      const resolvedIds = data.selected_appt_type.ids;
      const targetNorm = normName(data.selected_appt_type.name);
      const filtered = deduplicateSlots((raw || []).filter(s =>
        resolvedIds && resolvedIds.length
          ? resolvedIds.includes(String(s.appointment_type_id))
          : normName(s.appointment_type_name) === targetNorm
      ));

      if (!filtered.length) {
        // Extremely unlikely since clinics are prefiltered, but handle defensively.
        // retry_step: Try Again re-enters choose_clinic with selected_clinic intact,
        // re-running the slot fetch instead of restarting the funnel. Pass the raw
        // (unfiltered) result — filtered is a new array from .filter() and doesn't
        // carry the _partial marker through.
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_SOONEST, {
          context: 'soonest',
          retryStep: 'choose_clinic',
          result: raw,
          confirmedMessage: t(this._getSessionLanguage(session), 'bookSoonest.noSlotsForType', { name: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) })
            + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
        });
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

      const header = `${getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger)} • ${getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger)} • ${getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger)}`;
      return this._buildSlotList(filtered, 0, header, this._regionTz(session), this._getSessionLanguage(session));
    }

    // Fallback → show types again
    const apptTypes = data.appointment_type_list || [];
    const apptTypePage = data.appt_type_page || 0;
    const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
      items: apptTypes,
      rowFn: (a) => ({ title: String(translateApptTypeName(a.name, this._getSessionLanguage(session), this.logger)) }),
      page: apptTypePage,
      header: t(this._getSessionLanguage(session), 'bookSoonest.chooseApptType')
    });
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
    if (data.no_slots_prompt?.context === 'date_inner' && (text === '1' || text === '0' || text === 'back')) {
      delete data.no_slots_prompt;
      navBack(data);
      delete data.selected_physio;
      delete data.clinic_list;
      delete data.clinic_page;
      delete data.selected_clinic;
      data.selection_step = 'choose_physio';
      data.suppress_auto_advance = true;
      session.data = JSON.stringify(data);
      session.conversation_state = this.STATES.BOOK_SPECIFIC_DATE;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_DATE, data: session.data });
      return await this.handleBookSpecificDate(session, '');
    }
    if (data.no_slots_prompt) {
      const ret = await this._handleNoSlotsDecision(session, data, this.STATES.BOOK_SPECIFIC_DATE, this.handleBookSpecificDate, raw);
      if (ret) return ret;
    }

    // ----- global back/menu -----
    // 'back' (interactive list id) behaves like '0' (contextual step-back), not like 'menu' (full exit).
    if (text === 'menu') {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }
    if ((text === '0' || text === 'back') && data.selection_step && data.selection_step !== 'choose_date') {
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
    // Phase 6: mid-flow date correction. Only once a date is already
    // selected (past choose_date) and only for free text that isn't a
    // control token for the current step (numeric pick, m/more/next,
    // p/prev — 0/back/menu are already handled above). Reuses the same
    // pending_nlu_slots consume path choose_date already has for Phase 5's
    // autofill/suggest/fallthrough — a correction just re-stashes the new
    // date and jumps back there, never introduces a new confirmation UI.
    // =====================================================================
    const MIDFLOW_CORRECTION_STEPS = ['choose_type', 'choose_physio', 'choose_clinic'];
    const isStepControlToken = (t) => t === '' || /^\d+$/.test(t) || /^m(ore)?$|^next$/i.test(t) || /^p(rev)?$/i.test(t);
    // Shared with the Phase 9 free-text type-selection block further below —
    // 'choose_type' is a step both this date-correction check and that block
    // run at, so a single classifyIntent call here is reused there instead of
    // firing twice for the same message.
    let sharedNluResult = null;
    if (data.selected_date && MIDFLOW_CORRECTION_STEPS.includes(data.selection_step) && !isStepControlToken(text)) {
      const result = await NluRouter.classifyIntent(raw, this.STATES.BOOK_SPECIFIC_DATE, { existingSlots: { date: data.selected_date } });
      sharedNluResult = result;
      const restartReply = await this._maybeHandleMidflowRestart(session, result, this.STATES.BOOK_SPECIFIC_DATE);
      if (restartReply) return restartReply;
      const dateSlot = result.slots && result.slots.date;
      if (NluRouter.MIDFLOW_CORRECTION_INTENTS.includes(result.intent) && dateSlot && dateSlot.value && dateSlot.value !== data.selected_date
          && (NluRouter.isSlotAutofillable(dateSlot) || NluRouter.isSlotSuggestable(dateSlot))) {
        this.logger.analyticsEvent({ event: 'nlu_midflow_correction', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: this.STATES.BOOK_SPECIFIC_DATE, slot: 'date', confidence: dateSlot.confidence });
        for (const f of CLEAR_FIELDS_BY_STEP.choose_date) delete data[f];
        data.navigation_chain = [];
        data.selection_step = 'choose_date';
        data.date_page = 0;
        data.pending_nlu_slots = { ...(data.pending_nlu_slots || {}), date: dateSlot };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        return await this.handleBookSpecificDate(session, '');
      }
    }

    // =====================================================================
    // Phase 7 gap fix: mid-flow physio correction. Phase 7 routes every
    // combined physio+date NLU message into this handler (it's the only
    // funnel with steps for both slots — see the Phase 7 root-asymmetry
    // note), but this handler only ever had a date-correction block above.
    // A later "actually can I see someone else" here silently did nothing.
    // Mirrors handleBookSpecificPhysio's own physio-correction block, but
    // only fires at 'choose_clinic' — the one step after choose_physio in
    // *this* funnel's order (date -> type -> insurer -> physio -> clinic),
    // which puts appointment-type selection upstream of physio here, unlike
    // handleBookSpecificPhysio's own funnel. So unlike that block's clear
    // set, this must NOT clear selected_appt_type/appointment_type_list —
    // the type was already confirmed before physio in this funnel, and
    // choose_physio's own practitioner-list build filters by that type.
    // =====================================================================
    const DATE_FUNNEL_PHYSIO_CORRECTION_STEPS = ['choose_clinic'];
    if (data.selected_physio && DATE_FUNNEL_PHYSIO_CORRECTION_STEPS.includes(data.selection_step) && !isStepControlToken(text)) {
      const currentPhysioName = normName(getPractitionerDisplayName ? getPractitionerDisplayName(data.selected_physio) : (data.selected_physio.display_name || data.selected_physio.name || ''));
      const result = await NluRouter.classifyIntent(raw, this.STATES.BOOK_SPECIFIC_DATE, { existingSlots: { physio: currentPhysioName } });
      const restartReply = await this._maybeHandleMidflowRestart(session, result, this.STATES.BOOK_SPECIFIC_DATE);
      if (restartReply) return restartReply;
      const physioSlot = result.slots && result.slots.physio;
      if (NluRouter.MIDFLOW_CORRECTION_INTENTS.includes(result.intent) && physioSlot && physioSlot.value && normName(physioSlot.value) !== currentPhysioName
          && (NluRouter.isSlotAutofillable(physioSlot) || NluRouter.isSlotSuggestable(physioSlot))) {
        this.logger.analyticsEvent({ event: 'nlu_midflow_correction', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: this.STATES.BOOK_SPECIFIC_DATE, slot: 'physio', confidence: physioSlot.confidence });
        delete data.selected_physio;
        delete data.practitioner_list;
        delete data.practitioner_page;
        delete data.clinic_list;
        delete data.clinic_page;
        delete data.selected_clinic;
        data.navigation_chain = [];
        data.selection_step = 'choose_physio';
        data.pending_nlu_slots = { ...(data.pending_nlu_slots || {}), physio: physioSlot };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        return await this.handleBookSpecificDate(session, '');
      }
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

      // Phase 5: consume a pending NLU date slot exactly once, matching only
      // against the real candidate-date list already built above — same
      // discipline as Phase 2's appointment-type slot, the raw LLM value is
      // never trusted directly, only used to pick an existing candidate.
      if (data.pending_nlu_slots && data.pending_nlu_slots.date) {
        const pendingSlot = data.pending_nlu_slots.date;
        delete data.pending_nlu_slots.date;
        const dateMatch = candidates.find(d => ymdLocal(d) === pendingSlot.value);
        if (dateMatch && NluRouter.isSlotAutofillable(pendingSlot)) {
          data.selected_date = ymdLocal(dateMatch);
          data.selection_step = 'choose_type';
          if (typeof navPush === 'function') navPush(data, 'choose_type', { had_multiple_options: true, auto: true });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          return await this.handleBookSpecificDate(session, '');
        }
        if (dateMatch && NluRouter.isSlotSuggestable(pendingSlot)) {
          data.suggested_date = ymdLocal(dateMatch);
          data.selection_step = 'confirm_date_suggestion';
          if (typeof navPush === 'function') navPush(data, 'confirm_date_suggestion', { had_multiple_options: true });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          return buttons(`Did you mean *${dateMatch.toLocaleDateString()}*?`, [
            { id: 'confirm_date', title: 'Yes' },
            { id: 'change_date', title: 'Choose from list' },
          ]);
        }
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

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
            const isSG = this._getSessionRegion(session) === 'SG';
            const servicesSplit = this._servicesWithPatientTypeSplit(allTypes);
            const tierBaseNames = this._tierBaseNamesWithVariants(allTypes);
            const buckets = new Map();
            for (const t of allTypes || []) {
              if (!t || !t.name) continue;
              if (/UWC/i.test(t.name) || /online\s*booking/i.test(t.name)) continue;
              const { bucketKey, displayName, service, duration } = this._bucketApptType(t, normName, isSG, servicesSplit, hasCapability(this._getSessionRegion(session), 'physioTiers'), tierBaseNames);
              const { insurer } = parseApptCategory(t.category);
              if (!buckets.has(bucketKey)) buckets.set(bucketKey, { displayName, entries: [], service, duration });
              buckets.get(bucketKey).entries.push({ id: String(t.id), insurer: insurer || null });
            }
            let typeList = Array.from(buckets.values())
              .map(v => ({ name: v.displayName, real_name: v.displayName, ids: v.entries.map(e => e.id), norm: normName(v.displayName), entries: v.entries, service: v.service, duration: v.duration }));
            if (isSG) typeList = this._disambiguateSGTypeNames(typeList);
            data.appointment_type_list = sortAppointmentTypes(typeList);
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          }

          if ((data.appointment_type_list || []).length === 0) {
            return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_DATE, {
              context: 'date',
              confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificDate.noApptTypesForDate'),
            });
          }

          const headerDate = formatDateOnly(new Date(`${data.selected_date}T00:00:00Z`));
          const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
            items: data.appointment_type_list || [],
            rowFn: (a) => ({ title: String(translateApptTypeName(a.name, this._getSessionLanguage(session), this.logger)) }),
            page: 0,
            header: t(this._getSessionLanguage(session), 'bookSpecificDate.selectVisitType', { date: headerDate })
      });
          return reply;
        }
      }

      // page back — 'back' interactive id behaves like '0' in this context
      if (text === '0' || text === 'back') {
        if (page > 0) {
          data.date_page = page - 1;
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        } else {
          await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
          return await this.goToInteractiveMenu(session);
        }
      }

      // page forward
      if (text === 'm' || text === 'more' || text === 'next') {
        if (page < (MAX_DATE_PAGES - 1)) {
          data.date_page = page + 1;
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        }
      }

      // render date page
      const cur = Math.max(0, Math.min(Number(data.date_page) || 0, MAX_DATE_PAGES - 1));
      return buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        header: t(this._getSessionLanguage(session), 'bookSpecificDate.pickDatePage', { current: cur + 1, total: MAX_DATE_PAGES }),
        items: candidates,
        rowFn: (dt) => ({ title: formatDateOnly(dt) }),
        page: cur,
        fixedPageSize: MAX_DATE_ITEMS
      });
    }

    // ===== confirm_date_suggestion (Phase 5 NLU slot suggestion): "Did you
    // mean X?" for a medium-confidence date slot match. Same pattern as
    // confirm_type_suggestion — never auto-applied, decline/unrecognized
    // reply converges on the normal choose_date list. =====
    if (data.selection_step === 'confirm_date_suggestion') {
      if (data.suggested_date && text === 'confirm_date') {
        data.selected_date = data.suggested_date;
        delete data.suggested_date;
        data.selection_step = 'choose_type';
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        return await this.handleBookSpecificDate(session, '');
      }
      if (data.suggested_date && text === '') {
        return buttons(`Did you mean *${new Date(`${data.suggested_date}T00:00:00Z`).toLocaleDateString()}*?`, [
          { id: 'confirm_date', title: 'Yes' },
          { id: 'change_date', title: 'Choose from list' },
        ]);
      }
      delete data.suggested_date;
      data.selection_step = 'choose_date';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      return await this.handleBookSpecificDate(session, '');
    }

    // =====================================================================
    // choose_type
    // =====================================================================
    if (data.selection_step === 'choose_type') {
      if (!Array.isArray(data.appointment_type_list)) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const allTypes = await getAllAppointmentTypesForAllPractitioners(this.clinikoAPI, groups);
        const isSG = this._getSessionRegion(session) === 'SG';
        const servicesSplit = this._servicesWithPatientTypeSplit(allTypes);
        const tierBaseNames = this._tierBaseNamesWithVariants(allTypes);
        const buckets = new Map();
        for (const t of allTypes || []) {
          if (!t || !t.name) continue;
          if (/UWC/i.test(t.name) || /online\s*booking/i.test(t.name)) continue;
          const { bucketKey, displayName, service, duration } = this._bucketApptType(t, normName, isSG, servicesSplit, hasCapability(this._getSessionRegion(session), 'physioTiers'), tierBaseNames);
          const { insurer } = parseApptCategory(t.category);
          if (!buckets.has(bucketKey)) buckets.set(bucketKey, { displayName, entries: [], service, duration });
          buckets.get(bucketKey).entries.push({ id: String(t.id), insurer: insurer || null });
        }
        let typeList = Array.from(buckets.values())
          .map(v => ({ name: v.displayName, ids: v.entries.map(e => e.id), norm: normName(v.displayName), entries: v.entries, service: v.service, duration: v.duration }));
        if (isSG) typeList = this._disambiguateSGTypeNames(typeList);
        data.appointment_type_list = sortAppointmentTypes(typeList);
        data.appt_type_page = 0;

        // Phase 9: consume a pending NLU appointment-type slot exactly once,
        // now that the real type list exists to match it against — same
        // discipline as handleBookSpecificClinic's own choose_type consume
        // block. This funnel's list uses `norm` (not `norm_name`) per its
        // own bucket-building above.
        const pendingSlot = data.pending_nlu_slots && data.pending_nlu_slots.appointmentType;
        if (data.pending_nlu_slots) delete data.pending_nlu_slots.appointmentType;
        if (pendingSlot && typeof pendingSlot.value === 'string') {
          const slotNorm = normName(pendingSlot.value);
          const matched = data.appointment_type_list.find(t => t.norm === slotNorm)
            || data.appointment_type_list.find(t => t.norm.includes(slotNorm) || slotNorm.includes(t.norm));
          if (matched && NluRouter.isSlotAutofillable(pendingSlot)) {
            this._applyTypeSelection(data, matched);
            navPush(data, 'choose_type', { had_multiple_options: data.appointment_type_list.length > 1, auto: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
            return await this.handleBookSpecificDate(session, '');
          }
          if (matched && NluRouter.isSlotSuggestable(pendingSlot)) {
            data.suggested_appt_type = { ...matched };
            data.selection_step = 'confirm_type_suggestion';
            navPush(data, 'confirm_type_suggestion', { had_multiple_options: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
            return buttons(`Did you mean *${matched.name}*?`, [
              { id: 'confirm_type', title: 'Yes' },
              { id: 'change_type', title: 'Choose from list' },
            ]);
          }
        }

        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

      if ((data.appointment_type_list || []).length === 0) {
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_DATE, {
          context: 'date',
          confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificDate.noApptTypesForDate'),
        });
      }

      // Phase 9: free-text answer to THIS rendering of the type list (not just
      // an entry-message pre-fill, which only runs once when the list is first
      // built above). A reply here isn't a control token, so classify it fresh
      // against the now-real appointment_type_list — same autofill/suggest
      // discipline as the entry-message consume block just above. Reuses
      // sharedNluResult from the date-correction check above when that already
      // ran this turn (same step, same text) instead of a second live call.
      if (!data.selected_appt_type && !isStepControlToken(text)) {
        const nlu = sharedNluResult || await NluRouter.classifyIntent(text, this.STATES.BOOK_SPECIFIC_DATE, {});
        const typeSlot = nlu.slots && nlu.slots.appointmentType;
        if (typeSlot && typeof typeSlot.value === 'string') {
          const slotNorm = normName(typeSlot.value);
          const matched = data.appointment_type_list.find(x => x.norm === slotNorm)
            || data.appointment_type_list.find(x => x.norm.includes(slotNorm) || slotNorm.includes(x.norm));
          if (matched && NluRouter.isSlotAutofillable(typeSlot)) {
            this._applyTypeSelection(data, matched);
            navPush(data, 'choose_type', { had_multiple_options: data.appointment_type_list.length > 1, auto: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
            return await this.handleBookSpecificDate(session, '');
          }
          if (matched && NluRouter.isSlotSuggestable(typeSlot)) {
            data.suggested_appt_type = { ...matched };
            data.selection_step = 'confirm_type_suggestion';
            navPush(data, 'confirm_type_suggestion', { had_multiple_options: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
            return buttons(`Did you mean *${matched.name}*?`, [
              { id: 'confirm_type', title: 'Yes' },
              { id: 'change_type', title: 'Choose from list' },
            ]);
          }
        }
      }

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.appt_type_page = (Number(data.appt_type_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }
if (/^p(rev)?$/i.test(text)) {
  data.appt_type_page = Math.max(0, (Number(data.appt_type_page) || 0) - 1);
  await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
}

      const numOnly = text.replace(/[^\d]/g, '');
      if (numOnly) {
        const page = data.appt_type_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(numOnly, 10);
        const list = data.appointment_type_list || [];
        const idx = pageStart + localNum - 1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, list.length - pageStart) && list[idx]) {
          this._applyTypeSelection(data, list[idx]);
          if (typeof navPush === 'function') navPush(data, 'choose_physio', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          return await this.handleBookSpecificDate(session, '');
        }
      }

      const headerDate = formatDateOnly(new Date(`${data.selected_date}T00:00:00Z`));
      const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: data.appointment_type_list || [],
        rowFn: (a) => ({ title: String(translateApptTypeName(a.name, this._getSessionLanguage(session), this.logger)) }),
        page: data.appt_type_page || 0,
        header: t(this._getSessionLanguage(session), 'bookSpecificDate.selectVisitType', { date: headerDate })
      });
      return reply;
    }

    // ===== choose_type_insurer: disambiguate insurer for a same-named type. Not a
    // navPush frame — Back returns to choose_type, same as the History flow. =====
    if (data.selection_step === 'choose_type_insurer') {
      const stepResult = this._stepTypeInsurer(session, data, text);
      if (stepResult.reply) {
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        return stepResult.reply;
      }
      data.selection_step = 'choose_physio';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      return await this.handleBookSpecificDate(session, '');
    }

    // ===== confirm_type_suggestion (Phase 9 NLU slot suggestion): "Did you
    // mean X?" for a medium-confidence appointment-type slot match. Never
    // auto-applied and never silently discarded — the user decides. Declining,
    // an unrecognized reply, or reaching this step with no live suggestion
    // all converge on the same unmodified choose_type list — no duplicated
    // rendering logic. Mirrors handleBookSpecificClinic's own step. =====
    if (data.selection_step === 'confirm_type_suggestion') {
      if (data.suggested_appt_type && text === 'confirm_type') {
        this._applyTypeSelection(data, data.suggested_appt_type);
        delete data.suggested_appt_type;
        data.selection_step = 'choose_type';
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        return await this.handleBookSpecificDate(session, '');
      }
      if (data.suggested_appt_type && text === '') {
        return buttons(`Did you mean *${data.suggested_appt_type.name}*?`, [
          { id: 'confirm_type', title: 'Yes' },
          { id: 'change_type', title: 'Choose from list' },
        ]);
      }
      delete data.suggested_appt_type;
      data.selection_step = 'choose_type';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      return await this.handleBookSpecificDate(session, '');
    }

    // ===== confirm_physio_suggestion (Phase 7 NLU slot suggestion, combined
    // date+physio message): "Did you mean X?" for a medium-confidence
    // physio-name slot match reached via handleBookSpecificDate's funnel.
    // Same pattern as handleBookSpecificPhysio's own confirm_physio_suggestion
    // — never auto-applied, decline/unrecognized reply converges on the
    // normal choose_physio list. =====
    if (data.selection_step === 'confirm_physio_suggestion') {
      if (data.suggested_physio && text === 'confirm_physio') {
        data.selected_physio = data.suggested_physio;
        delete data.suggested_physio;
        data.selection_step = 'choose_clinic';
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        return await this.handleBookSpecificDate(session, '');
      }
      if (data.suggested_physio && text === '') {
        return buttons(`Did you mean *${getPractitionerDisplayName ? getPractitionerDisplayName(data.suggested_physio) : data.suggested_physio.name}*?`, [
          { id: 'confirm_physio', title: 'Yes' },
          { id: 'change_physio', title: 'Choose from list' },
        ]);
      }
      delete data.suggested_physio;
      data.selection_step = 'choose_physio';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      return await this.handleBookSpecificDate(session, '');
    }

    // =====================================================================
    // choose_physio — physios who offer that type
    // =====================================================================
    if (data.selection_step === 'choose_physio') {
      if (!Array.isArray(data.practitioner_list)) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        // Match by the bucket's real Cliniko type IDs, not by name text.
        // Two distinct Cliniko types can share a literal name (the SG
        // "Physiotherapist" Physiotherapy-vs-Sports-Massage collision this
        // guards against) — name-only matching (getPractitionersForTypeName)
        // would silently reunite them even after the SG bucketing/
        // disambiguation fix separated them in the menu. ids is always set
        // by this handler's own bucket builders above; the name-based
        // lookup is only a defensive fallback for an unexpected shape.
        const typeIds = data.selected_appt_type?.ids;
        const practitioners = (Array.isArray(typeIds) && typeIds.length)
          ? await getPractitionersForTypeIds(groups || [], this.clinikoAPI, typeIds)
          : await getPractitionersForTypeName(groups || [], this.clinikoAPI, data.selected_appt_type?.real_name || data.selected_appt_type?.name || '');
        data.practitioner_list = sortPractitioners((practitioners || []).map(p => ({ id: String(p.id), ...p })));
        data.practitioner_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });

        if (data.practitioner_list.length === 0) {
          // groups came back empty — could be a genuine "no practitioners
          // offer this type" or a degraded getPractitionersByClinic() fetch
          // (e.g. a 429). Delete practitioner_list so retry re-fetches
          // instead of finding the same empty array.
          delete data.practitioner_list;
          return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_DATE, {
            context: 'date_physio_list',
            result: groups,
            confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificDate.noPractitionersForType', { name: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) || 'this visit type' }),
          });
        }
      }

      // Phase 7: consume a pending NLU physio slot (carried alongside a
      // date slot from the same message) exactly once, now that the real
      // type-filtered practitioner list exists to match it against — same
      // discipline as handleBookSpecificPhysio's own choose_physio consume
      // block. Only autofills on a single unambiguous name match. Runs
      // before the physio-tier and gender-preference funnels: a message
      // that names a specific physio has already made both questions moot.
      if (data.pending_nlu_slots && data.pending_nlu_slots.physio) {
        const pendingSlot = data.pending_nlu_slots.physio;
        delete data.pending_nlu_slots.physio;
        if (typeof pendingSlot.value === 'string') {
          const slotNorm = normName(pendingSlot.value);
          const nameMatches = data.practitioner_list.filter(p => {
            const n = normName(getPractitionerDisplayName ? getPractitionerDisplayName(p) : (p.display_name || p.name || ''));
            return n === slotNorm || n.includes(slotNorm) || slotNorm.includes(n);
          });
          const physioMatch = nameMatches.length === 1 ? nameMatches[0] : null;
          if (physioMatch && NluRouter.isSlotAutofillable(pendingSlot)) {
            data.selected_physio = physioMatch;
            data.selection_step = 'choose_clinic';
            if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: data.practitioner_list.length > 1, auto: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
            return await this.handleBookSpecificDate(session, '');
          }
          if (physioMatch && NluRouter.isSlotSuggestable(pendingSlot)) {
            data.suggested_physio = physioMatch;
            data.selection_step = 'confirm_physio_suggestion';
            if (typeof navPush === 'function') navPush(data, 'confirm_physio_suggestion', { had_multiple_options: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
            return buttons(`Did you mean *${getPractitionerDisplayName ? getPractitionerDisplayName(physioMatch) : physioMatch.name}*?`, [
              { id: 'confirm_physio', title: 'Yes' },
              { id: 'change_physio', title: 'Choose from list' },
            ]);
          }
        }
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

      // Physio-tier funnel (config-gated; no-op unless the region has the
      // 'physioTiers' capability and this type spans >1 real Cliniko name).
      if (data.physio_tier_step !== 'done') {
        const fr = await this._stepPhysioTierFunnel(session, data, text);
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        if (fr.reply) return fr.reply;
        if (!fr.skipped) return await this.handleBookSpecificDate(session, '');
      }

      // Gender-only preference funnel (no category step — type already chosen)
      if (data.physio_funnel_step !== 'done') {
        const fr = await this._stepPhysioFunnel(session, data, text, { skipCategory: true });
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
        if (fr.reply) return fr.reply;
        return await this.handleBookSpecificDate(session, '');
      }

      const effectiveList = this._applyPhysioTierFilter(
        this._applyPhysioFilter(data.practitioner_list || [], data.physio_funnel_sel, data.physio_categories),
        data.physio_tier_sel,
        data.physio_tier_groups
      );

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.practitioner_page = (data.practitioner_page || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }
      if (/^p(rev)?$/i.test(text)) {
        data.practitioner_page = Math.max(0, (data.practitioner_page || 0) - 1);
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

      if (/^\d+$/.test(text)) {
        const page = data.practitioner_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const idx = pageStart + localNum - 1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, effectiveList.length - pageStart) && effectiveList[idx]) {
          data.selected_physio = effectiveList[idx];
          data.selection_step = 'choose_clinic';
          if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: effectiveList.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          return await this.handleBookSpecificDate(session, '');
        }
      }

      const headerDate = formatDateOnly(new Date(`${data.selected_date}T00:00:00Z`));
      const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: effectiveList,
        rowFn: (p) => ({ title: String(getPractitionerDisplayName ? getPractitionerDisplayName(p, this._getSessionLanguage(session), this.logger) : (p.display_name||p.name)) }),
        page: data.practitioner_page || 0,
        header: t(this._getSessionLanguage(session), 'bookSpecificDate.choosePhysioForDate', { type: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) || 'visit', date: headerDate })
      });
      return reply;
    }

    // =====================================================================
    // choose_clinic — clinics where that physio works (exclude UWC),
    // pre-filtered to only those with slots on the selected date
    // =====================================================================
    if (data.selection_step === 'choose_clinic') {
      if (!Array.isArray(data.clinic_list)) {
        const physId = String(data.selected_physio?.id || data.selected_physio);
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const allClinics = [];
        for (const g of groups || []) {
          if (/UWC/i.test(g.clinic_name)) continue;
          if ((g.practitioners || []).some(p => `${p.id}` === physId))
            allClinics.push({ id: String(g.clinic_id), business_name: g.clinic_name });
        }
        const resolvedIds = data.selected_appt_type?.ids;
        const typeNorm = normName(data.selected_appt_type?.name || '');
        const { from, to } = normalizeDateWindow(data.selected_date, data.selected_date, 1);
        const slotResults1 = await bulkAll(allClinics, c => this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: c.id, practitioner_id: physId, from, to
        }));
        const withSlots = allClinics.filter((c, i) =>
          (slotResults1[i] || []).some(s => resolvedIds && resolvedIds.length
            ? resolvedIds.includes(String(s.appointment_type_id))
            : normName(s.appointment_type_name) === typeNorm)
        );
        data.clinic_list = withSlots;
        data.clinic_page = 0;

        if (withSlots.length === 0) {
          const noSlotsDate = formatDateOnly(new Date(`${data.selected_date}T00:00:00Z`));
          // context 'date_inner' is intercepted by the special-case handler at
          // the top of this function (before _handleNoSlotsDecision even runs),
          // which navigates to choose_physio and clears the stale selection —
          // retry_step is set for consistency but not read on that path.
          return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_DATE, {
            context: 'date_inner',
            retryStep: 'choose_physio',
            retryLabel: t(this._getSessionLanguage(session), 'bookSpecificDate.tryAnotherPhysio'),
            result: slotResults1,
            confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificDate.noSlotsForPhysioOnDate', { date: noSlotsDate, type: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) || 'this visit type', physio: getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger) })
              + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
          });
        }

        if (withSlots.length === 1) {
          if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: false, auto: true });
          data.selected_clinic = withSlots[0];
          data.selection_step = 'view_slots';
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          return await this.handleBookSpecificDate(session, '');
        }

        if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: true, auto: false });
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
      }

      if (/^\d+$/.test(text)) {
        const list = data.clinic_list || [];
        const page = data.clinic_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const idx = pageStart + localNum - 1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, list.length - pageStart) && list[idx]) {
          data.selected_clinic = list[idx];
          data.selection_step = 'view_slots';
          if (typeof navPush === 'function') navPush(data, 'view_slots', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_DATE });
          return await this.handleBookSpecificDate(session, '');
        }
      }

      const headerDate = formatDateOnly(new Date(`${data.selected_date}T00:00:00Z`));
      const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: data.clinic_list || [],
        rowFn: (c) => ({ title: String(getBusinessDisplayName ? getBusinessDisplayName(c, this._getSessionLanguage(session), this.logger) : c.business_name) }),
        page: data.clinic_page || 0,
        header: t(this._getSessionLanguage(session), 'bookSpecificDate.selectClinicForDate', { physio: getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger), date: headerDate })
      });
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

      const resolvedIds = data.selected_appt_type?.ids;
      const typeNorm = normName(data.selected_appt_type?.name || '');
      const slots = deduplicateSlots((raw || []).filter(s =>
        resolvedIds && resolvedIds.length
          ? resolvedIds.includes(String(s.appointment_type_id))
          : normName(s.appointment_type_name) === typeNorm
      ));
      if (!slots.length) {
        // retry_step defaults to 'view_slots' (the current step) — Try Again
        // re-runs this exact fetch with selected_clinic/selected_physio intact,
        // instead of the old behavior of silently bouncing back to choose_clinic
        // and discarding clinic_list before the user even presses anything.
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_DATE, {
          context: 'date',
          result: raw,
          confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificDate.noSlotsAtClinicForDate', { type: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger), clinic: getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger) || 'this clinic' })
            + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
        });
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

      const header = `${getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger)} • ${getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger)} • ${getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger)} • ${formatDateOnly(new Date(`${date}T00:00:00Z`))}`;
      return this._buildSlotList(slots, 0, header, this._regionTz(session), this._getSessionLanguage(session));
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
    if (data.no_slots_prompt?.context === 'physio_inner' && (text === '1' || text === '0' || text === 'back')) {
      delete data.no_slots_prompt;
      navBack(data);
      delete data.selected_appt_type;
      delete data.clinic_list;
      delete data.clinic_page;
      delete data.selected_clinic;
      delete data.appt_types_for_physio;
      data.selection_step = 'choose_type';
      data.suppress_auto_advance = true;
      session.data = JSON.stringify(data);
      session.conversation_state = this.STATES.BOOK_SPECIFIC_PHYSIO;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO, data: session.data });
      return await this.handleBookSpecificPhysio(session, '');
    }
    if (data.no_slots_prompt) {
      const ret = await this._handleNoSlotsDecision(session, data, this.STATES.BOOK_SPECIFIC_PHYSIO, this.handleBookSpecificPhysio, textRaw);
      if (ret) return ret;
    }

    // ---------- global back/menu ----------
    // 'back' (interactive list id) behaves like '0' (contextual step-back), not like 'menu' (full exit).
    if (text === 'menu') {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }
    if ((text === '0' || text === 'back') && data.selection_step) {
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
    // Phase 6: mid-flow physio correction. Same pattern as
    // handleBookSpecificDate's date correction — only once a physio is
    // already selected (past choose_physio) and only for free text that
    // isn't a control token for the current step. Reuses the same
    // pending_nlu_slots consume path choose_physio already has for Phase
    // 5's autofill/suggest/fallthrough.
    // =====================================================================
    const MIDFLOW_PHYSIO_CORRECTION_STEPS = ['choose_type', 'choose_type_insurer', 'choose_clinic'];
    const isStepControlToken = (t) => t === '' || /^\d+$/.test(t) || /^m(ore)?$|^next$/i.test(t) || /^p(rev)?$/i.test(t);
    // Shared with the Phase 9 free-text type-selection block further below —
    // 'choose_type' is a step both this physio-correction check and that
    // block run at, so a single classifyIntent call here is reused there
    // instead of firing twice for the same message.
    let sharedNluResult = null;
    if (data.selected_physio && MIDFLOW_PHYSIO_CORRECTION_STEPS.includes(data.selection_step) && !isStepControlToken(text)) {
      const currentPhysioName = normName(getPractitionerDisplayName ? getPractitionerDisplayName(data.selected_physio) : (data.selected_physio.display_name || data.selected_physio.name || ''));
      const result = await NluRouter.classifyIntent(textRaw, this.STATES.BOOK_SPECIFIC_PHYSIO, { existingSlots: { physio: currentPhysioName } });
      sharedNluResult = result;
      const restartReply = await this._maybeHandleMidflowRestart(session, result, this.STATES.BOOK_SPECIFIC_PHYSIO);
      if (restartReply) return restartReply;
      const physioSlot = result.slots && result.slots.physio;
      if (NluRouter.MIDFLOW_CORRECTION_INTENTS.includes(result.intent) && physioSlot && physioSlot.value && normName(physioSlot.value) !== currentPhysioName
          && (NluRouter.isSlotAutofillable(physioSlot) || NluRouter.isSlotSuggestable(physioSlot))) {
        this.logger.analyticsEvent({ event: 'nlu_midflow_correction', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: this.STATES.BOOK_SPECIFIC_PHYSIO, slot: 'physio', confidence: physioSlot.confidence });
        for (const f of CLEAR_FIELDS_BY_STEP.choose_physio) delete data[f];
        delete data.appointment_type_list;
        data.navigation_chain = [];
        data.selection_step = 'choose_physio';
        data.practitioner_page = 0;
        data.pending_nlu_slots = { ...(data.pending_nlu_slots || {}), physio: physioSlot };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
        return await this.handleBookSpecificPhysio(session, '');
      }
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
        data.practitioner_list = sortPractitioners(allPhysios.filter(p => { if (seen.has(`${p.id}`)) return false; seen.add(`${p.id}`); return true; }));
        data.practitioner_page = 0;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });

        if (data.practitioner_list.length === 0) {
          // groups came back empty — could be a genuine "no practitioners
          // configured" or a degraded getPractitionersByClinic() fetch (e.g.
          // a 429). Without this check the list below silently renders with
          // only a "0. Back" row and no explanation. Delete practitioner_list
          // so retry re-fetches instead of finding the same empty array and
          // skipping straight back to this same dead end.
          delete data.practitioner_list;
          return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_PHYSIO, {
            context: 'physio_list',
            result: groups,
            confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificPhysio.noPractitionersAvailable'),
          });
        }
      }

      // Phase 5: consume a pending NLU physio slot exactly once, now that the
      // real practitioner list exists to match it against — same discipline
      // as Phase 2's appointment-type slot, the raw LLM name is never trusted
      // directly. Only autofills on a single unambiguous name match — a name
      // (unlike an appointment type) is short enough that multiple
      // substring hits are a real risk, so an ambiguous match falls through
      // to the normal list rather than guessing. Runs before the gender-
      // preference funnel: a message that names a specific physio has
      // already made the gender question moot.
      if (data.pending_nlu_slots && data.pending_nlu_slots.physio) {
        const pendingSlot = data.pending_nlu_slots.physio;
        delete data.pending_nlu_slots.physio;
        if (typeof pendingSlot.value === 'string') {
          const slotNorm = normName(pendingSlot.value);
          const nameMatches = data.practitioner_list.filter(p => {
            const n = normName(getPractitionerDisplayName ? getPractitionerDisplayName(p) : (p.display_name || p.name || ''));
            return n === slotNorm || n.includes(slotNorm) || slotNorm.includes(n);
          });
          const physioMatch = nameMatches.length === 1 ? nameMatches[0] : null;
          if (physioMatch && NluRouter.isSlotAutofillable(pendingSlot)) {
            data.selected_physio = physioMatch;
            data.selection_step = 'choose_type';
            if (typeof navPush === 'function') navPush(data, 'choose_type', { had_multiple_options: data.practitioner_list.length > 1, auto: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
            return await this.handleBookSpecificPhysio(session, '');
          }
          if (physioMatch && NluRouter.isSlotSuggestable(pendingSlot)) {
            data.suggested_physio = physioMatch;
            data.selection_step = 'confirm_physio_suggestion';
            if (typeof navPush === 'function') navPush(data, 'confirm_physio_suggestion', { had_multiple_options: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
            return buttons(`Did you mean *${getPractitionerDisplayName ? getPractitionerDisplayName(physioMatch) : physioMatch.name}*?`, [
              { id: 'confirm_physio', title: 'Yes' },
              { id: 'change_physio', title: 'Choose from list' },
            ]);
          }
        }
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      // Run preference funnel (gender → category) before showing the list.
      // Recurse with empty text once done so the list renders on a clean turn.
      if (data.physio_funnel_step !== 'done') {
        const fr = await this._stepPhysioFunnel(session, data, text);
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
        if (fr.reply) return fr.reply;
        return await this.handleBookSpecificPhysio(session, '');
      }

      // Filtered list based on preference (falls back to full list if filter is too narrow)
      const effectiveList = this._applyPhysioFilter(data.practitioner_list, data.physio_funnel_sel, data.physio_categories);

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.practitioner_page = (Number(data.practitioner_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }
      if (/^p(rev)?$/i.test(text)) {
        data.practitioner_page = Math.max(0, (Number(data.practitioner_page) || 0) - 1);
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      if (/^\d+$/.test(text)) {
        const page = data.practitioner_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const idx = pageStart + localNum - 1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, effectiveList.length - pageStart) && effectiveList[idx]) {
          data.selected_physio = effectiveList[idx];
          data.selection_step = 'choose_type';
          if (typeof navPush === 'function') navPush(data, 'choose_type', { had_multiple_options: effectiveList.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          return await this.handleBookSpecificPhysio(session, '');
        }
      }

      const phyReply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: effectiveList,
        rowFn: (p) => ({ title: String(getPractitionerDisplayName ? getPractitionerDisplayName(p, this._getSessionLanguage(session), this.logger) : (p.display_name||p.name)) }),
        page: data.practitioner_page || 0,
        header: t(this._getSessionLanguage(session), 'bookSpecificPhysio.choosePhysio')
      });
      return phyReply;
    }

    // ===== confirm_physio_suggestion (Phase 5 NLU slot suggestion): "Did you
    // mean X?" for a medium-confidence physio-name slot match. Same pattern
    // as confirm_type_suggestion — never auto-applied, decline/unrecognized
    // reply converges on the normal choose_physio list. =====
    if (data.selection_step === 'confirm_physio_suggestion') {
      if (data.suggested_physio && text === 'confirm_physio') {
        data.selected_physio = data.suggested_physio;
        delete data.suggested_physio;
        data.selection_step = 'choose_type';
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
        return await this.handleBookSpecificPhysio(session, '');
      }
      if (data.suggested_physio && text === '') {
        return buttons(`Did you mean *${getPractitionerDisplayName ? getPractitionerDisplayName(data.suggested_physio) : data.suggested_physio.name}*?`, [
          { id: 'confirm_physio', title: 'Yes' },
          { id: 'change_physio', title: 'Choose from list' },
        ]);
      }
      delete data.suggested_physio;
      data.selection_step = 'choose_physio';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      return await this.handleBookSpecificPhysio(session, '');
    }

    // =====================================================================
    // choose_type — unique type names for that physio
    // =====================================================================
    if (data.selection_step === 'choose_type') {
      if (!Array.isArray(data.appointment_type_list)) {
        const apptTypes = await this.clinikoAPI.getAppointmentTypes({ practitioner_id: String(data.selected_physio.id) });
        const isSG = this._getSessionRegion(session) === 'SG';
        const servicesSplit = this._servicesWithPatientTypeSplit(apptTypes);
        // Tier pairs can't be detected from this one physio's own type list
        // (see _clinicWideTypesForTierDetection's doc) — use the clinic-wide
        // list for detection only; bucketing itself still uses `apptTypes`.
        const tierBaseNames = this._tierBaseNamesWithVariants(await this._clinicWideTypesForTierDetection(session));
        const buckets = new Map();
        for (const t of (apptTypes || [])) {
          if (!t || !t.name) continue;
          if (/UWC/i.test(t.name) || /online\s*booking/i.test(t.name)) continue;
          const { bucketKey, displayName, service, duration } = this._bucketApptType(t, normName, isSG, servicesSplit, hasCapability(this._getSessionRegion(session), 'physioTiers'), tierBaseNames);
          const { insurer } = parseApptCategory(t.category);
          if (!buckets.has(bucketKey)) buckets.set(bucketKey, { displayName, entries: [], service, duration });
          buckets.get(bucketKey).entries.push({ id: String(t.id), insurer: insurer || null });
        }
        let typeList = Array.from(buckets.values())
          .map(v => ({ name: v.displayName, real_name: v.displayName, ids: v.entries.map(e => e.id), norm: normName(v.displayName), entries: v.entries, service: v.service, duration: v.duration }));
        if (isSG) typeList = this._disambiguateSGTypeNames(typeList);
        data.appointment_type_list = sortAppointmentTypes(typeList);
        data.appt_type_page = 0;

        // Phase 9: consume a pending NLU appointment-type slot exactly once,
        // now that the real type list exists to match it against — same
        // discipline as handleBookSpecificClinic's own choose_type consume
        // block. This funnel's list uses `norm` (not `norm_name`) per its
        // own bucket-building above.
        const pendingSlot = data.pending_nlu_slots && data.pending_nlu_slots.appointmentType;
        if (data.pending_nlu_slots) delete data.pending_nlu_slots.appointmentType;
        if (pendingSlot && typeof pendingSlot.value === 'string') {
          const slotNorm = normName(pendingSlot.value);
          const matched = data.appointment_type_list.find(t => t.norm === slotNorm)
            || data.appointment_type_list.find(t => t.norm.includes(slotNorm) || slotNorm.includes(t.norm));
          if (matched && NluRouter.isSlotAutofillable(pendingSlot)) {
            this._applyTypeSelection(data, matched);
            navPush(data, 'choose_type', { had_multiple_options: data.appointment_type_list.length > 1, auto: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
            return await this.handleBookSpecificPhysio(session, '');
          }
          if (matched && NluRouter.isSlotSuggestable(pendingSlot)) {
            data.suggested_appt_type = { ...matched };
            data.selection_step = 'confirm_type_suggestion';
            navPush(data, 'confirm_type_suggestion', { had_multiple_options: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
            return buttons(`Did you mean *${matched.name}*?`, [
              { id: 'confirm_type', title: 'Yes' },
              { id: 'change_type', title: 'Choose from list' },
            ]);
          }
        }

        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      if ((data.appointment_type_list || []).length === 0) {
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_PHYSIO, {
          context: 'physio',
          confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificPhysio.noVisitTypesForPhysio', { name: getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger) || 'this practitioner' }),
        });
      }

      // Phase 9: free-text answer to THIS rendering of the type list (not just
      // an entry-message pre-fill, which only runs once when the list is first
      // built above). Same discipline as handleBookSpecificDate's own block.
      // Reuses sharedNluResult from the physio-correction check above when
      // that already ran this turn instead of a second live call.
      if (!data.selected_appt_type && !isStepControlToken(text)) {
        const nlu = sharedNluResult || await NluRouter.classifyIntent(text, this.STATES.BOOK_SPECIFIC_PHYSIO, {});
        const typeSlot = nlu.slots && nlu.slots.appointmentType;
        if (typeSlot && typeof typeSlot.value === 'string') {
          const slotNorm = normName(typeSlot.value);
          const matched = data.appointment_type_list.find(x => x.norm === slotNorm)
            || data.appointment_type_list.find(x => x.norm.includes(slotNorm) || slotNorm.includes(x.norm));
          if (matched && NluRouter.isSlotAutofillable(typeSlot)) {
            this._applyTypeSelection(data, matched);
            navPush(data, 'choose_type', { had_multiple_options: data.appointment_type_list.length > 1, auto: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
            return await this.handleBookSpecificPhysio(session, '');
          }
          if (matched && NluRouter.isSlotSuggestable(typeSlot)) {
            data.suggested_appt_type = { ...matched };
            data.selection_step = 'confirm_type_suggestion';
            navPush(data, 'confirm_type_suggestion', { had_multiple_options: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
            return buttons(`Did you mean *${matched.name}*?`, [
              { id: 'confirm_type', title: 'Yes' },
              { id: 'change_type', title: 'Choose from list' },
            ]);
          }
        }
      }

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.appt_type_page = (Number(data.appt_type_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }
if (/^p(rev)?$/i.test(text)) {
  data.appt_type_page = Math.max(0, (Number(data.appt_type_page) || 0) - 1);
  await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
}

      if (/^\d+$/.test(text)) {
        const page = data.appt_type_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const list = data.appointment_type_list || [];
        const idx = pageStart + localNum - 1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, list.length - pageStart) && list[idx]) {
          this._applyTypeSelection(data, list[idx]);
          if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          return await this.handleBookSpecificPhysio(session, '');
        }
      }

      const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: data.appointment_type_list || [],
        rowFn: (a) => ({ title: String(translateApptTypeName(a.name, this._getSessionLanguage(session), this.logger)) }),
        page: data.appt_type_page || 0,
        header: t(this._getSessionLanguage(session), 'bookSpecificPhysio.selectVisitTypeForPhysio', { name: getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger) })
      });
      return reply;
    }

    // ===== choose_type_insurer: disambiguate insurer for a same-named type. Not a
    // navPush frame — Back returns to choose_type, same as the History flow. =====
    if (data.selection_step === 'choose_type_insurer') {
      const stepResult = this._stepTypeInsurer(session, data, text);
      if (stepResult.reply) {
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
        return stepResult.reply;
      }
      data.selection_step = 'choose_clinic';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      return await this.handleBookSpecificPhysio(session, '');
    }

    // ===== confirm_type_suggestion (Phase 9 NLU slot suggestion): "Did you
    // mean X?" for a medium-confidence appointment-type slot match. Never
    // auto-applied and never silently discarded — the user decides. Declining,
    // an unrecognized reply, or reaching this step with no live suggestion
    // all converge on the same unmodified choose_type list — no duplicated
    // rendering logic. Mirrors handleBookSpecificClinic's own step. =====
    if (data.selection_step === 'confirm_type_suggestion') {
      if (data.suggested_appt_type && text === 'confirm_type') {
        this._applyTypeSelection(data, data.suggested_appt_type);
        delete data.suggested_appt_type;
        data.selection_step = 'choose_type';
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
        return await this.handleBookSpecificPhysio(session, '');
      }
      if (data.suggested_appt_type && text === '') {
        return buttons(`Did you mean *${data.suggested_appt_type.name}*?`, [
          { id: 'confirm_type', title: 'Yes' },
          { id: 'change_type', title: 'Choose from list' },
        ]);
      }
      delete data.suggested_appt_type;
      data.selection_step = 'choose_type';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      return await this.handleBookSpecificPhysio(session, '');
    }

    // =====================================================================
    // choose_clinic — clinics where the physio works (exclude UWC),
    // pre-filtered to only those with slots for the selected type
    // =====================================================================
    if (data.selection_step === 'choose_clinic') {
      if (!Array.isArray(data.clinic_list)) {
        const physId = String(data.selected_physio?.id || data.selected_physio);
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const allClinics = [];
        for (const g of groups || []) {
          if (/UWC/i.test(g.clinic_name)) continue;
          if ((g.practitioners || []).some(p => `${p.id}` === physId))
            allClinics.push({ id: String(g.clinic_id), business_name: g.clinic_name });
        }
        const resolvedIds = data.selected_appt_type?.ids;
        const typeNorm = normName(data.selected_appt_type?.name || '');
        const { from, to } = normalizeDateWindow();
        const slotResults2 = await bulkAll(allClinics, c => this.clinikoAPI.getAvailableSlotsByBusinessAndDate({
          business_id: c.id, practitioner_id: physId, from, to
        }));
        const withSlots = allClinics.filter((c, i) =>
          (slotResults2[i] || []).some(s => resolvedIds && resolvedIds.length
            ? resolvedIds.includes(String(s.appointment_type_id))
            : normName(s.appointment_type_name) === typeNorm)
        );
        data.clinic_list = withSlots;
        data.clinic_page = 0;

        if (withSlots.length === 0) {
          // context 'physio_inner' is intercepted by the special-case handler at
          // the top of this function (before _handleNoSlotsDecision runs), which
          // navigates to choose_type and clears the stale selection — retry_step
          // is set for consistency but not read on that path.
          return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_PHYSIO, {
            context: 'physio_inner',
            retryStep: 'choose_type',
            retryLabel: t(this._getSessionLanguage(session), 'bookSpecificPhysio.tryAnotherType'),
            result: slotResults2,
            confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificPhysio.noSlotsForPhysioAndType', { physio: getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger), type: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) || 'that visit type' })
              + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
          });
        }

        if (withSlots.length === 1) {
          if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: false, auto: true });
          data.selected_clinic = withSlots[0];
          data.selection_step = 'view_slots';
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          return await this.handleBookSpecificPhysio(session, '');
        }

        if (typeof navPush === 'function') navPush(data, 'choose_clinic', { had_multiple_options: true, auto: false });
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
      }

      if (/^\d+$/.test(text)) {
        const list = data.clinic_list || [];
        const page = data.clinic_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(text, 10);
        const idx = pageStart + localNum - 1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, list.length - pageStart) && list[idx]) {
          data.selected_clinic = list[idx];
          data.selection_step = 'view_slots';
          if (typeof navPush === 'function') navPush(data, 'view_slots', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_PHYSIO });
          return await this.handleBookSpecificPhysio(session, '');
        }
      }

      const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: data.clinic_list || [],
        rowFn: (c) => ({ title: String(getBusinessDisplayName ? getBusinessDisplayName(c, this._getSessionLanguage(session), this.logger) : c.business_name) }),
        page: data.clinic_page || 0,
        header: t(this._getSessionLanguage(session), 'bookSpecificPhysio.selectClinicForPhysio', { name: getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger) })
      });
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

      const resolvedIds = data.selected_appt_type?.ids;
      const typeNorm = normName(data.selected_appt_type?.name || '');
      const slots = deduplicateSlots((raw || []).filter(s =>
        resolvedIds && resolvedIds.length
          ? resolvedIds.includes(String(s.appointment_type_id))
          : normName(s.appointment_type_name) === typeNorm
      ));
      if (!slots.length) {
        // retry_step defaults to 'view_slots' — Try Again re-runs this exact
        // fetch with selected_clinic/selected_physio intact.
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_PHYSIO, {
          context: 'physio',
          result: raw,
          confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificPhysio.noSlotsAtClinicForPhysio', { type: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) || 'this appointment type', clinic: getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger) || 'this clinic' })
            + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
        });
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

      const header = `${getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger)} • ${getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger)} • ${getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger)}`;
      return this._buildSlotList(slots, 0, header, this._regionTz(session), this._getSessionLanguage(session));
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

    // ---------- no-slots decision (must run before back/nav to handle "1","2","3" replies) ----------
    if (data.no_slots_prompt) {
      const ret = await this._handleNoSlotsDecision(session, data, this.STATES.BOOK_SPECIFIC_CLINIC, this.handleBookSpecificClinic, textRaw);
      if (ret) return ret;
    }

    // ---------- Back/Menu ----------
    // 'back' (interactive list id) behaves like '0' (contextual step-back), not like 'menu' (full exit).
    if (text === 'menu') {
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.BOOKING_METHOD_OPTIONS, data: null });
      return await this.goToInteractiveMenu(session);
    }
    if ((text === '0' || text === 'back') && data.selection_step) {
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
    // Phase 6: mid-flow appointment-type correction. Same pattern as
    // handleBookSpecificDate/handleBookSpecificPhysio's slot correction —
    // only once a type is already selected (past choose_type) and only for
    // free text that isn't a control token for the current step. Unlike
    // those handlers, selected_clinic is chosen *before* the type here, so
    // this never touches clinic_list/selected_clinic — only reuses the
    // choose_type step's own pending_nlu_slots consume path.
    // =====================================================================
    const MIDFLOW_TYPE_CORRECTION_STEPS = ['choose_type_insurer', 'choose_physio'];
    const isStepControlToken = (t) => t === '' || /^\d+$/.test(t) || /^m(ore)?$|^next$/i.test(t) || /^p(rev)?$/i.test(t);
    if (data.selected_appt_type && MIDFLOW_TYPE_CORRECTION_STEPS.includes(data.selection_step) && !isStepControlToken(text)) {
      const currentTypeNorm = normName(data.selected_appt_type.name || '');
      const result = await NluRouter.classifyIntent(textRaw, this.STATES.BOOK_SPECIFIC_CLINIC, { existingSlots: { appointmentType: currentTypeNorm } });
      const restartReply = await this._maybeHandleMidflowRestart(session, result, this.STATES.BOOK_SPECIFIC_CLINIC);
      if (restartReply) return restartReply;
      const typeSlot = result.slots && result.slots.appointmentType;
      if (NluRouter.MIDFLOW_CORRECTION_INTENTS.includes(result.intent) && typeSlot && typeSlot.value && normName(typeSlot.value) !== currentTypeNorm
          && (NluRouter.isSlotAutofillable(typeSlot) || NluRouter.isSlotSuggestable(typeSlot))) {
        this.logger.analyticsEvent({ event: 'nlu_midflow_correction', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now(), state: this.STATES.BOOK_SPECIFIC_CLINIC, slot: 'appointmentType', confidence: typeSlot.confidence });
        delete data.selected_appt_type;
        delete data.appointment_type_list;
        delete data.appt_type_page;
        delete data.insurer_page;
        delete data.suggested_appt_type;
        delete data.practitioner_list;
        delete data.practitioner_page;
        delete data.selected_physio;
        data.navigation_chain = [];
        data.selection_step = 'choose_type';
        data.pending_nlu_slots = { ...(data.pending_nlu_slots || {}), appointmentType: typeSlot };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        return await this.handleBookSpecificClinic(session, '');
      }
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

        if (clinics.length === 0) {
          // groups came back empty — could be a genuine "no clinics
          // configured" or a degraded getPractitionersByClinic() fetch (e.g.
          // a 429). Delete clinic_list so retry re-fetches instead of
          // finding the same empty array and skipping straight back here.
          delete data.clinic_list;
          return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_CLINIC, {
            context: 'clinic_list',
            result: groups,
            confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificClinic.noClinicsAvailable'),
          });
        }
      }

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.clinic_page = (Number(data.clinic_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      }
if (/^p(rev)?$/i.test(text)) {
  data.clinic_page = Math.max(0, (Number(data.clinic_page) || 0) - 1);
  await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
}

      if (numStr) {
        const page = data.clinic_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(numStr, 10);
        const list = data.clinic_list || [];
        const idx = pageStart + localNum - 1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, list.length - pageStart) && list[idx]) {
          data.selected_clinic = list[idx];
          data.selection_step = 'choose_type';
          if (typeof navPush === 'function') navPush(data, 'choose_type', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
          return await this.handleBookSpecificClinic(session, '');
        }
      }

      const reply = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: data.clinic_list || [],
        rowFn: (c) => ({ title: String(getBusinessDisplayName ? getBusinessDisplayName(c, this._getSessionLanguage(session), this.logger) : (c.business_name || c.display_name || c.id)) }),
        page: data.clinic_page || 0,
        header: t(this._getSessionLanguage(session), 'bookSpecificClinic.selectClinic')
      });
      return reply;
    }

    // =====================================================================
    // choose_type — type names available in this clinic
    // =====================================================================
    if (data.selection_step === 'choose_type') {
      let hadClinicTypeFailure = false;
      if (!Array.isArray(data.appointment_type_list)) {
        const groups = await this.clinikoAPI.getPractitionersByClinic();
        const clinicId = String(data.selected_clinic?.id || data.selected_clinic || '');
        const inClinic = (groups || []).find(g => String(g.clinic_id) === clinicId);
        const pracList = (inClinic?.practitioners || []).map(p => ({ id: String(p.id), ...p }));

        const buckets = new Map(); // norm -> { display, entries: [{id, insurer}] }
        // getAppointmentTypes() never throws (it catches internally and returns
        // _markPartial([]) on failure) — bulkAll both throttles this fanout the
        // same way every other practitioner-scale sweep is throttled (was
        // previously bypassing that via a bare Promise.allSettled, see
        // fix/fanout-batching-consistency) and lets us detect a real failure via
        // the _partial marker instead of a 'rejected' status that can never fire.
        const clinicTypesByPractitioner = await bulkAll(pracList,
          p => this.clinikoAPI.getAppointmentTypes({ practitioner_id: String(p.id) })
        );
        hadClinicTypeFailure = !!clinicTypesByPractitioner._partial || clinicTypesByPractitioner.some(types => types && types._partial);
        const isSG = this._getSessionRegion(session) === 'SG';
        const servicesSplit = this._servicesWithPatientTypeSplit(clinicTypesByPractitioner.flat().filter(Boolean));
        const tierBaseNames = this._tierBaseNamesWithVariants(clinicTypesByPractitioner.flat().filter(Boolean));
        for (const types of clinicTypesByPractitioner) {
          for (const t of (types || [])) {
            if (!t || !t.name) continue;
            if (/UWC/i.test(t.name) || /online\s*booking/i.test(t.name)) continue;
            const { bucketKey, displayName, service, duration } = this._bucketApptType(t, normName, isSG, servicesSplit, hasCapability(this._getSessionRegion(session), 'physioTiers'), tierBaseNames);
            const { insurer } = parseApptCategory(t.category);
            if (!buckets.has(bucketKey)) buckets.set(bucketKey, { display: displayName, entries: [], service, duration });
            buckets.get(bucketKey).entries.push({ id: String(t.id), insurer: insurer || null });
          }
        }
        let typeList = Array.from(buckets.values())
          .map(v => ({ name: v.display, norm_name: normName(v.display), ids: v.entries.map(e => e.id), entries: v.entries, service: v.service, duration: v.duration }));
        if (isSG) typeList = this._disambiguateSGTypeNames(typeList);
        data.appointment_type_list = sortAppointmentTypes(typeList);
        data.appt_type_page = 0;

        // Phase 2: consume a pending NLU appointment-type slot exactly once,
        // now that the real type list exists to match it against. The raw LLM
        // slot value is never trusted directly — it's only used to pick which
        // *existing* entry (already ID-matched to real Cliniko types above) to
        // apply, same discipline as every manual selection in this handler.
        const pendingSlot = data.pending_nlu_slots && data.pending_nlu_slots.appointmentType;
        if (data.pending_nlu_slots) delete data.pending_nlu_slots.appointmentType;
        if (pendingSlot && typeof pendingSlot.value === 'string') {
          const slotNorm = normName(pendingSlot.value);
          const matched = data.appointment_type_list.find(t => t.norm_name === slotNorm)
            || data.appointment_type_list.find(t => t.norm_name.includes(slotNorm) || slotNorm.includes(t.norm_name));
          if (matched && NluRouter.isSlotAutofillable(pendingSlot)) {
            this._applyTypeSelection(data, matched);
            navPush(data, 'choose_type', { had_multiple_options: data.appointment_type_list.length > 1, auto: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
            return await this.handleBookSpecificClinic(session, '');
          }
          if (matched && NluRouter.isSlotSuggestable(pendingSlot)) {
            data.suggested_appt_type = { ...matched };
            data.selection_step = 'confirm_type_suggestion';
            navPush(data, 'confirm_type_suggestion', { had_multiple_options: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
            return buttons(`Did you mean *${matched.name}*?`, [
              { id: 'confirm_type', title: 'Yes' },
              { id: 'change_type', title: 'Choose from list' },
            ]);
          }
        }

        const fwd = typeof planForward === 'function' ? planForward(data, 'choose_type', data.appointment_type_list.length, () => {
          this._applyTypeSelection(data, data.appointment_type_list[0]);
        }) : { advanced: false };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (fwd.advanced) return await this.handleBookSpecificClinic(session, '');
      }

      if ((data.appointment_type_list || []).length === 0) {
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_CLINIC, {
          context: 'clinic',
          result: hadClinicTypeFailure ? _markPartial([]) : [],
          confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificClinic.noApptTypesAtClinic', { clinic: getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger) : 'this clinic' }),
        });
      }

      // Phase 9: free-text answer to THIS rendering of the type list (not just
      // an entry-message pre-fill, which only runs once when the list is first
      // built above). Same discipline as handleBookSpecificDate's own block.
      // This funnel's list uses `norm_name` per its own bucket-building above.
      if (!data.selected_appt_type && !isStepControlToken(text)) {
        const nlu = await NluRouter.classifyIntent(text, this.STATES.BOOK_SPECIFIC_CLINIC, {});
        const typeSlot = nlu.slots && nlu.slots.appointmentType;
        if (typeSlot && typeof typeSlot.value === 'string') {
          const slotNorm = normName(typeSlot.value);
          const matched = data.appointment_type_list.find(x => x.norm_name === slotNorm)
            || data.appointment_type_list.find(x => x.norm_name.includes(slotNorm) || slotNorm.includes(x.norm_name));
          if (matched && NluRouter.isSlotAutofillable(typeSlot)) {
            this._applyTypeSelection(data, matched);
            navPush(data, 'choose_type', { had_multiple_options: data.appointment_type_list.length > 1, auto: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
            return await this.handleBookSpecificClinic(session, '');
          }
          if (matched && NluRouter.isSlotSuggestable(typeSlot)) {
            data.suggested_appt_type = { ...matched };
            data.selection_step = 'confirm_type_suggestion';
            navPush(data, 'confirm_type_suggestion', { had_multiple_options: true });
            await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
            return buttons(`Did you mean *${matched.name}*?`, [
              { id: 'confirm_type', title: 'Yes' },
              { id: 'change_type', title: 'Choose from list' },
            ]);
          }
        }
      }

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.appt_type_page = (Number(data.appt_type_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      }
if (/^p(rev)?$/i.test(text)) {
  data.appt_type_page = Math.max(0, (Number(data.appt_type_page) || 0) - 1);
  await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
}

      if (numStr && !data.selected_appt_type) {
        const page = data.appt_type_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(numStr, 10);
        const list = data.appointment_type_list || [];
        const idx = pageStart + localNum - 1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, list.length - pageStart) && list[idx]) {
          this._applyTypeSelection(data, list[idx]);
          if (typeof navPush === 'function') navPush(data, 'choose_physio', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
          return await this.handleBookSpecificClinic(session, '');
        }
      }

      const replyTypes = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: data.appointment_type_list || [],
        rowFn: (a) => ({ title: String(translateApptTypeName(a.name, this._getSessionLanguage(session), this.logger)) }),
        page: data.appt_type_page || 0,
        header: t(this._getSessionLanguage(session), 'bookSpecificClinic.selectVisitTypeForClinic', { clinic: getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger) : '' })
      });
      return replyTypes;
    }

    // ===== confirm_type_suggestion (Phase 2 NLU slot suggestion): "Did you
    // mean X?" for a medium-confidence appointment-type slot match. Never
    // auto-applied and never silently discarded — the user decides. Declining,
    // an unrecognized reply, or reaching this step with no live suggestion
    // (e.g. via Back after it was already resolved) all converge on the same
    // unmodified choose_type list — no duplicated rendering logic. =====
    if (data.selection_step === 'confirm_type_suggestion') {
      if (data.suggested_appt_type && text === 'confirm_type') {
        this._applyTypeSelection(data, data.suggested_appt_type);
        delete data.suggested_appt_type;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        return await this.handleBookSpecificClinic(session, '');
      }
      if (data.suggested_appt_type && text === '') {
        return buttons(`Did you mean *${data.suggested_appt_type.name}*?`, [
          { id: 'confirm_type', title: 'Yes' },
          { id: 'change_type', title: 'Choose from list' },
        ]);
      }
      delete data.suggested_appt_type;
      data.selection_step = 'choose_type';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      return await this.handleBookSpecificClinic(session, '');
    }

    // ===== choose_type_insurer: disambiguate insurer for a same-named type. Not a
    // navPush frame — Back returns to choose_type, same as the History flow. =====
    if (data.selection_step === 'choose_type_insurer') {
      const stepResult = this._stepTypeInsurer(session, data, text);
      if (stepResult.reply) {
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        return stepResult.reply;
      }
      data.selection_step = 'choose_physio';
      await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      return await this.handleBookSpecificClinic(session, '');
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
        // selected_appt_type.ids is already insurer-scoped by this point (narrowed by
        // _stepTypeInsurer when the type name had multiple insurer variants), so this
        // correctly excludes practitioners who only offer a different insurer's id.
        const wanted = new Set((data.selected_appt_type?.ids || []).map(String));

        // getAppointmentTypes() never throws (it catches internally and returns
        // _markPartial([]) on failure) — bulkAll both throttles this fanout the
        // same way every other practitioner-scale sweep is throttled (was
        // previously bypassing that via a bare Promise.allSettled, see
        // fix/fanout-batching-consistency) and lets us detect a real failure via
        // the _partial marker instead of a 'rejected' status that can never fire.
        const physioTypesByPractitioner = await bulkAll(pracInClinic,
          p => this.clinikoAPI.getAppointmentTypes({ practitioner_id: String(p.id) })
        );
        const hadPhysioTypeFailure = !!physioTypesByPractitioner._partial || physioTypesByPractitioner.some(types => types && types._partial);
        const practitioners = pracInClinic.filter((p, i) =>
          (physioTypesByPractitioner[i] || []).some(t => wanted.has(String(t.id)))
        );

        data.practitioner_list = sortPractitioners(practitioners);
        data.practitioner_page = 0;

        const fwd = typeof planForward === 'function' ? planForward(data, 'choose_physio', practitioners.length, () => {
          data.selected_physio = practitioners[0];
          data.selection_step = 'view_slots';
        }) : { advanced: false };
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (fwd.advanced) return await this.handleBookSpecificClinic(session, '');

        if (practitioners.length === 0) {
          // groups came back empty — could be a genuine "no practitioners at
          // this clinic offer this type" or a degraded getPractitionersByClinic()
          // fetch (e.g. a 429). Delete practitioner_list so retry re-fetches
          // instead of finding the same empty array.
          delete data.practitioner_list;
          return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_CLINIC, {
            context: 'clinic_physio_list',
            result: [groups, hadPhysioTypeFailure ? _markPartial([]) : []],
            confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificClinic.noPractitionersAtClinicForType', { clinic: getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger) : 'this clinic', type: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) || 'this visit type' })
              + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
          });
        }
      }

      // Physio-tier funnel (config-gated; no-op unless the region has the
      // 'physioTiers' capability and this type spans >1 real Cliniko name).
      // This flow has no gender-preference funnel to order against — the
      // tier question is simply asked before the physio list is shown.
      if (data.physio_tier_step !== 'done') {
        const fr = await this._stepPhysioTierFunnel(session, data, text);
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
        if (fr.reply) return fr.reply;
        if (!fr.skipped) return await this.handleBookSpecificClinic(session, '');
      }

      if (/^m(ore)?$|^next$/i.test(text)) {
        data.practitioner_page = (Number(data.practitioner_page) || 0) + 1;
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      }
      if (/^p(rev)?$/i.test(text)) {
        data.practitioner_page = Math.max(0, (Number(data.practitioner_page) || 0) - 1);
        await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
      }

      const effectiveList = this._applyPhysioTierFilter(data.practitioner_list || [], data.physio_tier_sel, data.physio_tier_groups);

      if (numStr) {
        const page = data.practitioner_page || 0;
        const pageStart = interactivePageStart(page);
        const pageSize = interactivePageSize(page);
        const localNum = parseInt(numStr, 10);
        const list = effectiveList;
        const idx = pageStart + localNum - 1;
        if (localNum >= 1 && localNum <= Math.min(pageSize, list.length - pageStart) && list[idx]) {
          data.selected_physio = list[idx];
          data.selection_step = 'view_slots';
          if (typeof navPush === 'function') navPush(data, 'view_slots', { had_multiple_options: list.length > 1, auto: false });
          await sync({ conversation_state: this.STATES.BOOK_SPECIFIC_CLINIC });
          return await this.handleBookSpecificClinic(session, '');
        }
      }

      const replyPhys = buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        items: effectiveList,
        rowFn: (p) => ({ title: String(getPractitionerDisplayName ? getPractitionerDisplayName(p, this._getSessionLanguage(session), this.logger) : (p.display_name || p.name || p.id)) }),
        page: data.practitioner_page || 0,
        header: t(this._getSessionLanguage(session), 'bookSpecificClinic.choosePhysioForClinic', { clinic: getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger) : '' })
      });
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

      const resolvedIds = data.selected_appt_type?.ids;
      const typeNorm = normName(data.selected_appt_type?.name || '');
      const slots = deduplicateSlots((raw || []).filter(s =>
        resolvedIds && resolvedIds.length
          ? resolvedIds.includes(String(s.appointment_type_id))
          : normName(s.appointment_type_name) === typeNorm
      ));
      if (!slots.length) {
        // retry_step defaults to 'view_slots' — Try Again re-runs this exact
        // fetch with selected_clinic/selected_physio intact.
        return await this._noSlotsRetry(session, data, this.STATES.BOOK_SPECIFIC_CLINIC, {
          context: 'clinic',
          result: raw,
          confirmedMessage: t(this._getSessionLanguage(session), 'bookSpecificPhysio.noSlotsAtClinicForPhysio', { type: getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) || 'this appointment type', clinic: getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger) : 'this clinic' })
            + this._insurerNoMatchSuffix(data.selected_appt_type, this._getSessionLanguage(session)),
        });
      }

      const slotData = {
        slot_list: slots,
        slot_page: 0,
        last_selection_flow: 'clinic',
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

      const header = `${getAppointmentTypeDisplayName ? getAppointmentTypeDisplayName(data.selected_appt_type, this._getSessionLanguage(session), this.logger) : ''} • ${getPractitionerDisplayName ? getPractitionerDisplayName(data.selected_physio, this._getSessionLanguage(session), this.logger) : ''} • ${getBusinessDisplayName ? getBusinessDisplayName(data.selected_clinic, this._getSessionLanguage(session), this.logger) : ''}`;
      return this._buildSlotList(slots, 0, header, this._regionTz(session), this._getSessionLanguage(session));
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

    // When no slots are present in this state (edge case), offer standard 3-button prompt.
    // This state doesn't own a fetch to retry — data.slot_list was populated by
    // whichever prior handler transitioned here — and has no selection_step, so
    // there's no sensible in-place retry step. No retryStep override: this falls
    // through to _handleNoSlotsDecision's generic navBack, same as before.
    if (!slots.length) {
      return await this._noSlotsRetry(session, data, this.STATES.SELECT_SLOT, {
        context: 'slot',
        confirmedMessage: t(this._getSessionLanguage(session), 'slotSelection.noSlotsToShow'),
      });
    }

    const page = data.slot_page || 0;
    if (!isNaN(text) && text !== '') {
      const start = this._slotPageStart(page);
      const count = this._slotPageCount(page);
      const idx = parseInt(text, 10) - 1;
      if (isNaN(idx) || idx < start || idx >= Math.min(start + count, slots.length)) {
        return t(this._getSessionLanguage(session), 'slotSelection.invalidSlotSelection');
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
      if (data.prev_state_data?.selected_appt_type?.name) headerParts.push(getAppointmentTypeDisplayName(data.prev_state_data.selected_appt_type, this._getSessionLanguage(session), this.logger));
      if (data.prev_state_data?.selected_physio?.display_name || data.prev_state_data?.selected_physio?.first_name) headerParts.push(getPractitionerDisplayName(data.prev_state_data.selected_physio, this._getSessionLanguage(session), this.logger));
      if (data.prev_state_data?.selected_clinic?.business_name) headerParts.push(getBusinessDisplayName(data.prev_state_data.selected_clinic, this._getSessionLanguage(session), this.logger));
      const header = headerParts.length ? headerParts.join(' • ') : (selectedSlot.practitioner_name || t(this._getSessionLanguage(session), 'slotSelection.defaultApptFallback'));

      return buttons(
        t(this._getSessionLanguage(session), 'slotSelection.youHaveSelected', { header, datetime: formatSlotDateTime(dt, this._regionTz(session)) }),
        [
          { id: 'yes', title: t(this._getSessionLanguage(session), 'slotSelection.confirmBookingButton') },
          { id: '0',   title: t(this._getSessionLanguage(session), 'slotSelection.goBackButton') }
        ]
      );
    }

    // Build a single header if context exists
    let header = t(this._getSessionLanguage(session), 'slotSelection.defaultHeader');
    if (data.prev_state_data?.selected_appt_type || data.prev_state_data?.selected_physio || data.prev_state_data?.selected_clinic) {
      const parts = [];
      if (data.prev_state_data?.selected_appt_type?.name) parts.push(getAppointmentTypeDisplayName(data.prev_state_data.selected_appt_type, this._getSessionLanguage(session), this.logger));
      if (data.prev_state_data?.selected_physio?.display_name || data.prev_state_data?.selected_physio?.first_name) {
        parts.push(getPractitionerDisplayName(data.prev_state_data.selected_physio, this._getSessionLanguage(session), this.logger));
      }
      if (data.prev_state_data?.selected_clinic?.business_name) parts.push(getBusinessDisplayName(data.prev_state_data.selected_clinic, this._getSessionLanguage(session), this.logger));
      header = parts.join(' • ');
    }

    return this._buildSlotList(slots, page, header, this._regionTz(session), this._getSessionLanguage(session));
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
      return t(this._getSessionLanguage(session), 'bookingConfirmation.noSlotSelected');
    }

    // --- Debug: Enrichment ---
    let enrichedSlot = selectedSlot;
    try {
      const enrichableSlot = slotToEnrichable(selectedSlot);
      const enrichedArr = await enrichAppointmentsForDisplay([enrichableSlot], this.clinikoAPI, this._regionTz(session), this._getSessionLanguage(session));
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
        return prependTextToEnvelope(t(this._getSessionLanguage(session), 'common.cannotProceedBooking'), await this.renderMainMenu(session));
      }

      // Defensive: Check slot fields
      if (!selectedSlot.practitioner_id || !selectedSlot.business_id || !selectedSlot.appointment_type_id || !selectedSlot.slot) {
        this.logger.warn('[handleConfirmBookingState] Slot missing required fields', { slot: selectedSlot });
        return t(this._getSessionLanguage(session), 'bookingConfirmation.slotMissingDetails');
      }

      // --- Debug: Attempt booking ---
      let result = {};
      try {
        result = await this.clinikoAPI.bookAppointment({
          patient_id,
          practitioner_id: selectedSlot.practitioner_id,
          business_id: selectedSlot.business_id,
          appointment_type_id: selectedSlot.appointment_type_id,
          starts_at: selectedSlot.slot,
          sessionId: session.id,
          region: this._getSessionRegion(session)
        });
        this.logger.debug('[handleConfirmBookingState] Book appointment result', { result });
      } catch (e) {
        this.logger.error('[handleConfirmBookingState] Error in bookAppointment', e);
        result = { success: false, message: t(this._getSessionLanguage(session), 'bookingConfirmation.technicalErrorFallback') };
      }

      if (result.success) {
        // After a confirmed booking, the patient is no longer "new" — flip for next session
        const ctx = (() => { try { return typeof session.context === 'string' ? JSON.parse(session.context) : (session.context || {}); } catch { return {}; } })();
        if (ctx.appt_preference && ctx.appt_preference.patientType === 'new') {
          ctx.appt_preference.patientType = 'follow_up';
          session.context = ctx;
          const phone = session.phone_number || session.phoneNumber;
          if (phone) this.sessionManager.db.upsertPatientState(phone, { appt_preference: JSON.stringify(ctx.appt_preference) }).catch(() => {});
        }

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
          const supportEmail = this._resolveSupportEmail(region, enrichedSlot._business_display);
          const userEmail = String(ctx.email || session.email || '').trim();
          const to = [];
          if (supportEmail) to.push(supportEmail);
          if (userEmail)    to.push(userEmail);
          await this._postEmail({ to, subject, html, text });
        } catch (e) {
          this.logger.error('[Booking] Confirmation email send failed', { error: e?.message || e, sessionId: session.id });
        }
        // --- Debug: Booking success, show enriched details ---
        const successText = t(this._getSessionLanguage(session), 'bookingConfirmation.bookingSuccess', {
          practitioner: enrichedSlot._practitioner_display || enrichedSlot.practitioner_name,
          clinic: enrichedSlot._business_display || '',
          datetime: formatSlotDateTime(dt, this._regionTz(session)),
        });
        return [successText, await this.goToInteractiveMenu(session)];
      } else {
        // --- Debug: Booking failed, show error message ---
        return [t(this._getSessionLanguage(session), 'bookingConfirmation.bookingFailed', { message: result.message || '' }), await this.goToInteractiveMenu(session)];
      }
    }

    // Unknown input — re-show confirmation with error prefix
    return prependTextToEnvelope(
      t(this._getSessionLanguage(session), 'bookingConfirmation.confirmPrompt'),
      buttons(
        t(this._getSessionLanguage(session), 'bookingConfirmation.selectedSummary', {
          practitioner: enrichedSlot._practitioner_display || enrichedSlot.practitioner_name,
          clinic: enrichedSlot._business_display || '',
          datetime: formatSlotDateTime(dt, this._regionTz(session)),
        }),
        [
          { id: 'yes', title: t(this._getSessionLanguage(session), 'slotSelection.confirmBookingButton') },
          { id: '0',   title: t(this._getSessionLanguage(session), 'slotSelection.goBackButton') }
        ]
      )
    );
  }

  // ========== VIEW FEES / LOCATIONS / REGISTER (REUSE) ==========

  async handleViewFeesState(session, message) {
    const region = this._getSessionRegion(session);
    const language = this._getSessionLanguage(session);
    const feeData = getRegionFeesForLanguage(region, language);
    const lines = feeData.items.map(item => `• ${item}`).join('\n');
    const fees = `${t(language, 'viewFeesLocations.feeStructureHeader')}\n\n${feeData.header}\n${lines}`;
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
    const fresh = await this.sessionManager.getSession(session.id);
    return [fees, await this.renderMainMenu(fresh)];
  }

  async handleViewLocationsState(session, message) {
    const language = this._getSessionLanguage(session);
    const clinics = await this.clinikoAPI.getClinics();
    // clinics._partial means the fetch failed (e.g. a 429) — not a confirmed
    // empty list. Don't tell the user "no clinics" when it's really "try again".
    let locationText;
    if (clinics._partial) {
      locationText = t(language, 'viewFeesLocations.clinicSystemTrouble');
    } else {
      const displayText = clinics.length
        ? clinics.map(c => formatClinicForWhatsApp(c)).join('\n\n')
        : t(language, 'viewFeesLocations.noClinicInfo');
      locationText = `${t(language, 'viewFeesLocations.locationsIntro')}\n\n${displayText}`;
    }
    await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
    const fresh = await this.sessionManager.getSession(session.id);
    return [locationText, await this.renderMainMenu(fresh)];
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
    const language = this._getSessionLanguage(session);

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

    // Same DOB parser as handleVerifyState's step — accepts "dd mm yyyy", "dd/mm/yyyy", etc.
    const parseDob = (raw) => {
      const m = String(raw || '').trim().match(/^(\d{1,2})(?:[\s\/\-\.])+(\d{1,2})(?:[\s\/\-\.])+(\d{4})$/);
      if (!m) return null;
      const [, dd, mm, yyyy] = m;
      const d = new Date(Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10)));
      return isNaN(d.getTime()) ? null : `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    };

    // Collect required fields in order. DOB is required so this patient can
    // later re-verify via "Yes, I'm registered" (email + DOB) — without it,
    // Cliniko's record has a blank date_of_birth that can never match a real
    // DOB the patient enters, permanently locking them out of re-verification.
    const required = ['first_name', 'last_name', 'email', 'dob'];
    let next = null;
    for (const f of required) {
      if (!data[f]) { next = f; break; }
    }

    if (next) {
      if (text) {
        if (next === 'email') {
          // Same format check as handleVerifyState's email step.
          const email = text.toLowerCase();
          if (!email.includes('@') || !email.includes('.')) {
            return buttons(t(language, 'registerFlow.invalidEmail'), [{ id: '0', title: t(language, 'registerFlow.backButton') }]);
          }
          data.email = email;
        } else if (next === 'dob') {
          const parsed = parseDob(text);
          if (!parsed) {
            return buttons(t(language, 'registerFlow.invalidDob'), [{ id: '0', title: t(language, 'registerFlow.backButton') }]);
          }
          data.dob = parsed; // stored as YYYY-MM-DD
        } else {
          data[next] = text;
        }
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        log.info('Collected field', { field: next });
      }
      if (!data.first_name) return buttons(t(language, 'registerFlow.askFirstName'), [{ id: '0', title: t(language, 'registerFlow.backButton') }]);
      if (!data.last_name)  return buttons(t(language, 'registerFlow.askLastName'), [{ id: '0', title: t(language, 'registerFlow.backButton') }]);
      if (!data.email)      return buttons(t(language, 'registerFlow.askEmail'), [{ id: '0', title: t(language, 'registerFlow.backButton') }]);
      if (!data.dob)        return buttons(t(language, 'registerFlow.askDob'), [{ id: '0', title: t(language, 'registerFlow.backButton') }]);
    }

    // Phase 8: duplicate-registration guard. Once all 4 fields are in,
    // search Cliniko by first name + last name + DOB before creating a new
    // patient record — Cliniko's /patients search has no phone filter
    // (checked against the public API docs), so name+DOB is the best
    // available signal. Runs once per registration attempt; a "No, continue"
    // reply sets duplicate_check_confirmed so it never re-checks.
    if (!data.duplicate_check_confirmed) {
      const DUPLICATE_PROMPT = buttons(
        t(language, 'registerFlow.duplicateFoundPrompt'),
        [
          { id: '1', title: t(language, 'registerFlow.duplicateYesRegistered') },
          { id: '2', title: t(language, 'registerFlow.duplicateNoContinue') },
        ]
      );
      if (data.duplicate_check_prompted) {
        if (text === '1') {
          // "Yes, I'm already registered" — hand off to the existing
          // email+DOB verify flow instead of creating a second record.
          await this.sessionManager.updateSession(session.id, {
            conversation_state: this.STATES.VERIFY,
            data: JSON.stringify({ awaiting_email: true })
          });
          return t(language, 'verifyFlow.restartEnterEmail');
        }
        if (text === '2') {
          delete data.duplicate_check_prompted;
          data.duplicate_check_confirmed = true;
          await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
        } else {
          return DUPLICATE_PROMPT;
        }
      } else {
        let matches = [];
        try {
          matches = await this.clinikoAPI.findPatientsByNameAndDob(data.first_name, data.last_name, data.dob);
        } catch (e) {
          // Fail open — an outage here must not block a genuine new patient
          // from registering.
          log.warn('Duplicate-check lookup failed, proceeding without it', { err: e?.message || e });
          matches = [];
        }
        if (Array.isArray(matches) && matches.length > 0) {
          data.duplicate_check_prompted = true;
          await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
          return DUPLICATE_PROMPT;
        }
        data.duplicate_check_confirmed = true;
        await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      }
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
      return prependTextToEnvelope(t(language, 'registerFlow.missingEmailOrPhone'), await this.renderMainMenu(updated));
    }

    const patient = {
      first_name:     data.first_name,
      last_name:      data.last_name,
      email:          data.email,
      date_of_birth:  data.dob,
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
        // Persist verified status outside the session's TTL — see comment in
        // handleVerifyState's success path for why this is necessary.
        const phoneForState = session.phone_number || session.phoneNumber;
        if (phoneForState && newPatientId) {
          this.sessionManager.db.upsertPatientState(phoneForState, { patient_id: String(newPatientId), verified: true }).catch(() => {});
        }
        const updated = await this.sessionManager.getSession(session.id);
        log.info('Registration success', { email: patient.email, patient_id: newPatientId });
        this.logger.analyticsEvent({ event: 'registration_completed', sessionId: session.id, region: this._getSessionRegion(session), ts: Date.now() });
        return prependTextToEnvelope(t(language, 'registerFlow.registrationSuccess'), await this.renderMainMenu(updated));
      }
      log.warn('Registration returned falsy result');
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      return prependTextToEnvelope(t(language, 'registerFlow.registrationFailedFalsy'), await this.renderMainMenu(session));
    } catch (e) {
      log.error('Registration error', { err: e?.message || e });
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.INTRO });
      return prependTextToEnvelope(t(language, 'registerFlow.registrationError'), await this.renderMainMenu(session));
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
      return t(this._getSessionLanguage(session), 'cancelFlow.needVerification');
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
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'cancelFlow.noUpcomingAppointments'), await this.goToInteractiveMenu(session));
    }

    futureAppts = await enrichAppointmentsForDisplay(futureAppts, this.clinikoAPI, this._regionTz(session), this._getSessionLanguage(session));

    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.cancel_appt_list = futureAppts;
    data.cancel_appt_page = 0;
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

    return buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
      header: t(this._getSessionLanguage(session), 'cancelFlow.upcomingAppointmentsHeader'),
      items: futureAppts,
      rowFn: (appt) => ({
        title: appt._practitioner_display || t(this._getSessionLanguage(session), 'cancelFlow.appointmentFallback'),
        description: `${appt._appointment_type_display} — ${appt._display_dt}`.slice(0, 72)
      }),
      page: 0
    });
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
      delete data.cancel_appt_page;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }
    const renderCancelList = async (page) => {
      data.cancel_appt_page = page;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        header: t(this._getSessionLanguage(session), 'cancelFlow.upcomingAppointmentsHeader'),
        items: appts,
        rowFn: (appt) => ({
          title: appt._practitioner_display || t(this._getSessionLanguage(session), 'cancelFlow.appointmentFallback'),
          description: `${appt._appointment_type_display} — ${appt._display_dt}`.slice(0, 72)
        }),
        page
      });
    };
    if (/^p(rev)?$/i.test(text)) return renderCancelList(Math.max(0, (Number(data.cancel_appt_page) || 0) - 1));
    if (/^m(ore)?$|^next$/i.test(text)) return renderCancelList((Number(data.cancel_appt_page) || 0) + 1);
    const page = Number(data.cancel_appt_page) || 0;
    const pageStart = interactivePageStart(page);
    const pageSize = interactivePageSize(page);
    const localNum = parseInt(text, 10);
    const idx = pageStart + localNum - 1;
    if (isNaN(localNum) || localNum < 1 || localNum > Math.min(pageSize, appts.length - pageStart) || !appts[idx]) {
      return t(this._getSessionLanguage(session), 'cancelFlow.invalidSelection');
    }
    data.selected_cancel_appt = appts[idx];
    data.selected_cancel_appt_idx = idx;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    return await this._cancelPresentConfirmation(session, data, false);
  }

  /**
   * True if the appointment starts within APPOINTMENT_CHANGE_BLOCK_WINDOW_MS
   * from now. Used to block both cancellation and rescheduling.
   * @param {object} appt - must have a starts_at ISO string
   */
  _isAppointmentChangeBlockedByPolicy(appt) {
    if (!appt?.starts_at) return false;
    const msUntilStart = new Date(appt.starts_at).getTime() - Date.now();
    return msUntilStart < APPOINTMENT_CHANGE_BLOCK_WINDOW_MS;
  }

  /**
   * Renders the 24-hour appointment-change-blocked prompt (Main menu /
   * Email us / Message on WhatsApp). Shared by cancel and reschedule's
   * initial presentation and their invalid-input re-prompts.
   * @param {string} introText
   * @param {'cancelled'|'rescheduled'} action
   */
  _renderAppointmentChangeBlockedPrompt(introText, action, session) {
    const language = this._getSessionLanguage(session);
    const actionLabel = t(language, action === 'rescheduled' ? 'appointmentChangeBlocked.actionRescheduled' : 'appointmentChangeBlocked.actionCancelled');
    return buttons(
      t(language, 'appointmentChangeBlocked.promptBody', { intro: introText, action: actionLabel }),
      [
        { id: '1', title: t(language, 'common.mainMenuButton') },
        { id: '2', title: t(language, 'common.emailUs') },
        { id: '3', title: t(language, 'common.messageOnWhatsApp') },
      ]
    );
  }

  /**
   * Presents cancellation confirmation for a selected appointment.
   * Used by both the single-appointment and selection flows.
   * If the appointment starts within 24 hours, blocks cancellation and
   * shows the front-desk contact prompt instead of Yes/No confirmation.
   * @param {object} session
   * @param {object} data
   * @param {boolean} isSingle (true if called from the "only one appt" shortcut)
  */
  async _cancelPresentConfirmation(session, data, isSingle) {
    const language = this._getSessionLanguage(session);
    const appt = data.selected_cancel_appt;
    if (!appt) {
      // Clean up
      delete data.cancel_appt_list;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return prependTextToEnvelope(t(language, 'cancelFlow.couldNotFindAppointment'), await this.goToInteractiveMenu(session));
    }

    const intro = isSingle
      ? t(language, 'cancelFlow.oneUpcomingIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt })
      : t(language, 'cancelFlow.selectedIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt });

    if (this._isAppointmentChangeBlockedByPolicy(appt)) {
      data.cancel_blocked_prompt = true;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.CONFIRM_CANCEL,
        data: JSON.stringify(data)
      });
      return this._renderAppointmentChangeBlockedPrompt(intro, 'cancelled', session);
    }

    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.CONFIRM_CANCEL,
      data: JSON.stringify(data)
    });
    return buttons(`${intro}\n\n${t(language, 'cancelFlow.confirmCancellationQuestion')}`, [
      { id: 'yes', title: t(language, 'cancelFlow.yesCancelButton') },
      { id: '0',   title: t(language, 'slotSelection.goBackButton') }
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

    if (data.cancel_blocked_prompt) {
      return await this._handleCancelBlockedDecision(session, data, message);
    }

    // Back/menu
    if (["0", "menu", "back"].includes(text)) {
      delete data.cancel_appt_list; delete data.selected_cancel_appt; delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }

    // Require explicit yes — unknown input re-shows prompt with prefix
    if (text !== 'yes') {
      const language = this._getSessionLanguage(session);
      const appt = data.selected_cancel_appt;
      const intro = appt
        ? t(language, 'cancelFlow.cancellingIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt })
        : t(language, 'cancelFlow.confirmCancellationQuestion');
      return prependTextToEnvelope(
        t(language, 'cancelFlow.replyYesOrBack'),
        buttons(`${intro}\n\n${t(language, 'cancelFlow.confirmCancellationQuestion')}`, [
          { id: 'yes', title: t(language, 'cancelFlow.yesCancelButton') },
          { id: '0',   title: t(language, 'slotSelection.goBackButton') }
        ])
      );
    }

    const appt = data.selected_cancel_appt;
    if (!appt || !appt.id) {
      delete data.cancel_appt_list; delete data.selected_cancel_appt; delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'cancelFlow.couldNotFindAppointment'), await this.goToInteractiveMenu(session));
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
      this.logger.analyticsEvent({
        event: 'cancellation_confirmed', sessionId: session.id, region: this._getSessionRegion(session),
        appointment_id: appt.id,
        practitioner_id: extractIdFromClinikoRef(appt.practitioner, 'practitioners'),
        business_id: extractIdFromClinikoRef(appt.business, 'businesses'),
        appointment_type_id: extractIdFromClinikoRef(appt.appointment_type, 'appointment_types'),
        starts_at: appt.starts_at, ts: Date.now()
      });
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'cancelFlow.cancelSuccess'), await this.goToInteractiveMenu(session));
    }

    // Cancellation failed — send contact/failure email
    try {
      const emailPayload = await this._composeSupportEmailPayloadCancelled(session, data, appt, { failed: true });
      await this._postEmail(emailPayload);
    } catch (e) {
      this.logger.error('[Cancel] Failure email send failed', { error: e?.message || e, sessionId: session.id });
    }
    return prependTextToEnvelope(t(this._getSessionLanguage(session), 'cancelFlow.cancelFailed', { message: result?.message || '' }), await this.goToInteractiveMenu(session));
  }

  /**
   * Handles the client's reply to the 24-hour cancellation-blocked prompt
   * (Main menu / Email us / Message on WhatsApp). See _cancelPresentConfirmation.
   * @param {object} session
   * @param {object} data
   * @param {string} incomingText
   */
  async _handleCancelBlockedDecision(session, data, incomingText) {
    const text = (incomingText || '').trim().toLowerCase();
    const appt = data.selected_cancel_appt;

    const cleanup = async () => {
      delete data.cancel_blocked_prompt;
      delete data.cancel_appt_list;
      delete data.cancel_appt_page;
      delete data.selected_cancel_appt;
      delete data.selected_cancel_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    };

    // 1 (or 0/menu/back) — main menu
    if (text === '1' || ['0', 'menu', 'back'].includes(text)) {
      await cleanup();
      return await this.goToInteractiveMenu(session);
    }

    // 2 — email us (front desk + patient, best-effort)
    if (text === '2') {
      try {
        const emailPayload = await this._composeSupportEmailPayloadCancelBlocked(session, data, appt);
        await this._postEmail(emailPayload);
      } catch (e) {
        this.logger.error('[CancelBlocked] Email send failed', { error: e?.message || e, sessionId: session.id });
      }
      const region = this._getSessionRegion(session);
      this.logger.analyticsEvent({ event: 'handoff_frontdesk', reason: 'cancel_blocked', sessionId: session.id, region, ts: Date.now() });
      await cleanup();
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'appointmentChangeBlocked.frontDeskThanks', { region }), await this.goToInteractiveMenu(session));
    }

    // 3 — message us (open WhatsApp with pre-filled context)
    if (text === '3') {
      const region = this._getSessionRegion(session);
      // _getNoSlotsPhone resolves HK's per-clinic phone from data.selected_clinic —
      // the cancel flow doesn't have that field, so pass an adapter using the
      // enriched appointment's business name instead.
      const phoneLookupData = { ...data, selected_clinic: { business_name: appt?._business_display || '' } };
      const waLink = this._buildWaLink(
        this._getNoSlotsPhone(session, phoneLookupData),
        this._buildAppointmentChangeBlockedSummary(session, appt, 'cancel')
      );
      await cleanup();
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'noSlots.tapToMessageTeam', { region, link: waLink }), await this.goToInteractiveMenu(session));
    }

    // Unknown input — re-render the same blocked prompt with an error prefix
    const language = this._getSessionLanguage(session);
    const intro = appt
      ? t(language, 'cancelFlow.cancellingIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt })
      : t(language, 'cancelFlow.cannotCancelHereFallback');
    return prependTextToEnvelope(t(language, 'appointmentChangeBlocked.replyWith123'), this._renderAppointmentChangeBlockedPrompt(intro, 'cancelled', session));
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
      return t(this._getSessionLanguage(session), 'rescheduleFlow.needVerification');
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
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'rescheduleFlow.noUpcomingAppointments'), await this.goToInteractiveMenu(session));
    }

    futureAppts = await enrichAppointmentsForDisplay(futureAppts, this.clinikoAPI, this._regionTz(session), this._getSessionLanguage(session));

    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    data.reschedule_appt_list = futureAppts;
    data.reschedule_appt_page = 0;
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

    return buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
      header: t(this._getSessionLanguage(session), 'cancelFlow.upcomingAppointmentsHeader'),
      items: futureAppts,
      rowFn: (appt) => ({
        title: appt._practitioner_display || t(this._getSessionLanguage(session), 'cancelFlow.appointmentFallback'),
        description: `${appt._appointment_type_display} — ${appt._display_dt}`.slice(0, 72)
      }),
      page: 0
    });
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
      delete data.reschedule_appt_page;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return await this.goToInteractiveMenu(session);
    }
    const renderRescheduleList = async (page) => {
      data.reschedule_appt_page = page;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return buildInteractiveSelectionList({ language: this._getSessionLanguage(session),
        header: t(this._getSessionLanguage(session), 'cancelFlow.upcomingAppointmentsHeader'),
        items: appts,
        rowFn: (appt) => ({
          title: appt._practitioner_display || t(this._getSessionLanguage(session), 'cancelFlow.appointmentFallback'),
          description: `${appt._appointment_type_display} — ${appt._display_dt}`.slice(0, 72)
        }),
        page
      });
    };
    if (/^p(rev)?$/i.test(text)) return renderRescheduleList(Math.max(0, (Number(data.reschedule_appt_page) || 0) - 1));
    if (/^m(ore)?$|^next$/i.test(text)) return renderRescheduleList((Number(data.reschedule_appt_page) || 0) + 1);
    const page = Number(data.reschedule_appt_page) || 0;
    const pageStart = interactivePageStart(page);
    const pageSize = interactivePageSize(page);
    const localNum = parseInt(text, 10);
    const idx = pageStart + localNum - 1;
    if (isNaN(localNum) || localNum < 1 || localNum > Math.min(pageSize, appts.length - pageStart) || !appts[idx]) {
      return t(this._getSessionLanguage(session), 'rescheduleFlow.invalidSelection');
    }
    data.selected_reschedule_appt = appts[idx];
    data.selected_reschedule_appt_idx = idx;
    await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    return await this._rescheduleShowConfirm(session, data, false);
  }

  /**
   * Step 1 of reschedule: show appointment details and ask for YES/NO confirmation.
   * Transitions to RESCHEDULE_CONFIRM_INTENT state.
   */
  async _rescheduleShowConfirm(session, data, isSingle) {
    const language = this._getSessionLanguage(session);
    const appt = data.selected_reschedule_appt;
    if (!appt) {
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return prependTextToEnvelope(t(language, 'cancelFlow.couldNotFindAppointment'), await this.goToInteractiveMenu(session));
    }
    data.is_single_reschedule_appt = isSingle;

    const intro = isSingle
      ? t(language, 'rescheduleFlow.oneUpcomingIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt })
      : t(language, 'rescheduleFlow.selectedToRescheduleIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt });

    if (this._isAppointmentChangeBlockedByPolicy(appt)) {
      data.reschedule_blocked_prompt = true;
      await this.sessionManager.updateSession(session.id, {
        conversation_state: this.STATES.RESCHEDULE_CONFIRM_INTENT,
        data: JSON.stringify(data)
      });
      return this._renderAppointmentChangeBlockedPrompt(intro, 'rescheduled', session);
    }

    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.RESCHEDULE_CONFIRM_INTENT,
      data: JSON.stringify(data)
    });
    return buttons(`${intro}\n\n${t(language, 'rescheduleFlow.wouldYouLikeToProceed')}`, [
      { id: 'yes', title: t(language, 'rescheduleFlow.yesRescheduleButton') },
      { id: '0',   title: t(language, 'slotSelection.goBackButton') }
    ]);
  }

  /**
   * Step 2 of reschedule: fetch available slots and show the paginated list.
   * Transitions to CONFIRM_RESCHEDULE state.
   */
  async _rescheduleFetchAndShowSlots(session, data) {
    const language = this._getSessionLanguage(session);
    const appt = data.selected_reschedule_appt;
    if (!appt) {
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return prependTextToEnvelope(t(language, 'cancelFlow.couldNotFindAppointment'), await this.goToInteractiveMenu(session));
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
        t(language, 'rescheduleFlow.notEnoughInfo') + '\n\n' +
        await this.goToInteractiveMenu(session)
      );
    }
    const { from, to } = normalizeDateWindow();
    let availableTimes;
    let fetchFailed = false;
    try {
      availableTimes = await this.clinikoAPI.getAvailableTimes({
        practitioner_id,
        business_id,
        appt_type: appointment_type_id,
        from,
        to,
      });
    } catch (err) {
      // getAvailableTimes rethrows on failure (unlike getAvailableSlotsByBusinessAndDate,
      // which swallows to []) — previously this propagated uncaught to handleMessage's
      // top-level catch, surfacing a generic "something went wrong" error instead of
      // the no-slots retry prompt below. Treat it the same as a confirmed-empty result
      // but flagged as a possible transient failure.
      this.logger.error('_rescheduleFetchAndShowSlots: getAvailableTimes failed', { error: err?.message || err?.status || err });
      availableTimes = [];
      fetchFailed = true;
    }
    if (!availableTimes.length) {
      // Retry always routes back through handleSelectAppointmentToRescheduleState
      // (this flow isn't selection_step-driven like the other booking handlers —
      // _rescheduleFetchAndShowSlots is only reachable via an explicit 'yes' in
      // RESCHEDULE_CONFIRM_INTENT, not a retry_step). Preserve reschedule_appt_list
      // so Try Again shows the same appointment list instead of an empty one; the
      // user re-picks rather than the exact fetch silently re-running.
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      return await this._noSlotsRetry(session, data, this.STATES.SELECT_APPOINTMENT_TO_RESCHEDULE, {
        context: 'reschedule',
        result: fetchFailed ? Object.assign([], { _partial: true }) : availableTimes,
        confirmedMessage: t(language, 'rescheduleFlow.noSlotsForReschedule'),
      });
    }
    data.available_times = availableTimes;
    data.slot_page = 0;
    await this.sessionManager.updateSession(session.id, {
      conversation_state: this.STATES.CONFIRM_RESCHEDULE,
      data: JSON.stringify(data)
    });
    const intro = data.is_single_reschedule_appt
      ? t(language, 'rescheduleFlow.oneUpcomingIntroPlain', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt })
      : t(language, 'rescheduleFlow.selectedToRescheduleIntroPlain', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt });
    const header = intro + '\n\n' + t(language, 'rescheduleFlow.chooseNewSlotSuffix');
    return this._buildSlotList(availableTimes, 0, header, this._regionTz(session), language);
  }

  /**
   * Handle the reschedule intent confirmation (YES/NO before slot list is shown).
   */
  async handleRescheduleIntentConfirmState(session, message) {
    const text = (message || '').trim().toLowerCase();
    let data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});
    const appt = data.selected_reschedule_appt;

    if (data.reschedule_blocked_prompt) {
      return await this._handleRescheduleBlockedDecision(session, data, message);
    }

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
    const language = this._getSessionLanguage(session);
    if (!appt) {
      delete data.reschedule_appt_list;
      delete data.selected_reschedule_appt;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return prependTextToEnvelope(t(language, 'cancelFlow.couldNotFindAppointment'), await this.goToInteractiveMenu(session));
    }
    const intro = data.is_single_reschedule_appt
      ? t(language, 'rescheduleFlow.oneUpcomingIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt })
      : t(language, 'rescheduleFlow.selectedToRescheduleIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt });
    return prependTextToEnvelope(
      t(language, 'rescheduleFlow.replyYesOrBack'),
      buttons(`${intro}\n\n${t(language, 'rescheduleFlow.wouldYouLikeToProceed')}`, [
        { id: 'yes', title: t(language, 'rescheduleFlow.yesRescheduleButton') },
        { id: '0',   title: t(language, 'slotSelection.goBackButton') }
      ])
    );
  }

  /**
   * Handles the client's reply to the 24-hour reschedule-blocked prompt
   * (Main menu / Email us / Message on WhatsApp). See _rescheduleShowConfirm.
   * @param {object} session
   * @param {object} data
   * @param {string} incomingText
   */
  async _handleRescheduleBlockedDecision(session, data, incomingText) {
    const text = (incomingText || '').trim().toLowerCase();
    const appt = data.selected_reschedule_appt;

    const cleanup = async () => {
      delete data.reschedule_blocked_prompt;
      delete data.reschedule_appt_list;
      delete data.reschedule_appt_page;
      delete data.selected_reschedule_appt;
      delete data.selected_reschedule_appt_idx;
      delete data.is_single_reschedule_appt;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
    };

    // 1 (or 0/menu/back) — main menu
    if (text === '1' || ['0', 'menu', 'back'].includes(text)) {
      await cleanup();
      return await this.goToInteractiveMenu(session);
    }

    // 2 — email us (front desk + patient, best-effort)
    if (text === '2') {
      try {
        const emailPayload = await this._composeSupportEmailPayloadRescheduleBlocked(session, data, appt);
        await this._postEmail(emailPayload);
      } catch (e) {
        this.logger.error('[RescheduleBlocked] Email send failed', { error: e?.message || e, sessionId: session.id });
      }
      const region = this._getSessionRegion(session);
      this.logger.analyticsEvent({ event: 'handoff_frontdesk', reason: 'reschedule_blocked', sessionId: session.id, region, ts: Date.now() });
      await cleanup();
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'appointmentChangeBlocked.frontDeskThanks', { region }), await this.goToInteractiveMenu(session));
    }

    // 3 — message us (open WhatsApp with pre-filled context)
    if (text === '3') {
      const region = this._getSessionRegion(session);
      // _getNoSlotsPhone resolves HK's per-clinic phone from data.selected_clinic —
      // the reschedule flow doesn't have that field, so pass an adapter using
      // the enriched appointment's business name instead.
      const phoneLookupData = { ...data, selected_clinic: { business_name: appt?._business_display || '' } };
      const waLink = this._buildWaLink(
        this._getNoSlotsPhone(session, phoneLookupData),
        this._buildAppointmentChangeBlockedSummary(session, appt, 'reschedule')
      );
      await cleanup();
      return prependTextToEnvelope(t(this._getSessionLanguage(session), 'noSlots.tapToMessageTeam', { region, link: waLink }), await this.goToInteractiveMenu(session));
    }

    // Unknown input — re-render the same blocked prompt with an error prefix
    const language = this._getSessionLanguage(session);
    const intro = appt
      ? t(language, 'rescheduleFlow.youAreReschedulingIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt })
      : t(language, 'rescheduleFlow.cannotRescheduleHereFallback');
    return prependTextToEnvelope(t(language, 'appointmentChangeBlocked.replyWith123'), this._renderAppointmentChangeBlockedPrompt(intro, 'rescheduled', session));
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
    const language = this._getSessionLanguage(session);
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
        ? t(language, 'rescheduleFlow.youAreReschedulingIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt }) + '\n\n' + t(language, 'rescheduleFlow.chooseNewSlotSuffix')
        : t(language, 'rescheduleFlow.chooseNewSlotSuffix');
      return this._buildSlotList(availableTimes, slot_page, rescheduleHeader, this._regionTz(session), language);
    }

    // Pagination — previous
    if (['p', 'prev'].includes(text.toLowerCase())) {
      slot_page = Math.max(0, slot_page - 1);
      data.slot_page = slot_page;
      await this.sessionManager.updateSession(session.id, { conversation_state: this.STATES.CONFIRM_RESCHEDULE, data: JSON.stringify(data) });
      const rescheduleHeader = appt
        ? t(language, 'rescheduleFlow.youAreReschedulingIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt }) + '\n\n' + t(language, 'rescheduleFlow.chooseNewSlotSuffix')
        : t(language, 'rescheduleFlow.chooseNewSlotSuffix');
      return this._buildSlotList(availableTimes, slot_page, rescheduleHeader, this._regionTz(session), language);
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
      return t(language, 'rescheduleFlow.invalidSlotSelection') +
        (appt ? '\n\n' + t(language, 'rescheduleFlow.youAreReschedulingIntro', { physio: appt._practitioner_display, type: appt._appointment_type_display, date: appt._display_dt }) : '');
    }

    const slot = availableTimes[idx];
    const appointment_type_id = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
    const business_id = extractIdFromClinikoRef(appt.business, 'businesses');
    const patient_id = session.patient_id;
    const practitioner_id = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
    const starts_at = slot.starts_at || slot.appointment_start || slot.slot;
    let ends_at = slot.ends_at || slot.appointment_end;
    if (!ends_at && appt.starts_at && appt.ends_at) {
      // Cliniko's available_times API never returns appointment_end.
      // Derive the correct duration from the original appointment rather than guessing 30 min.
      const origDuration = new Date(appt.ends_at).getTime() - new Date(appt.starts_at).getTime();
      if (origDuration > 0) ends_at = new Date(new Date(starts_at).getTime() + origDuration).toISOString();
    }

    if (!business_id || !practitioner_id || !appointment_type_id || !patient_id || !starts_at) {
      delete data.reschedule_appt_list; delete data.selected_reschedule_appt; delete data.selected_reschedule_appt_idx; delete data.available_times; delete data.slot_page;
      await this.sessionManager.updateSession(session.id, { data: JSON.stringify(data) });
      return t(language, 'rescheduleFlow.missingDetails');
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
      this.logger.analyticsEvent({
        event: 'reschedule_confirmed', sessionId: session.id, region: this._getSessionRegion(session),
        appointment_id: appt.id, practitioner_id: payload.practitioner_id, business_id: payload.business_id,
        appointment_type_id: payload.appointment_type_id, starts_at: payload.starts_at, ts: Date.now()
      });
      return prependTextToEnvelope(t(language, 'rescheduleFlow.rescheduleSuccess', { datetime: formatSlotDateTime(starts_at, this._regionTz(session)) }), await this.goToInteractiveMenu(session));
    }

    // Reschedule failed — send contact/failure email
    try {
      const newApptSummary = { starts_at, practitioner: appt._practitioner_display, clinic: appt._business_display, appointment_type: appt._appointment_type_display };
      const emailPayload = await this._composeSupportEmailPayloadRescheduled(session, data, appt, newApptSummary, { failed: true });
      await this._postEmail(emailPayload);
    } catch (e) {
      this.logger.error('[Reschedule] Failure email send failed', { error: e?.message || e, sessionId: session.id });
    }
    return prependTextToEnvelope(t(language, 'rescheduleFlow.rescheduleFailed', { message: result?.message || '' }), await this.goToInteractiveMenu(session));
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
    const clinicObj = d.selected_clinic || d.prev_state_data?.selected_clinic;
    const clinicName = clinicObj?.business_name || (typeof clinicObj === 'string' ? clinicObj : '');
    const regionDesk = (typeof REGION_SUPPORT_INFO === 'object' && REGION_SUPPORT_INFO && REGION_SUPPORT_INFO[region] && REGION_SUPPORT_INFO[region].email)
      ? this._resolveSupportEmail(region, clinicName) : null;
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
    const supportEmail = this._resolveSupportEmail(region, appt?._business_display || appt?.clinic);

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
   * Build the email payload for a cancellation blocked by the 24-hour policy.
   * Uses the HTML template from EmailTemplates.js. Unlike
   * _composeSupportEmailPayloadCancelled({failed:true}), this does not reuse
   * the "cancelled" template — the appointment was never actually cancelled,
   * so that copy would be misleading.
   *
   * @param {object} session
   * @param {object} data - parsed session.data
   * @param {object} appt - enriched appointment object
   * @returns {Promise<{to:string[], subject:string, html:string, text:string}>}
   */
  async _composeSupportEmailPayloadCancelBlocked(session, data, appt) {
    const s   = session || {};
    const d   = (data && typeof data === 'object') ? data : (() => { try { return JSON.parse(s.data || '{}'); } catch { return {}; } })();
    const ctx = (() => { try { return typeof s.context === 'string' ? JSON.parse(s.context) : (s.context || {}); } catch { return {}; } })();

    const region     = String(ctx.region || d.region || 'SG').trim();
    const phone      = String(s.phone_number || s.phoneNumber || d.phone || '').trim();
    const supportEmail = this._resolveSupportEmail(region, appt?._business_display || appt?.clinic);

    const userEmail = String(ctx.email || s.email || d.email || appt?.patient_email || '').trim();

    const to = [];
    if (supportEmail) to.push(supportEmail);
    if (userEmail)    to.push(userEmail);

    const practitioner = appt?._practitioner_display || appt?.practitioner || '—';
    const clinic       = appt?._business_display      || appt?.clinic       || '—';
    const dateTime     = appt?.starts_at ? formatSlotDateTime(appt.starts_at, this._regionTz(session)) : '—';
    const apptType     = appt?._appointment_type_display || appt?.appointment_type || '';

    const { subject, html, text } = cancellationBlocked({ practitioner, clinic, dateTime, apptType });

    const prefixedSubject = `[Cancel Blocked — 24h] ${region} — ${phone || userEmail || 'unknown'} — ${subject}`;

    return { to, subject: prefixedSubject, html, text };
  }

  /**
   * Build the email payload for a reschedule blocked by the 24-hour policy.
   * Uses the HTML template from EmailTemplates.js. Mirrors
   * _composeSupportEmailPayloadCancelBlocked — see that method's note on why
   * the "rescheduled" template is not reused here.
   *
   * @param {object} session
   * @param {object} data - parsed session.data
   * @param {object} appt - enriched appointment object
   * @returns {Promise<{to:string[], subject:string, html:string, text:string}>}
   */
  async _composeSupportEmailPayloadRescheduleBlocked(session, data, appt) {
    const s   = session || {};
    const d   = (data && typeof data === 'object') ? data : (() => { try { return JSON.parse(s.data || '{}'); } catch { return {}; } })();
    const ctx = (() => { try { return typeof s.context === 'string' ? JSON.parse(s.context) : (s.context || {}); } catch { return {}; } })();

    const region     = String(ctx.region || d.region || 'SG').trim();
    const phone      = String(s.phone_number || s.phoneNumber || d.phone || '').trim();
    const supportEmail = this._resolveSupportEmail(region, appt?._business_display || appt?.clinic);

    const userEmail = String(ctx.email || s.email || d.email || appt?.patient_email || '').trim();

    const to = [];
    if (supportEmail) to.push(supportEmail);
    if (userEmail)    to.push(userEmail);

    const practitioner = appt?._practitioner_display || appt?.practitioner || '—';
    const clinic       = appt?._business_display      || appt?.clinic       || '—';
    const dateTime     = appt?.starts_at ? formatSlotDateTime(appt.starts_at, this._regionTz(session)) : '—';
    const apptType     = appt?._appointment_type_display || appt?.appointment_type || '';

    const { subject, html, text } = rescheduleBlocked({ practitioner, clinic, dateTime, apptType });

    const prefixedSubject = `[Reschedule Blocked — 24h] ${region} — ${phone || userEmail || 'unknown'} — ${subject}`;

    return { to, subject: prefixedSubject, html, text };
  }

  /**
   * Pre-filled WhatsApp message text for the "Message on WhatsApp" option on
   * the 24-hour appointment-change-blocked prompt (cancel or reschedule).
   * @param {object} session
   * @param {object} appt - enriched appointment object
   * @param {'cancel'|'reschedule'} action
   */
  _buildAppointmentChangeBlockedSummary(session, appt, action) {
    const userPhone = session.phone_number || session.phoneNumber || '';
    const practitioner = appt?._practitioner_display || '';
    const clinic = appt?._business_display || '';
    const dt = appt?._display_dt || '';

    let msg = `Hi, I wanted to ${action} my appointment`;
    if (practitioner) msg += ` with ${practitioner}`;
    if (clinic) msg += ` at ${clinic}`;
    if (dt) msg += ` (${dt})`;
    msg += ", but it's within 24 hours so the bot could not process it.";
    if (userPhone) msg += ` My WhatsApp: ${userPhone}.`;
    return msg;
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
    const supportEmail = this._resolveSupportEmail(region, oldAppt?._business_display || oldAppt?.clinic);

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
