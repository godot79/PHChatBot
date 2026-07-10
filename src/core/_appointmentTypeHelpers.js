'use strict';

/**
 * Parallel Cliniko helpers for appointment-type and practitioner lookups.
 * All three functions are pure (no module-level state) so they can be
 * required directly by tests without going through ChatbotEngine.
 */

/**
 * Fetch appointment types for every practitioner in parallel and return a
 * deduplicated union, preserving first-seen order.
 */
async function getAllAppointmentTypesForAllPractitioners(clinikoAPI, groups) {
  const seen = new Set();
  const result = [];
  const allPractitioners = (groups || []).flatMap(g => g.practitioners || []);
  const allTypes = await Promise.all(
    allPractitioners.map(p => clinikoAPI.getAppointmentTypes({ practitioner_id: p.id }))
  );
  for (const types of allTypes) {
    for (const t of (types || [])) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        result.push(t);
      }
    }
  }
  return result;
}

/**
 * Return all unique practitioners who offer the given appointment type ID.
 * Compares IDs as strings — Cliniko may return numeric IDs.
 */
async function getPractitionersForType(groups, clinikoAPI, apptTypeId) {
  const targetId = String(apptTypeId);
  const result = [];
  const practitioners = [...new Map(
    (groups || []).flatMap(g => g.practitioners || []).map(p => [p.id, p])
  ).values()];
  const allTypes = await Promise.all(
    practitioners.map(p => clinikoAPI.getAppointmentTypes({ practitioner_id: p.id }))
  );
  practitioners.forEach((p, i) => {
    if ((allTypes[i] || []).some(t => String(t.id) === targetId)) result.push(p);
  });
  return result;
}

/**
 * Return all practitioners who offer an appointment type by NAME.
 * Type IDs differ per practitioner for the same label, so ID matching is insufficient.
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
  const allTypes = await Promise.all(
    practitioners.map(p => clinikoAPI.getAppointmentTypes({ practitioner_id: p.id }))
  );
  practitioners.forEach((p, i) => {
    if ((allTypes[i] || []).some(t => normalize(t.name) === target)) result.push(p);
  });
  return result;
}

module.exports = {
  getAllAppointmentTypesForAllPractitioners,
  getPractitionersForType,
  getPractitionersForTypeName,
};
