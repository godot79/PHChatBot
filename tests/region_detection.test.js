// tests/region_detection.test.js
// Validates getRegionFromPhoneNumber() behavior in SessionManager.
// Usage:
//   node tests/region_detection.test.js
// Env:
//   FORCE_REGION_SG=true  => all numbers must resolve to SG
//   FORCE_REGION_SG=false => test full detection across HK, SG, IN, PH
//
// It mirrors the console-driven style of register_new_patient.test.js.

require('dotenv').config();
const path = require('path');

function safe(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

(async () => {
  console.log('\n=== 🧭 region_detection.test.js started ===');

  const SessionManager = require(path.join(__dirname, '../src/core/SessionManager.js'));
  const mgr = new SessionManager();

  const FORCE = process.env.FORCE_REGION_SG === 'true';

  console.log(`FORCE_REGION_SG=${FORCE ? 'true (Expect all SG)' : 'false (Full detection)'}`);

  /**
   * Defines test cases for both forced and normal scenarios.
   */
  const cases = [
    // Singapore 🇸🇬
    { input: '+6591115623', expRegion: 'SG' },
    { input: '6591115623', expRegion: 'SG' },
    { input: '91115623', expRegion: 'SG' },
    { input: '006591115623', expRegion: 'SG' },
    { input: '(+65) 9111-5623', expRegion: 'SG' },

    // Hong Kong 🇭🇰
    { input: '+85291234567', expRegion: FORCE ? 'SG' : 'HK' },
    { input: '85291234567', expRegion: FORCE ? 'SG' : 'HK' },
    { input: '91234567', expRegion: FORCE ? 'SG' : 'HK' },

    // India 🇮🇳
    { input: '+919876543210', expRegion: FORCE ? 'SG' : 'IN' },
    { input: '9876543210', expRegion: FORCE ? 'SG' : 'IN' },
    { input: '09876543210', expRegion: FORCE ? 'SG' : 'IN' },

    // Philippines 🇵🇭
    { input: '+639123456789', expRegion: FORCE ? 'SG' : 'PH' },
    { input: '639123456789', expRegion: FORCE ? 'SG' : 'PH' },
    { input: '09123456789', expRegion: FORCE ? 'SG' : 'PH' },

    // Unknown / malformed
    { input: '0012345', expRegion: FORCE ? 'SG' : undefined },
    { input: '44 7000 123456', expRegion: FORCE ? 'SG' : undefined }
  ];

  /**
   * Executes and logs results in the same console style as register_new_patient.test.js.
   */
  let passed = 0;
  for (const c of cases) {
    const result = mgr.getRegionFromPhoneNumber(c.input);
    const ok = result.region === c.expRegion;
    console.log(
      `\n[Case] Input: "${c.input}"` +
      `\nExpected → ${c.expRegion || '(undefined)'} | Got → ${safe(result)}`
    );
    if (ok) {
      console.log('✅ PASS');
      passed++;
    } else {
      console.error('❌ FAIL');
    }
  }

  const summary = `\n=== ${passed}/${cases.length} region tests passed ===`;
  if (passed === cases.length) {
    console.log(summary + '\n✅ All region detection tests succeeded.');
    process.exit(0);
  } else {
    console.error(summary + '\n❌ Some region detection tests failed.');
    process.exit(1);
  }
})().catch(e => {
  console.error('❌ Test runner error:', e?.stack || e?.message || e);
  process.exit(2);
});
