// Cliniko appointment-type names -> Chinese equivalents (Cantonese/Mandarin use
// distinct wording here, unlike clinic/insurer names). Display-only: matching against
// Cliniko always uses normName()'d raw English — this table is keyed the same way so
// name-variant drift (e.g. "Follow Up" vs "Follow-Up") doesn't cause lookup misses.
//
// Source: live Cliniko enumeration across all 4 regions (2026-07-29), tiered by
// confidence in ~/Downloads/Appointment_Type_Translations.pdf. Ships the 33 "certain"
// entries minus one — see exclusion note below. The 5 "doubtful" + 2 "no idea" entries
// from that PDF are deliberately NOT in this table; they fall back to English + a
// logged warning, same as any untabled type, per the 2026-08-06 rollout decision.
//
// EXCLUDED, 2026-08-10: "Clinical Soft Tissue Release Treatment - Manual" was in the
// PDF's "certain" bucket but Alicia flagged it (WhatsApp, 2026-07-31/08-10) as needing
// correction, with no replacement wording supplied yet. Left out of the table entirely
// so it falls back to English + logs a warning until she provides the correct wording -
// do not re-add from the PDF's original 臨床軟組織鬆解治療 - 手法 without her sign-off.

// Same normalization ChatbotEngine.js's normName()/normalizeTypeName() uses, duplicated
// here (not required from ChatbotEngine.js) to keep this a standalone leaf config module.
function normName(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/([A-Za-z])\(/g, '$1 (')
    .replace(/\s+\)/g, ')')
    .replace(/[‐-―]/g, '-')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

const APPT_TYPE_TRANSLATIONS = {
  [normName('Follow Up Appointment')]: { yue: '覆診', zh: '复诊' },
  [normName('Follow-Up Appointment-Clinical Pilates')]: { yue: '覆診 - 臨床普拉提', zh: '复诊 - 临床普拉提' },
  [normName('Follow-Up Appointment-Physiotherapy')]: { yue: '覆診 - 物理治療', zh: '复诊 - 物理治疗' },
  [normName('Follow-Up Appointment-Sports Massage 40 mins')]: { yue: '覆診 - 運動按摩 40分鐘', zh: '复诊 - 运动按摩 40分钟' },
  [normName('Follow-Up Appointment-Sports Massage 60 mins')]: { yue: '覆診 - 運動按摩 60分鐘', zh: '复诊 - 运动按摩 60分钟' },
  [normName('New Patient')]: { yue: '新症', zh: '新患者' },
  [normName('New Patient- Clinical Pilates')]: { yue: '新症 - 臨床普拉提', zh: '新患者 - 临床普拉提' },
  [normName('New Patient- Sports Massage Therapy')]: { yue: '新症 - 運動按摩治療', zh: '新患者 - 运动按摩治疗' },
  [normName('Physiotherapist')]: { yue: '物理治療師', zh: '物理治疗师' },
  [normName('Senior Physiotherapist')]: { yue: '高級物理治療師', zh: '高级物理治疗师' },
  [normName('Sports Massage Therapist')]: { yue: '運動按摩治療師', zh: '运动按摩治疗师' },
  [normName('Assessment')]: { yue: '評估', zh: '评估' },
  [normName('Clinical Cupping Treatment')]: { yue: '臨床拔罐治療', zh: '临床拔罐治疗' },
  [normName('Clinical Dry Needling Treatment')]: { yue: '臨床乾針治療', zh: '临床干针治疗' },
  [normName('Clinical Home Physiotherapy Treatment')]: { yue: '臨床上門物理治療', zh: '临床上门物理治疗' },
  [normName('Clinical Laser Treatment')]: { yue: '臨床激光治療', zh: '临床激光治疗' },
  [normName('Clinical Mobility Treatment')]: { yue: '臨床活動能力治療', zh: '临床活动能力治疗' },
  [normName('Clinical Physiotherapy session 30 mins (online)')]: { yue: '臨床物理治療（線上）30分鐘', zh: '临床物理治疗（线上）30分钟' },
  [normName('Clinical Physiotherapy session 45 min (online)')]: { yue: '臨床物理治療（線上）45分鐘', zh: '临床物理治疗（线上）45分钟' },
  [normName('Clinical Rehab for Injury')]: { yue: '臨床受傷康復治療', zh: '临床受伤康复治疗' },
  [normName('Clinical Senior Mobility Treatment')]: { yue: '臨床長者活動能力治療', zh: '临床长者活动能力治疗' },
  // Clinical Soft Tissue Release Treatment - Manual: deliberately excluded, see note above.
  [normName('Clinical Standard Physiotherapy Treatment')]: { yue: '臨床標準物理治療', zh: '临床标准物理治疗' },
  [normName('Clinical Strength Rehab Treatment')]: { yue: '臨床力量康復治療', zh: '临床力量康复治疗' },
  [normName('Clinical Stretch Therapy')]: { yue: '臨床伸展治療', zh: '临床伸展治疗' },
  [normName('Clinical Ultrasound Session for inflammation relief')]: { yue: '臨床超聲波療程（消炎）', zh: '临床超声波疗程（消炎）' },
  [normName('Follow up Clinical Physiotherapy Treatment')]: { yue: '覆診 - 臨床物理治療', zh: '复诊 - 临床物理治疗' },
  [normName('No Charge')]: { yue: '免費', zh: '免费' },
  [normName('Pre/Post Natal Sessions')]: { yue: '產前/產後療程', zh: '产前/产后疗程' },
  [normName('Pre/Post Natal Single session')]: { yue: '產前/產後單次療程', zh: '产前/产后单次疗程' },
  [normName('Discounted with voucher')]: { yue: '使用禮券折扣', zh: '使用礼券折扣' },
  [normName('Standard - Running Assessment')]: { yue: '標準 – 跑步評估', zh: '标准 – 跑步评估' },
  [normName('Strength & Conditioning')]: { yue: '力量與體能訓練', zh: '力量与体能训练' },
};

/**
 * Any appointment type not in the table (the 5 doubtful/2 no-idea PDF entries,
 * the excluded soft-tissue-release type, or a future new Cliniko type) renders in
 * English and logs a warning, so a missing translation surfaces instead of silently
 * staying English forever. Never blocks booking. Matching/filtering logic elsewhere
 * in the codebase must keep using the raw, untranslated English name — this helper
 * is display-only.
 */
function translateApptTypeName(name, language, logger) {
  if (!name || language === 'en') return name;
  const entry = APPT_TYPE_TRANSLATIONS[normName(name)];
  const translated = entry && entry[language];
  if (translated) return translated;
  if (logger) logger.warn(`No ${language} translation for appointment type "${name}"`);
  return name;
}

module.exports = { APPT_TYPE_TRANSLATIONS, translateApptTypeName, normName };
