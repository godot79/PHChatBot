'use strict';

/**
 * Region-specific support contact details.
 * Used by getSupportInfo() in ChatbotEngine for dead-end escalation and error messages.
 */
const REGION_SUPPORT_INFO = {
  SG: {
    phone: '+65 6533 0968',
    email: 'admin@intouchphysio.com',
  },
  HK: {
    phone: '+852 25300073',
    email: 'appt@physiohk.com',
  },
  IN: {
    phone: '+91-11-4212-0200',
    email: 'appt@prohealthasia.in',
  },
  PH: {
    phone: '+63 2 8633 6410',
    email: 'appt@sportsandspinal.ph',
  },
};

module.exports = { REGION_SUPPORT_INFO };
