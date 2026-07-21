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
 * Each region has a header line and a flat list of items shown to the customer.
 * Used by handleViewFeesState() in ChatbotEngine.
 */
const REGION_FEES = {
  SG: {
    header: '*Fees (45-min sessions):*',
    items: [
      'Senior Physio: SGD 230',
      'Physio: SGD 200',
    ],
  },
  HK: {
    header: '*Fees (HKD):*',
    items: [
      'Initial Physio: 1,450',
      'Follow-up Physio: 1,450',
      'Sports Massage: 900',
      'Clinical Pilates: 1,450',
    ],
  },
  IN: {
    header: '*Fees (INR):*',
    items: [
      'Initial: 2,500',
      'Follow-up: 1,800',
    ],
  },
  PH: {
    header: '*Fees (PHP):*',
    items: [
      'Standard Physiotherapy: 3,500',
      'Strength & Conditioning (1 hour): 2,000',
      'Tune Up — Myofascial Release (30 min): 1,500',
      'Tune Up — Myofascial Release (1 hour): 3,000',
    ],
  },
};

module.exports = { REGION_SUPPORT_INFO, REGION_FEES };
