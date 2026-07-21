#!/usr/bin/env node
/**
 * tests/no_slots_email_preview.test.js
 * Usage:
 *   node tests/no_slots_email_preview.test.js <phone|email>
 * Prints the exact email payload we would POST for the "no slots → contact me" path.
 */

let ChatbotEngine;
try { ChatbotEngine = require('../src/core/ChatbotEngine.js'); } catch (_) {}
try { if (!ChatbotEngine) ChatbotEngine = require('../ChatbotEngine.js'); } catch (_) {}
if (!ChatbotEngine) { console.error('Unable to require ChatbotEngine'); process.exit(1); }

let Logger;
try { Logger = require('../src/core/Logger.js'); } catch (_) {}
try { if (!Logger) Logger = require('../Logger.js'); } catch (_) {}
const log = new (Logger || class { info(...a){console.log(...a)} warn(...a){console.warn(...a)} error(...a){console.error(...a)} })('no-slots-preview');

const ident = (process.argv[2] || '').trim();
if (!ident) { console.error('Usage: node tests/no_slots_email_preview.test.js <phone|email>'); process.exit(1); }

(async () => {
  const engine = new ChatbotEngine();
  const sm = engine.sessionManager;

  // Resolve latest session by contact
  const isEmail = ident.includes('@');
  const norm = isEmail ? ident.toLowerCase() : sm.normalizePhoneNumber ? sm.normalizePhoneNumber(ident) : ident;

  let session = null;
  try {
    if (isEmail && sm.getLatestSessionByEmail) session = await sm.getLatestSessionByEmail(norm);
    if (!isEmail && sm.getLatestSessionByPhone) session = await sm.getLatestSessionByPhone(norm);
  } catch {}

  if (!session) {
    // fallback query
    const sql = isEmail
      ? `SELECT * FROM sessions WHERE lower(email)=lower(?) ORDER BY last_activity DESC, created_at DESC LIMIT 1`
      : `SELECT * FROM sessions WHERE phone_number=? ORDER BY last_activity DESC, created_at DESC LIMIT 1`;
    const rows = await sm.db.query(sql, [norm]).catch(() => []);
    if (Array.isArray(rows) && rows[0]) session = sm.parseSession(rows[0]);
  }
  if (!session) { console.error('FAIL: session not found for', ident); process.exit(1); }

  let data = {};
  try { data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {}); } catch {}

  if (typeof engine._composeSupportEmailPayloadNoSlots !== 'function') {
    console.error('FAIL: _composeSupportEmailPayloadNoSlots() not found on ChatbotEngine');
    process.exit(1);
  }

  const payload = await engine._composeSupportEmailPayloadNoSlots(session, data);

  // Pretty print similar to bot-visible formatting
  console.log('--- EMAIL PREVIEW ----------------------------------------');
  console.log('To:      ' + (Array.isArray(payload.to) ? payload.to.join(', ') : ''));
  console.log('Subject: ' + (payload.subject || ''));
  console.log('Body:\n' + (payload.text || ''));
  if (payload.meta) {
    console.log('\nMeta:');
    console.log(JSON.stringify(payload.meta, null, 2));
  }
  console.log('----------------------------------------------------------');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e?.message || e); process.exit(1); });
