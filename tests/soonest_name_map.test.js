/**
 * tests/soonest_name_map.test.js
 *
 * Purpose: Prove whether a single practitioner is being surfaced due to
 * name→ID mapping. Enumerates all practitioners who offer the given
 * appointment type NAME, then checks their slot availability per clinic.
 *
 * Runtime-only test. No prod changes.
 *
 * Usage:
 *   node tests/soonest_name_map.test.js "Initial 60 Min Visit (New Clients)"
 *   # or rely on DEFAULT_TYPE_NAME below
 */

const dotenv = require('dotenv');
dotenv.config();

const Logger = require('../src/core/Logger.js');
const ClinikoAPI = require('../src/api/ClinikoAPI.js');

const log = new Logger('soonest-name-map');
const api = new ClinikoAPI();

const DEFAULT_TYPE_NAME = 'Initial 60 Min Visit (New Clients)';
const TARGET_NAME_RAW = process.argv[2] || process.env.TARGET_TYPE_NAME || DEFAULT_TYPE_NAME;

// Normalize names to avoid Unicode dash, double-spaces, case differences
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')   // Unicode dashes to '-'
    .replace(/\s+/g, ' ')               // collapse spaces
    .trim();
}

(async function main() {
  log.info('▶ Running soonest name→IDs and practitioner probe...');
  const targetName = normName(TARGET_NAME_RAW);
  log.info(`Target type name: "${TARGET_NAME_RAW}" (normalized: "${targetName}")`);

  // 1) Gather clinics and practitioners
  const groups = await api.getPractitionersByClinic();
  if (!Array.isArray(groups) || groups.length === 0) {
    log.error('No clinics returned from getPractitionersByClinic');
    process.exit(1);
  }

  // 2) Build name→{ ids:Set, entries:[{p, type}], practitioners:Set }
  const nameMap = new Map();
  const practitionerToClinics = new Map(); // p.id -> Set(business_id)

  for (const g of groups) {
    for (const p of g.practitioners || []) {
      if (!practitionerToClinics.has(p.id)) practitionerToClinics.set(p.id, new Set());
      practitionerToClinics.get(p.id).add(String(g.clinic_id));

      const types = await api.getAppointmentTypes({ practitioner_id: p.id });
      for (const t of types || []) {
        const key = normName(t.name);
        if (!nameMap.has(key)) nameMap.set(key, { ids: new Set(), entries: [], practitioners: new Map() });
        const bucket = nameMap.get(key);
        bucket.ids.add(String(t.id));
        bucket.entries.push({ practitioner: p, type: t });
        if (!bucket.practitioners.has(p.id)) bucket.practitioners.set(p.id, p);
      }
    }
  }

  // 3) Print mapping for the target name
  const bucket = nameMap.get(targetName);
  if (!bucket) {
    log.warn(`No practitioners found for name="${TARGET_NAME_RAW}"`);
    process.exit(0);
  }

  const idList = Array.from(bucket.ids);
  const practitioners = Array.from(bucket.practitioners.values());

  log.info(`\n=== Summary for "${TARGET_NAME_RAW}" ===`);
  log.info(`Unique type IDs: ${idList.length} -> [${idList.join(', ')}]`);
  log.info(`Practitioners offering this name: ${practitioners.length}`);
  practitioners.forEach((p, i) => {
    const fullname = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.display_name || p.id;
    log.info(`  ${i + 1}. ${fullname} (id=${p.id})`);
  });

  // 4) Probe available slots per practitioner per clinic for the first matching type ID *for that practitioner*
  //    Window: from tomorrow to +5 days (consistent with ClinikoAPI defaults)
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString().slice(0, 10);
  const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6).toISOString().slice(0, 10);

  log.info(`\nChecking available slots per practitioner from ${from} to ${to}`);

  for (const p of practitioners) {
    // find the practitioner-specific type ID that matches the target NAME
    const types = await api.getAppointmentTypes({ practitioner_id: p.id });
    const tForP = (types || []).find(t => normName(t.name) === targetName);
    if (!tForP) {
      log.warn(`  - ${p.display_name || p.first_name} has NO type with that normalized name`);
      continue;
    }

    const clinicIds = Array.from(practitionerToClinics.get(p.id) || []);
    for (const business_id of clinicIds) {
      try {
        const slots = await api.getAvailableTimes({
          practitioner_id: String(p.id),
          business_id: String(business_id),
          appt_type: String(tForP.id),
          from,
          to
        });
        const fullname = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.display_name || p.id;
        log.info(`  ▪ ${fullname} @ business ${business_id} -> ${slots.length} slots`);
        if (slots[0]) {
          log.info(`    first: ${slots[0].appointment_start || slots[0].start_time || slots[0].starts_at}`);
        }
      } catch (e) {
        log.warn(`  ▪ ${p.id} failed slots fetch @ business ${business_id}: ${e?.message || e}`);
      }
    }
  }

  log.info('\n✅ Probe complete. If you see >1 practitioner above, Soonest must not auto-pick one by accident.');
})().catch(err => {
  log.error(`Probe failed: ${err?.message || err}`);
  process.exit(1);
});

