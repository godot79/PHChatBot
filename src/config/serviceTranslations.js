// Cliniko appointment-type `category` service labels (the "Service" half of
// "Insurer : Service", parsed by parseApptCategory in _appointmentTypeHelpers.js)
// -> Chinese equivalents. A distinct data dimension from apptTypeTranslations.js
// (which translates the full appointment-type *name*, e.g. "New Patient-
// Osteopathy") — this table serves the Book Soonest funnel's "what type of
// appointment" category-picker step (ChatbotEngine.js funnelWhatType), which
// reads Cliniko's category field directly and previously had no translation
// at all. Wording reuses the terms already established (and presumably
// clinic-approved) for the same concepts in apptTypeTranslations.js.
//
// GYROTONIC® METHOD is a registered trademark for a specific branded exercise
// method — deliberately left untranslated, same treatment as other brand
// names (e.g. WhatsApp) elsewhere in this app. Not a missing translation.
const SERVICE_TRANSLATIONS = {
  'Clinical Pilates': { yue: '臨床普拉提', zh: '临床普拉提' },
  'Osteopathy': { yue: '整骨治療', zh: '整骨治疗' },
  'Paediatrics': { yue: '兒科', zh: '儿科' },
  'Physiotherapy': { yue: '物理治療', zh: '物理治疗' },
  'Sports Massage Therapy': { yue: '運動按摩治療', zh: '运动按摩治疗' },
  "Women's Health Physiotherapy": { yue: '婦女健康物理治療', zh: '妇女健康物理治疗' },
};

/**
 * Any service not in the table (GYROTONIC® METHOD by design, or a future new
 * category) renders in English and logs a warning, so a missing translation
 * surfaces instead of silently staying English forever. Never blocks booking.
 */
function translateServiceName(name, language, logger) {
  if (!name || language === 'en') return name;
  const entry = SERVICE_TRANSLATIONS[name];
  const translated = entry && entry[language];
  if (translated) return translated;
  if (logger) logger.warn(`No ${language} translation for service "${name}"`);
  return name;
}

module.exports = { SERVICE_TRANSLATIONS, translateServiceName };
