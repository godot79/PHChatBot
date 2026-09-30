'use strict';

/**
 * Region-specific support contact details.
 * Used by getSupportInfo() in ChatbotEngine for dead-end escalation and error messages.
 */
const REGION_SUPPORT_INFO = {
  SG: {
    phone: '+65 9111 5623',
    email: 'admin@intouchphysio.com',
  },
  HK: {
    phone: '+852 5542 0407',  // WS (default)
    email: 'appt@physiohk.com',  // WS (default)
    clinicPhones: {
      WS:  '+852 5542 0407',
      WWH: '+852 5422 3760',
      TST: '+852 6946 3575',
      QB:  '+852 8400 1760',
    },
    clinicEmails: {
      WS:  'appt@physiohk.com',
      WWH: 'wwhappt@physiohk.com',
      TST: 'tstappt@physiohk.com',
      QB:  'qbappt@physiohk.com',
    },
  },
  IN: {
    phone: '+91-11-4212-0200',
    email: 'appt@prohealthasia.in',
  },
  PH: {
    phone: '+63 956 914 8260',
    email: 'appt@sportsandspinal.ph',
  },
};

/**
 * Region-specific fee schedules.
 * Each region has an `en` header line and flat item list. `yue`/`zh` are
 * placeholders (null) pending a native-speaker translation pass — not
 * scoped to Phase 2 item 6, which only wires the surrounding wrapper text.
 * getRegionFeesForLanguage() below falls back to `en` when a language
 * variant is missing, so nothing renders blank in the meantime.
 * Used by handleViewFeesState() in ChatbotEngine.
 */
const REGION_FEES = {
  SG: {
    en: {
      header: '*Fees (45-min sessions):*',
      items: [
        'Senior Physio: SGD 230',
        'Physio: SGD 200',
      ],
    },
    yue: null, // TODO: needs native-speaker translation
    zh: null,  // TODO: needs native-speaker translation
  },
  HK: {
    en: {
      header: '*Fees (HKD):*',
      items: [
        'Initial Physio: 1,450',
        'Follow-up Physio: 1,450',
        'Sports Massage: 900',
        'Clinical Pilates: 1,450',
      ],
    },
    yue: {
      header: '*收費（港幣）：*',
      items: [
        '首次物理治療：1,450',
        '覆診物理治療：1,450',
        '運動按摩：900',
        '臨床普拉提：1,450',
      ],
    },
    zh: {
      header: '*收费（港币）：*',
      items: [
        '首次物理治疗：1,450',
        '复诊物理治疗：1,450',
        '运动按摩：900',
        '临床普拉提：1,450',
      ],
    },
  },
  IN: {
    en: {
      header: '*Fees (INR):*',
      items: [
        'Initial: 2,500',
        'Follow-up: 1,800',
      ],
    },
    yue: null,
    zh: null,
  },
  PH: {
    en: {
      header: '*Fees (PHP):*',
      items: [
        'Standard Physiotherapy: 3,500',
        'Strength & Conditioning (1 hour): 2,000',
        'Tune Up — Myofascial Release (30 min): 1,500',
        'Tune Up — Myofascial Release (1 hour): 3,000',
      ],
    },
    yue: null,
    zh: null,
  },
};

/**
 * Returns the fee schedule for a region in the given language, falling
 * back to English if that region has no translated variant yet.
 * @param {string} region
 * @param {string} language
 */
function getRegionFeesForLanguage(region, language) {
  const entry = REGION_FEES[region] || REGION_FEES.SG;
  return entry[language] || entry.en;
}

/**
 * Region capability flags — feature gates keyed by capability name, not by
 * literal region checks scattered through ChatbotEngine.js. A region simply
 * omits a flag (or sets it false) when the capability doesn't apply; callers
 * use hasCapability() rather than comparing region strings directly, so
 * enabling/disabling a feature for a region (or adding it to a new one) is a
 * one-line config change, not a code change.
 */
const REGION_CAPABILITIES = {
  SG: {
    // Some appointment types differ only by which physio holds them (rate
    // tier), not by session type (e.g. SG's "Physiotherapist" vs "Senior
    // Physiotherapist" — same visit, priced per practitioner). When true, a
    // dedicated funnel step asks which tier before the gender-preference
    // step, instead of surfacing the tier as if it were a different
    // appointment type. See project_singapore_physio_tiers memory.
    physioTiers: true,
  },
};

/**
 * @param {string} region
 * @param {string} capability
 * @returns {boolean}
 */
function hasCapability(region, capability) {
  return !!(REGION_CAPABILITIES[region] && REGION_CAPABILITIES[region][capability]);
}

module.exports = { REGION_SUPPORT_INFO, REGION_FEES, getRegionFeesForLanguage, REGION_CAPABILITIES, hasCapability };
