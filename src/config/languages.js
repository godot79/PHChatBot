'use strict';

/**
 * Supported bot languages. Keys are the values stored in context.language /
 * patient_state.language. Labels are self-describing in their own script,
 * since they're shown to a user whose language is not yet known.
 * 'yue' = Cantonese (spoken language, not just Traditional script).
 * 'zh'  = Mandarin, Simplified script.
 */
const LANGUAGE_LABELS = {
  en: 'English',
  yue: '廣東話 (Cantonese)',
  zh: '普通话 (Mandarin)',
};

module.exports = { LANGUAGE_LABELS };
