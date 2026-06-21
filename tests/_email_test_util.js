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
  // DatabaseManager opens the SQLite connection in its constructor;
  // initialize() creates tables/indexes if missing. No connect() method exists.
  const db = new DatabaseManager();
  await db.initialize();
  const sessionManager = new SessionManager(db);
  const engine = new ChatbotEngine({ sessionManager, logger: console });
  return { engine, sessionManager, db };
}

async function getSessionByPhone(sessionManager, phone) {
  // Prefer dedicated method if it exists
  if (typeof sessionManager.getLatestSessionByPhone === 'function') {
    return await sessionManager.getLatestSessionByPhone(phone);
  }
  // SessionManager.getSessionByPhone filters out expired sessions, which is
  // fine for live use but breaks test scripts where the session may have expired.
  // Fall back to a direct DB query that ignores expiry.
  if (sessionManager.db && typeof sessionManager.db.query === 'function') {
    const rows = await sessionManager.db.query(
      `SELECT * FROM sessions WHERE phone_number = ? ORDER BY datetime(last_activity) DESC, datetime(created_at) DESC LIMIT 1`,
      [phone]
    );
    return (rows && rows[0]) || null;
  }
  // Last resort: use SessionManager's own method (active sessions only)
  if (typeof sessionManager.getSessionByPhone === 'function') {
    return await sessionManager.getSessionByPhone(phone);
  }
  return null;
}

// Force all test emails to go to rrv1979@gmail.com, but keep intended in subject
function forceTestRecipient(payload, intended) {
  const out = { ...payload };
  out.subject = `${payload.subject} (intended: ${intended || '—'})`;
  out.to = ['rrv1979@gmail.com'];
  return out;
}

module.exports = { safeParse, preview, loadCore, getSessionByPhone, forceTestRecipient };
