// Cliniko practitioner display names -> Chinese given names (Cantonese/Mandarin share
// the same names here, no yue/zh split needed). Display-only: matching against Cliniko
// always uses the raw English name/id. HK clinics only.
//
// PENDING SPOT-CHECK (2026-08-11): the 25 base entries below were transcribed from
// ~/Downloads/Physio_Chinese_Names_Verification.pdf (a screenshot-rendered PDF, see
// project-i18n-canto-mandarin-phases memory's "PDF-generation gotcha" note) — unlike
// the 5 clinic names in clinicTranslations.js, these were not independently
// cross-confirmed a second time. Flagged for a human read-through (Alicia or the
// user) before this ships to real users, same review step clinic names already had.
// Do not treat this file as fully confirmed until that pass happens.
//
// 5 entries (Kris Chow, Annika Leung, Bonnie Ung, Kelvin Yau, Kelvin Young) were
// resolved separately via a live Cliniko + website re-verification on 2026-08-06
// (see memory) and are NOT part of the pending spot-check — those are already
// double-confirmed.
const PRACTITIONER_TRANSLATIONS = {
  // WS
  'Leo Choi': '蔡楚基',
  'Maritza Lai': '雷小嫱',
  'Wing Cheung': '張詠瑜',
  'Louis Lee': '李耀漢',
  'Amanda Ko': '葛妍彤',
  'Carmen Ku': '顧芷慜',
  'Stanley Ho': '何晉熙',
  'Hazel Chan': '陳海瑩',
  // WS / WWH / TST (shared across clinics, one Cliniko record each)
  'Angela Leung': '梁曉惠',
  'Yolanda Chan': '陳慧欣',
  // WWH
  'Christy Lam': '林芷妍',
  'Michael Pan': '潘今立',
  'Chloe Lau': '劉洛鏡',
  'Meredith Cheng': '鄭美姿',
  'Arnold Tseng': '曾子瑜',
  'Cliff Chan': '陳正謙',
  'Sandy Lee': '李理儀',
  'Brian Chan': '陳沛行',
  // QB
  'Candice Fan': '范倩鳴',
  'Dario Tam': '譚宇哲',
  'Dickson Lee': '李文迪',
  'Pinky Chan': '陳展晴',
  'Yi Fan Jia': '賈一凡',
  'Brian Cheung': '張偉維',
  // TST
  'Alicia Lam': '林雅莉',

  // Resolved 2026-08-06 (live Cliniko + website re-verification, double-confirmed —
  // not part of the pending spot-check above). Kris/Annika/Bonnie superseded the
  // PDF's original "looks like a transliteration" flag with a real given name found
  // on a fresh site scrape; Kelvin Yau/Young confirmed as two distinct people.
  'Kris Chow': '鄒景康',
  'Annika Leung': '梁慧晴',
  'Bonnie Ung': '吳婷婷',
  'Kelvin Yau': '邱子豐',
  'Kelvin Young': '楊凱程',

  // Greg Lock, Suki Law, Yashmita Changlani, Etienne Simonnet: confirmed to have no
  // real Chinese given name (website shows a phonetic transliteration or nothing) —
  // deliberately absent from this table, falls through to English via the lookup
  // miss below, same as any future new hire not yet added.
};

/**
 * Any practitioner not in the table (a new hire, or one of the confirmed
 * no-Chinese-name cases above) renders in English and logs a warning, so a missing
 * translation surfaces for manual follow-up instead of silently staying English
 * forever. Never blocks booking.
 */
function translatePractitionerName(name, language, logger) {
  if (!name || language === 'en') return name;
  const translated = PRACTITIONER_TRANSLATIONS[name];
  if (translated) return translated;
  if (logger) logger.warn(`No ${language} translation for practitioner "${name}"`);
  return name;
}

module.exports = { PRACTITIONER_TRANSLATIONS, translatePractitionerName };
