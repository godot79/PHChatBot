#!/usr/bin/env node
/**
 * Verify region-bound API key selection used by handlers via RegionContext.
 * Runs without network. No app changes required.
 *
 * Run:
 *   node tests/region_key_selection.test.js
 */

// --- Resolve modules (adapt to your tree) ---
let ClinikoHeaders;
try { ClinikoHeaders = require('../src/api/ClinikoHeaders'); } catch (_) {}
try { if (!ClinikoHeaders) ClinikoHeaders = require('../api/ClinikoHeaders'); } catch (_) {}
try { if (!ClinikoHeaders) ClinikoHeaders = require('./ClinikoHeaders'); } catch (_) {}
if (!ClinikoHeaders) {
  console.error('Unable to require ClinikoHeaders. Adjust path.');
  process.exit(1);
}

let RegionContext;
try { RegionContext = require('../src/core/RegionContext'); } catch (_) {}
try { if (!RegionContext) RegionContext = require('../core/RegionContext'); } catch (_) {}
try { if (!RegionContext) RegionContext = require('./RegionContext'); } catch (_) {}
if (!RegionContext) {
  console.error('Unable to require RegionContext. Adjust path.');
  process.exit(1);
}

// --- Test harness ---
const origEnv = {
  SG: process.env.CLINIKO_API_KEY_SG,
  HK: process.env.CLINIKO_API_KEY_HK,
  IN: process.env.CLINIKO_API_KEY_IN,
  PH: process.env.CLINIKO_API_KEY_PH,
  FB: process.env.CLINIKO_API_KEY,
};

process.env.CLINIKO_API_KEY_SG = 'sg-key-TEST-123';
process.env.CLINIKO_API_KEY_HK = 'hk-key-TEST-456';
process.env.CLINIKO_API_KEY_IN = 'in-key-TEST-789';
process.env.CLINIKO_API_KEY_PH = 'ph-key-TEST-321';
process.env.CLINIKO_API_KEY = 'sg-key-TEST-123'; //fallback

const decodeAuthKey = (authHeader) => {
  const b64 = String(authHeader || '').split(' ')[1] || '';
  const raw = Buffer.from(b64, 'base64').toString('utf8');
  return raw.replace(/:$/, ''); // "apiKey:"
};

const assertEq = (label, a, b) => {
  const ok = a === b;
  console.log(ok ? 'PASS' : 'FAIL', '-', label, '=>', a);
  if (!ok) { console.error('  expected:', b); process.exitCode = 1; }
};

(async () => {
  console.log('▶ Region key selection tests');

  // A) Direct RegionContext → ClinikoHeaders
  await RegionContext.run('SG', async () => {
    const h = ClinikoHeaders.build();
    assertEq('Region SG', decodeAuthKey(h.Authorization), 'sg-key-TEST-123');
  });

  await RegionContext.run('HK', async () => {
    const h = ClinikoHeaders.build();
    assertEq('Region HK', decodeAuthKey(h.Authorization), 'hk-key-TEST-456');
  });

  await RegionContext.run('IN', async () => {
    const h = ClinikoHeaders.build();
    assertEq('Region IN', decodeAuthKey(h.Authorization), 'in-key-TEST-789');
  });

  await RegionContext.run('PH', async () => {
    const h = ClinikoHeaders.build();
    assertEq('Region PH', decodeAuthKey(h.Authorization), 'ph-key-TEST-321');
  });

  await RegionContext.run('XX', async () => {
    const h = ClinikoHeaders.build();
    assertEq('Unknown region → fallback', decodeAuthKey(h.Authorization), 'sg-key-TEST-123');
  });

  // B) Simulate handler wrapper (Pattern B)
  const withSessionRegion = async (session, fn) => {
    const ctx = (typeof session.context === 'string') ? (JSON.parse(session.context || '{}')) : (session.context || {});
    const region = (ctx && ctx.region) || 'SG';
    return RegionContext.run(region, fn);
  };

  // Fake handler body: just build headers as handlers do via SendMessage
  const fakeHandler = async () => decodeAuthKey(ClinikoHeaders.build().Authorization);

  const regions = ['SG','HK','IN','PH'];
  for (const r of regions) {
    const session = { id: 'test', context: JSON.stringify({ region: r }) };
    const keyUsed = await withSessionRegion(session, fakeHandler);
    assertEq(`handleMessage wrapper uses ${r} key`, keyUsed, process.env[`CLINIKO_API_KEY_${r}`]);
  }

  // C) Fallback when session has no region
  const sessionNoRegion = { id: 'test2', context: '{}' };
  const keyUsedFallback = await withSessionRegion(sessionNoRegion, fakeHandler);
  assertEq('wrapper fallback key', keyUsedFallback, process.env.CLINIKO_API_KEY);

})()
  .catch((e) => { console.error('Tests crashed:', e?.message || e); process.exit(1); })
  .finally(() => {
    // restore env
    process.env.CLINIKO_API_KEY_SG = origEnv.SG;
    process.env.CLINIKO_API_KEY_HK = origEnv.HK;
    process.env.CLINIKO_API_KEY_IN = origEnv.IN;
    process.env.CLINIKO_API_KEY_PH = origEnv.PH;
    process.env.CLINIKO_API_KEY    = origEnv.FB;
  });

