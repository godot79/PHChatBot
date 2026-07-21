// get_patient_forms.test.js
// Minimal ad-hoc test to fetch and print patient forms without loadCore/db.
// Usage:
//   node get_patient_forms.test.js <PATIENT_ID>
//   PATIENT_ID=123 node get_patient_forms.test.js
//
// Assumptions:
// - ../api/ClinikoAPI.js exists and exports a class with getPatientForms(opts).
// - Your SendMessage/auth is configured inside ClinikoAPI/transport.

const path = require('path');

function getPatientIdFromArgs() {
  const argId = process.argv[2];
  const envId = process.env.PATIENT_ID;
  const id = argId || envId;
  if (!id) {
    console.error('FAIL: Provide a Cliniko PATIENT_ID via CLI arg or env.\nExample: node get_patient_forms.test.js 12345');
    process.exit(1);
  }
  return id;
}

function safeStringify(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

(async () => {
  // Lazy-resolve ClinikoAPI relative to this test file
  const ClinikoAPI = require(path.join(__dirname, '../src/api/ClinikoAPI.js'));

  const api = new ClinikoAPI();
  const patientId = getPatientIdFromArgs();

  try {
    // Fetch latest forms (descending by created_at)
    const forms = await api.getPatientForms({
      patient_id: patientId,
      sort: 'created_at:desc',
      per_page: 50
    });

    const count = Array.isArray(forms) ? forms.length : 0;
    console.log('================= Patient Forms =================');
    console.log('patient_id:', patientId);
    console.log('form_count:', count);

    if (!Array.isArray(forms) || count === 0) {
      console.log('No forms found.');
      process.exit(0);
    }

    // Full dump of each form
    forms.forEach((form, idx) => {
      console.log(`\n--- Form #${idx + 1} (full JSON) ---`);
      console.log(safeStringify(form));
    });

    // Key fields summary
    console.log('\n================= Key Fields Summary =================');
    forms.forEach((f, idx) => {
      console.log(`Form #${idx + 1}:`, {
        id: f?.id,
        name: f?.name,
        url: f?.url,
        archived_at: f?.archived_at,
        completed_at: f?.completed_at,
        created_at: f?.created_at,
        updated_at: f?.updated_at,
        patient_link: f?.patient?.links?.self,
        template_link: f?.patient_form_template?.links?.self,
        signatures_link: f?.signatures?.links?.self
      });
    });

    // Highlight first usable (incomplete, unarchived) URL if present
    const firstUsable = forms.find(f => !f?.completed_at && !f?.archived_at && (f?.url || f?.links?.self));
    if (firstUsable) {
      console.log('\nFirst usable form link:', firstUsable.url || firstUsable.links?.self || '');
    } else {
      console.log('\nNo usable (incomplete/unarchived) form link found.');
    }

    console.log('\n✅ get_patient_forms.test.js complete');
    process.exit(0);
  } catch (e) {
    console.error('❌ getPatientForms error:', e?.message || e);
    process.exit(2);
  }
})();
