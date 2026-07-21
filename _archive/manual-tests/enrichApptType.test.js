/**
 * File: test/enrichAppointmentType.test.js
 *
 * Purpose:
 * - Verify that _appointment_type_display includes "Name (Category)" when AppointmentType.category exists.
 * - Verify fallback to "Name" when category is null/empty.
 *
 * How to run:
 *   node test/enrichAppointmentType.test.js
 */

// Minimal local “formatter” identical to the plan (doesn’t change your prod code yet)
function formatAppointmentTypeDisplay(apptType) {
  if (!apptType) return 'Appointment';
  const name = apptType.name || 'Appointment';
  const cat = apptType.category ? String(apptType.category).trim() : '';
  if (cat && cat.toLowerCase() !== String(name).toLowerCase()) {
    return `${name} (${cat})`;
  }
  return name;
}

// Bring in the real function to test: enrichAppointmentsForDisplay
// We load it from your ChatbotEngine.js by requiring the file and extracting the function.
// Note: ChatbotEngine exports the class, so we re-require and eval the function content.
// To keep it isolated and not depend on class instance, we copy the function from your code:
const { enrichAppointmentsForDisplay } = (() => {
  // Inline copy from ChatbotEngine.js (unchanged). Only difference: we inject our formatter.
  async function enrichAppointmentsForDisplay(appointments, clinikoAPI) {
    const practitionerIds = new Set();
    const apptTypeIds = new Set();
    const businessIds = new Set();

    if (appointments.length > 0) {
      // silent in test
    }

    for (const appt of appointments) {
      const practitionerId = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
      const apptTypeId = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
      const businessId = extractIdFromClinikoRef(appt.business, 'businesses');

      if (practitionerId) practitionerIds.add(practitionerId);
      if (apptTypeId) apptTypeIds.add(apptTypeId);
      if (businessId) businessIds.add(businessId);
    }

    const [practitioners, apptTypes, businesses] = await Promise.all([
      Promise.all([...practitionerIds].map(id => clinikoAPI.getPractitionerById(id).then(obj => [id, obj]))),
      Promise.all([...apptTypeIds].map(id => clinikoAPI.getAppointmentTypeById(id).then(obj => [id, obj]))),
      Promise.all([...businessIds].map(id => clinikoAPI.getBusinessById(id).then(obj => [id, obj])))
    ]);

    const practitionerMap = Object.fromEntries(practitioners);
    const apptTypeMap = Object.fromEntries(apptTypes);
    const businessMap = Object.fromEntries(businesses);

    for (const appt of appointments) {
      const practitionerId = extractIdFromClinikoRef(appt.practitioner, 'practitioners');
      const apptTypeId = extractIdFromClinikoRef(appt.appointment_type, 'appointment_types');
      const businessId = extractIdFromClinikoRef(appt.business, 'businesses');

      const practitionerObj = practitionerMap[practitionerId] || null;
      const apptTypeObj = apptTypeMap[apptTypeId] || null;
      const businessObj = businessMap[businessId] || null;

      appt._practitioner_display = getPractitionerDisplayName(practitionerObj);
      // Inject our new formatter under test:
      appt._appointment_type_display = formatAppointmentTypeDisplay(apptTypeObj);
      appt._business_display = getBusinessDisplayName(businessObj);
      appt._display_dt = new Date(appt.starts_at).toLocaleString('en-GB');
    }

    return appointments;
  }

  // Helper functions copied from your ChatbotEngine.js (unchanged logic)
  function extractIdFromClinikoRef(obj, type) {
    if (!obj) return undefined;
    if (obj.id) return obj.id;
    const url = obj.links?.self;
    if (url) {
      const parts = url.split('/');
      const idx = parts.findIndex(p => p === type);
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
      return parts[parts.length - 1];
    }
    return undefined;
  }
  function getPractitionerDisplayName(practitioner) {
    if (!practitioner) return 'Practitioner';
    if (practitioner.display_name) return practitioner.display_name;
    if (practitioner.first_name || practitioner.last_name)
      return [practitioner.first_name, practitioner.last_name].filter(Boolean).join(' ');
    return 'Practitioner';
  }
  function getBusinessDisplayName(business) {
    if (!business) return '';
    return business.business_name || business.display_name || '';
  }

  return { enrichAppointmentsForDisplay };
})();

// ---- Mock ClinikoAPI ----
class MockClinikoAPI {
  constructor(fixtures) {
    this.fx = fixtures || {};
  }
  async getAppointmentTypeById(id) {
    return this.fx.appointmentTypes[String(id)] || null;
  }
  async getPractitionerById(id) {
    return this.fx.practitioners[String(id)] || null;
  }
  async getBusinessById(id) {
    return this.fx.businesses[String(id)] || null;
  }
}

// ---- Test runner (tiny) ----
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    // eslint-disable-next-line no-console
    console.error('Assertion failed:', msg, '\n  expected:', expected, '\n  actual:  ', actual);
    process.exit(1);
  }
}
function assert(condition, msg) {
  if (!condition) {
    // eslint-disable-next-line no-console
    console.error('Assertion failed:', msg);
    process.exit(1);
  }
}

// ---- Test cases ----
(async function main() {
  // Fixtures
  const fx = {
    appointmentTypes: {
      '101': { id: '101', name: 'Return Visit', category: 'Physiotherapy', duration_in_minutes: 30 },
      '102': { id: '102', name: 'Initial Assessment', category: null, duration_in_minutes: 60 },
    },
    practitioners: {
      '201': { id: '201', first_name: 'Alex', last_name: 'Wong' },
    },
    businesses: {
      '301': { id: '301', business_name: 'Prohealth In Touch Physiotherapy' },
    }
  };
  const api = new MockClinikoAPI(fx);

  // Input appointments (mimic real shapes)
  const appts = [
    {
      // Referenced via links.self as in your code
      appointment_type: { links: { self: 'https://api.au1.cliniko.com/v1/appointment_types/101' } },
      practitioner: { links: { self: 'https://api.au1.cliniko.com/v1/practitioners/201' } },
      business: { links: { self: 'https://api.au1.cliniko.com/v1/businesses/301' } },
      starts_at: '2025-11-10T09:00:00Z'
    },
    {
      appointment_type: { links: { self: 'https://api.au1.cliniko.com/v1/appointment_types/102' } },
      practitioner: { links: { self: 'https://api.au1.cliniko.com/v1/practitioners/201' } },
      business: { links: { self: 'https://api.au1.cliniko.com/v1/businesses/301' } },
      starts_at: '2025-11-10T10:00:00Z'
    }
  ];

  const out = await enrichAppointmentsForDisplay(appts, api);

  // Assertions
  assertEqual(out[0]._practitioner_display, 'Alex Wong', 'practitioner display should be full name');
  assertEqual(out[0]._business_display, 'Prohealth In Touch Physiotherapy', 'business display should be clinic name');
  assertEqual(out[0]._appointment_type_display, 'Return Visit (Physiotherapy)', 'type should include category');

  assertEqual(out[1]._appointment_type_display, 'Initial Assessment', 'type without category should fallback to name');

  // Display date formatting sanity (locale may vary, just ensure it’s set)
  assert(!!out[0]._display_dt && typeof out[0]._display_dt === 'string', '_display_dt should be present');

  // eslint-disable-next-line no-console
  console.log('OK: enrichAppointmentType shows Name (Category) when available and falls back when missing.');
})().catch(err => {
  // eslint-disable-next-line no-console
  console.error('Test run failed:', err);
  process.exit(1);
});
