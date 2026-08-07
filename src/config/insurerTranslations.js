// Cliniko `category` insurer brand names -> Chinese equivalents (Cantonese/Mandarin
// share the same brand names here, no yue/zh split needed). Display-only: matching
// against Cliniko always uses the raw English name in data.selected_appt_type.insurer.
const INSURER_TRANSLATIONS = {
  'Bupa Global': '保柏環球',
  'Bupa HealthNet': '保柏 HealthNet',
  'Cigna International': '信諾環球',
  'AXA PPP': 'AXA安盛',
  // April International has no established Chinese brand name (researched 2026-08-06,
  // confirmed absent) — falls through to English via the lookup miss below.
};

/**
 * Any insurer not in the table (April International, or a future new one) renders
 * in English and logs a warning, so a missing translation surfaces instead of
 * silently staying English forever. Never blocks booking.
 */
function translateInsurerName(name, language, logger) {
  if (!name || language === 'en') return name;
  const translated = INSURER_TRANSLATIONS[name];
  if (translated) return translated;
  if (logger) logger.warn(`No ${language} translation for insurer "${name}"`);
  return name;
}

module.exports = { INSURER_TRANSLATIONS, translateInsurerName };
