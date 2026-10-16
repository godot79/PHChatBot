/**
 * Shared matching helpers for booking-funnel slot values (appointment type,
 * practitioner, clinic names, etc.) — used both by the state-machine handlers'
 * own menu-normalization and by NLU slot extraction (Phase 2+) so free-text
 * slot values are matched against menu options with the exact same rules
 * a manual menu pick would use.
 */

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
    .replace(/\s+/g, ' ')
    .replace(/([A-Za-z])\(/g, '$1 (')
    .replace(/\s+\)/g, ')')
    .replace(/[‐-―]/g, '-') // Unicode dashes → ASCII hyphen
    .replace(/-/g, ' ')               // hyphens → spaces so "Follow-Up" === "Follow Up"
    .replace(/\s+/g, ' ')             // collapse any new consecutive spaces
    .toLowerCase()
    .trim();
}

module.exports = { normalizeTypeName };
