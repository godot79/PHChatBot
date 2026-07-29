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
    yue: null, // TODO: needs native-speaker translation
    zh: null,  // TODO: needs native-speaker translation
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

module.exports = { REGION_SUPPORT_INFO, REGION_FEES, getRegionFeesForLanguage };
