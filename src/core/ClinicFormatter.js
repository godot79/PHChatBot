'use strict';

/**
 * Build a Google Maps search URL from clinic name and address parts.
 * Returns null if there is no searchable text.
 * @param {string} name
 * @param {string[]} addrParts
 * @returns {string|null}
 */
function buildGoogleMapsLink(name, addrParts) {
  const query = [name, ...addrParts].filter(Boolean).join(', ').trim();
  if (!query) return null;
  return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
}

/**
 * Extract the first telephone number from a Cliniko contact_information string.
 * The field is free text, e.g. "Telephone: +65 6533 0968\nWhatsApp: ..."
 * Returns null if not found.
 * @param {string|null|undefined} contactInfo
 * @returns {string|null}
 */
function extractPhone(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/(?:Telephone|Tel|Phone):\s*(.+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Format a single Cliniko business object into a clean WhatsApp-readable string.
 * Gracefully handles missing optional fields.
 * @param {object} clinic
 * @returns {string}
 */
function formatClinicForWhatsApp(clinic) {
  const lines = [];

  lines.push(`*${clinic.business_name}*`);

  const addrParts = [
    clinic.address_1,
    clinic.address_2,
    clinic.city && clinic.post_code ? `${clinic.city} ${clinic.post_code}` : (clinic.city || clinic.post_code),
  ].filter(Boolean);

  if (addrParts.length) lines.push(addrParts.join(', '));

  const phone = extractPhone(clinic.contact_information);
  if (phone) lines.push(`📞 ${phone}`);

  const mapsLink = buildGoogleMapsLink(clinic.business_name, addrParts);
  if (mapsLink) lines.push(`📍 ${mapsLink}`);

  return lines.join('\n');
}

module.exports = { buildGoogleMapsLink, extractPhone, formatClinicForWhatsApp };
