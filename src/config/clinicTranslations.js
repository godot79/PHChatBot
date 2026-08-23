// Cliniko business/clinic display names -> Chinese equivalents (Cantonese/Mandarin
// share the same names here, no yue/zh split needed). Display-only: matching against
// Cliniko always uses the raw English business_name. HK clinics only (confirmed by
// Alicia, physio, 2026-07-31/08-10 — clinic-name portion of PDF review).
const CLINIC_TRANSLATIONS = {
  'Prohealth Sports and Spinal Physiotherapy Centres': 'Prohealth 運動與脊椎物理治療中心',
  'Ocean Centre, Tsim Sha Tsui': '尖沙咀海洋中心',
  'World Wide House, Central': '中環環球大廈',
  'Wellington Street, Central': '中環威靈頓街',
  'Tai Koo Place, Quarry Bay': '鰂魚涌太古坊',
};

/**
 * Any clinic name not in the table renders in English and logs a warning, so a
 * missing translation surfaces instead of silently staying English forever.
 * Never blocks booking.
 */
function translateClinicName(name, language, logger) {
  if (!name || language === 'en') return name;
  const translated = CLINIC_TRANSLATIONS[name];
  if (translated) return translated;
  if (logger) logger.warn(`No ${language} translation for clinic "${name}"`);
  return name;
}

module.exports = { CLINIC_TRANSLATIONS, translateClinicName };
