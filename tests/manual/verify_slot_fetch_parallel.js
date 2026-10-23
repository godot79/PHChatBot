// Read-only live verification for the bulkAll parallelization of
// getAvailableSlotsByBusinessAndDate's inner appointment-type fan-out
// (fix/slot-fetch-noise-and-latency). Reproduces the exact slow case found
// in HK prod logs 2026-10-23 03:26 (practitioner Alicia Lam, business
// 1913468029224617167, date 2026-10-26) and times it.
require('dotenv').config();
const RegionContext = require('../../src/core/RegionContext');
const ClinikoAPI = require('../../src/api/ClinikoAPI');

async function main() {
  await RegionContext.run('HK', async () => {
    const api = new ClinikoAPI();
    api.clearCache && api.clearCache();

    const business_id = '1913468029224617167';
    const practitioner_id = '1914253149716088210'; // Alicia Lam
    const from = '2026-10-26';
    const to = '2026-10-26';

    const t0 = Date.now();
    const slots = await api.getAvailableSlotsByBusinessAndDate({ business_id, from, to, practitioner_id });
    const ms = Date.now() - t0;

    console.log(`Elapsed: ${ms}ms`);
    console.log(`Slots returned: ${slots.length}`);
    console.log(`_partial: ${!!slots._partial}`);
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
