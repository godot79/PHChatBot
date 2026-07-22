'use strict';

/**
 * Parallel Cliniko helpers for appointment-type and practitioner lookups.
 * All three functions are pure (no module-level state) so they can be
 * required directly by tests without going through ChatbotEngine.
 */

const { bulkAll } = require('./BulkContext');

// Same non-enumerable _partial convention as ClinikoAPI.js — a caller-supplied
// clinikoAPI is not guaranteed to be the real resilient class (tests inject
// plain mocks), so these fan-outs defend their own per-call failures rather
// than assuming the injected API never rejects.
function _markPartial(arr) {
  Object.defineProperty(arr, '_partial', { value: true, enumerable: false, configurable: true });
  return arr;
}

/**
 * Fetch appointment types for every practitioner in parallel and return a
 * deduplicated union, preserving first-seen order. A practitioner whose fetch
 * fails contributes nothing (rather than failing the whole lookup); the
 * result is marked _partial so callers can tell that apart from a confirmed
 * "no types anywhere" result.
 */
async function getAllAppointmentTypesForAllPractitioners(clinikoAPI, groups) {
  const seen = new Set();
  const result = [];
  const allPractitioners = (groups || []).flatMap(g => g.practitioners || []);
  let hadFailure = false;
  const allTypes = await bulkAll(allPractitioners, p =>
    clinikoAPI.getAppointmentTypes({ practitioner_id: p.id }).catch(() => {
      hadFailure = true;
      return [];
    })
  );
  for (const types of allTypes) {
    for (const t of (types || [])) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        result.push(t);
      }
    }
  }
  return hadFailure ? _markPartial(result) : result;
}

/**
 * Return all unique practitioners who offer the given appointment type ID.
 * Compares IDs as strings — Cliniko may return numeric IDs. A single
 * practitioner's fetch failing no longer discards the others (see
 * getAllAppointmentTypesForAllPractitioners); result is tagged _partial.
 */
async function getPractitionersForType(groups, clinikoAPI, apptTypeId) {
  const targetId = String(apptTypeId);
  const result = [];
  const practitioners = [...new Map(
    (groups || []).flatMap(g => g.practitioners || []).map(p => [p.id, p])
  ).values()];
  let hadFailure = false;
  const allTypes = await bulkAll(practitioners, p =>
    clinikoAPI.getAppointmentTypes({ practitioner_id: p.id }).catch(() => {
      hadFailure = true;
      return [];
    })
  );
  practitioners.forEach((p, i) => {
    if ((allTypes[i] || []).some(t => String(t.id) === targetId)) result.push(p);
  });
  return hadFailure ? _markPartial(result) : result;
}

/**
 * Return all practitioners who offer an appointment type by NAME.
 * Type IDs differ per practitioner for the same label, so ID matching is
 * insufficient. A single practitioner's fetch failing no longer discards
 * the others; result is tagged _partial.
 */
async function getPractitionersForTypeName(groups, clinikoAPI, apptTypeName) {
  const normalize = (s) => String(s || '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-') // Unicode dashes → ASCII hyphen
    .replace(/-/g, ' ')               // hyphens → spaces (same as normalizeTypeName)
    .replace(/\s+/g, ' ')
    .trim();

  const target = normalize(apptTypeName);
  const result = [];
  const practitioners = [...new Map(
    (groups || []).flatMap(g => g.practitioners || []).map(p => [p.id, p])
  ).values()];
  let hadFailure = false;
  const allTypes = await bulkAll(practitioners, p =>
    clinikoAPI.getAppointmentTypes({ practitioner_id: p.id }).catch(() => {
      hadFailure = true;
      return [];
    })
  );
  practitioners.forEach((p, i) => {
    if ((allTypes[i] || []).some(t => normalize(t.name) === target)) result.push(p);
  });
  return hadFailure ? _markPartial(result) : result;
}

/**
 * Parse a Cliniko category field into service and insurer parts.
 * Format: "Insurer : Service" (insured) or "Service" (self-pay).
 */
function parseApptCategory(category) {
  const s = (category || '').trim();
  const i = s.indexOf(' : ');
  if (i !== -1) return { insurer: s.slice(0, i).trim(), service: s.slice(i + 3).trim() };
  return { insurer: null, service: s };
}

/**
 * Parse patient type from a Cliniko appointment name.
 * Returns 'new', 'follow_up', or null (e.g. for generic self-pay types).
 */
function parseApptPatientType(name) {
  if (/new\s*patient/i.test(name)) return 'new';
  if (/follow.?up/i.test(name)) return 'follow_up';
  return null;
}

/**
 * Build a flat catalogue from raw Cliniko appointment types, suitable for
 * the 3-step funnel. Filters out UWC and Online Booking types.
 *
 * @param {Array<{id, name, category, duration_in_minutes}>} rawTypes
 * @returns {Array<{id, name, service, insurer, patientType, duration}>}
 */
function buildFunnelCatalogue(rawTypes) {
  return (rawTypes || [])
    .filter(t => t && t.name && !/UWC/i.test(t.name) && !/online\s*booking/i.test(t.name))
    .map(t => {
      const { service, insurer } = parseApptCategory(t.category);
      return {
        id: String(t.id),
        name: String(t.name).replace(/\s+/g, ' ').trim(),
        service,
        insurer,
        patientType: parseApptPatientType(t.name),
        duration: t.duration_in_minutes,
      };
    });
}

/**
 * Resolve funnel selections to a selected_appt_type object.
 * Collects all matching IDs (one per practitioner) under a single display name.
 *
 * @param {ReturnType<buildFunnelCatalogue>} catalogue
 * @param {{ service: string, patientType: string, insurer: string|null, duration: number }} sel
 * @returns {{ name: string, ids: string[], norm_name: string } | null}
 */
function resolveApptFromFunnel(catalogue, { service, patientType, insurer, duration }) {
  const matches = catalogue.filter(t =>
    t.service === service &&
    t.patientType === patientType &&
    (t.insurer || null) === (insurer || null) &&
    t.duration === duration
  );
  if (!matches.length) return null;
  const name = matches[0].name;
  const ids  = [...new Set(matches.map(t => t.id))];
  // Must match normalizeTypeName's hyphen-stripping (ChatbotEngine.js) — this
  // norm_name becomes handleBookSoonest's typeNorm, compared against slot
  // type names normalized the same way. Without stripping hyphens here, any
  // hyphenated Cliniko type name (e.g. "Follow-Up Appointment-Physiotherapy")
  // never matches, silently zeroing out real availability (confirmed live
  // 2026-07-21/22 — hundreds of real slots existed, app reported none).
  const norm_name = name
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { name, ids, norm_name };
}

module.exports = {
  getAllAppointmentTypesForAllPractitioners,
  getPractitionersForType,
  getPractitionersForTypeName,
  parseApptCategory,
  parseApptPatientType,
  buildFunnelCatalogue,
  resolveApptFromFunnel,
  _markPartial,
};
