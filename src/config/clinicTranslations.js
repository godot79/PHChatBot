// Cliniko business/clinic display names -> Chinese equivalents (Cantonese/Mandarin
// share the same names here, no yue/zh split needed). Display-only: matching against
// Cliniko always uses the raw English business_name. HK clinics only (confirmed by
// Alicia, physio, 2026-07-31/08-10 — clinic-name portion of PDF review).
//
// 2026-08-28: these were originally keyed by generic location names (e.g.
// "Wellington Street, Central") that never matched Cliniko's actual
// business_name field — which always includes the "Prohealth Sports and/&
// Spinal Physiotherapy Centre(s) (ABBREV)" branding and a per-clinic
// abbreviation. Result: every clinic name fell back to English, 100% of the
// time, in every yue/zh flow. Rekeyed against live Cliniko business_name
// strings (confirmed exact, including the "&" vs "and" and singular
// "Centre" (QB) vs plural "Centres" inconsistencies Cliniko itself has).
const CLINIC_TRANSLATIONS = {
  'Prohealth Sports & Spinal Physiotherapy Centres (WS)': '中環威靈頓街',
  'Prohealth Sports and Spinal Physiotherapy Centres (WWH)': '中環環球大廈',
  'Prohealth Sports and Spinal Physiotherapy Centres (TST)': '尖沙咀海洋中心',
  'Prohealth Sports and Spinal Physiotherapy Centre (QB)': '鰂魚涌太古坊',
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
