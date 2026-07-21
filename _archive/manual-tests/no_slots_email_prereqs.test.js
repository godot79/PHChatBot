#!/usr/bin/env node
/**
 * tests/no_slots_email_prereqs.test.js
 *
 * Usage:
 *   node tests/no_slots_email_prereqs.test.js +85298377469
 *   node tests/no_slots_email_prereqs.test.js user@example.com
 *
 * Verifies prerequisites for “No slots → contact me” email:
 *  - region, phone present
 *  - selected_clinic, selected_physio, selected_appt_type, selected_date present
 *  - chat history exists for session
 */

const dotenv = require('dotenv'); dotenv.config();

let ChatbotEngine;
try { ChatbotEngine = require('../src/core/ChatbotEngine.js'); } catch (_) {}
try { if (!ChatbotEngine) ChatbotEngine = require('../ChatbotEngine.js'); } catch (_) {}
if (!ChatbotEngine) { console.error('Unable to require ChatbotEngine'); process.exit(1); }

let Logger;
try { Logger = require('../src/core/Logger.js'); } catch (_) {}
try { if (!Logger) Logger = require('../Logger.js'); } catch (_) {}
const log = new (Logger || class { info(...a){console.log(...a)} warn(...a){console.warn(...a)} error(...a){console.error(...a)} })('no-slots-prereqs');

const ident = (process.argv[2] || '').trim();
if (!ident) { console.error('Usage: node tests/no_slots_email_prereqs.test.js <phone|email>'); process.exit(1); }

(async () => {
  const engine = new ChatbotEngine();
  const sm = engine.sessionManager;
  if (!sm) { console.error('ChatbotEngine.sessionManager missing'); process.exit(1); }

  // Resolve latest session by phone/email using existing accessors first, then fallback.
  async function resolveLatestSessionByContact(id) {
    const isEmail = id.includes('@');

    if (isEmail && sm.getLatestSessionByEmail) return await sm.getLatestSessionByEmail(id).catch(() => null);
    if (!isEmail && sm.getLatestSessionByPhone) return await sm.getLatestSessionByPhone(id).catch(() => null);
    if (sm.getSessionByContact) return await sm.getSessionByContact(id).catch(() => null);

    let sessions = [];
    if (sm.listSessions) sessions = await sm.listSessions().catch(() => []);
    else if (sm.db?.listSessions) sessions = await sm.db.listSessions().catch(() => []);
    else if (sm.db?.getAllSessions) sessions = await sm.db.getAllSessions().catch(() => []);

    const norm = String(id).replace(/[\s\-]/g, '').toLowerCase();
    const candidates = (sessions || []).filter(s => {
      const phone = (s.phoneNumber || s.phone || '').replace(/[\s\-]/g, '');
      const email = (s.email || '').toLowerCase();
      return isEmail ? email === norm : phone.endsWith(norm) || phone === norm;
    });
    if (!candidates.length) return null;
    candidates.sort((a,b) => new Date(b.last_activity || b.updated_at || b.created_at || 0) - new Date(a.last_activity || a.updated_at || a.created_at || 0));
    return candidates[0];
  }

  const session = await resolveLatestSessionByContact(ident);
  if (!session) { console.error('FAIL: session not found for', ident); process.exit(1); }

  // Safe parse of session.data/context
  let data = {}; try { data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {}); } catch {}
  const ctx  = (() => { try { return typeof session.context === 'string' ? JSON.parse(session.context || '{}') : (session.context || {}); } catch { return {}; } })();

  const problems = [];
  const region = ctx.region || data.region || 'SG';
  const phone  = session.phoneNumber || session.phone || null;
  const email  = session.email || data.email || null;

  if (!region) problems.push('region missing');
  if (!phone)  problems.push('user phone missing');

  if (!data.selected_clinic)    problems.push('selected_clinic missing');
  if (!data.selected_physio)    problems.push('selected_physio missing');
  if (!data.selected_appt_type) problems.push('selected_appt_type missing');
  if (!data.selected_date)      problems.push('selected_date missing');

  // Chat history presence
  let hasHistory = false;
  try {
    if (sm.getConversationTranscript) {
      const t = await sm.getConversationTranscript(session.id);
      hasHistory = !!t;
    } else if (sm.db?.getChatHistory) {
      const arr = await sm.db.getChatHistory(session.id);
      hasHistory = Array.isArray(arr) && arr.length > 0;
    }
  } catch (_) {}
  if (!hasHistory) problems.push('chat history unavailable');

  if (problems.length) {
    console.error('FAIL:', problems.join(', '), '| session_id=', session.id);
    process.exit(1);
  }

  log.info(`PASS: prerequisites present | session_id=${session.id} | region=${region} | phone=${phone} | email=${email || '—'}`);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e?.message || e); process.exit(1); });
