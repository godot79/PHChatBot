// Utility used by the tests below. No external deps.
const path = require('path');

function safeParse(s) { try { return JSON.parse(s||'{}'); } catch { return {}; } }

function preview(title, payload) {
  const to = (payload.to||[]).join(', ');
  console.log(`--- EMAIL PREVIEW (${title}) ---------------------------`);
  console.log(`Sending to: ${to || '(none)'}`);
  console.log(`Subject   : ${payload.subject}`);
  console.log(`Body:\n${payload.text}`);
  console.log('----------------------------------------------------------');
}

async function loadCore() {
  const ChatbotEngine = require(path.join(process.cwd(), 'src/core/ChatbotEngine.js'));
  const SessionManager = require(path.join(process.cwd(), 'src/core/SessionManager.js'));
  const DatabaseManager = require(path.join(process.cwd(), 'src/core/DatabaseManager.js'));
  const db = new DatabaseManager(); await db.connect();
  const sessionManager = new SessionManager(db);
  const engine = new ChatbotEngine({ sessionManager, logger: console });
  return { engine, sessionManager, db };
}

async function getSessionByPhone(sessionManager, phone) {
  if (typeof sessionManager.getLatestSessionByPhone === 'function') {
    return await sessionManager.getLatestSessionByPhone(phone);
  }
  // Fallback: list sessions and pick latest
  const all = await sessionManager.listSessionsByPhone(phone);
  return all && all[0];
}

// Force all test emails to go to rrv1979@gmail.com, but keep intended in subject
function forceTestRecipient(payload, intended) {
  const out = { ...payload };
  out.subject = `${payload.subject} (intended: ${intended || '—'})`;
  out.to = ['rrv1979@gmail.com'];
  return out;
}

module.exports = { safeParse, preview, loadCore, getSessionByPhone, forceTestRecipient };
