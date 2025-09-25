#!/usr/bin/env node
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DatabaseManager = require(path.join(ROOT, 'src/core/DatabaseManager'));
const SessionManager  = require(path.join(ROOT, 'src/core/SessionManager'));
const ChatbotEngine   = require(path.join(ROOT, 'src/core/ChatbotEngine'));

(async () => {
  const phone = (process.argv[2] || '').trim();
  const DEST  = (process.argv[3] || 'rrv1979@gmail.com').trim();
  if (!phone) { console.error('Usage: node tests/send_reschedule_email.test.js <phone> [destEmail]'); process.exit(2); }

  const db = new DatabaseManager({ filename: process.env.DB_FILE || 'database.sqlite' });
  const sessionManager = new SessionManager(db);
  const engine = new ChatbotEngine({ sessionManager, clinikoAPI: null, whatsAppAPI: null, logger: console });

  if (typeof db.getLatestSessionByPhone !== 'function') {
    db.getLatestSessionByPhone = function (p) {
      const sql = `SELECT * FROM sessions WHERE phone_number = ?
                   ORDER BY datetime(last_activity) DESC, datetime(created_at) DESC LIMIT 1`;
      return new Promise((resolve, reject) =>
        this.db.get(sql, [p], (err, row) => err ? reject(err) : resolve(row || null)));
    };
  }

  const row = await db.getLatestSessionByPhone(phone).catch(() => null);
  if (!row || !row.id) { console.error(`FAIL: session not found for ${phone}`); process.exit(1); }

  const data = (() => { try { return row.data ? JSON.parse(row.data) : {}; } catch { return {}; } })();

  if (typeof engine._composeSupportEmailPayloadRescheduled !== 'function') {
    console.error('FAIL: _composeSupportEmailPayloadRescheduled() missing on ChatbotEngine');
    process.exit(1);
  }

  // Minimal scaffolds if real reschedule details are not in session
  const oldAppt = {
    id: data.resched_old_id || 'TEST-OLD-123',
    starts_at: data.resched_old_time || new Date(Date.now() + 2*86400000).toISOString(),
    appointment_type: data.resched_old_type || 'Return Visit (Existing Clients)',
    practitioner: data.resched_old_physio || 'Sample Physio',
    clinic: data.resched_old_clinic || 'Prohealth In Touch Physiotherapy',
    patient_email: data.email || row.email || '',
    patient_phone: row.phone_number
  };
  const newAppt = {
    id: data.resched_new_id || 'TEST-NEW-456',
    starts_at: data.resched_new_time || new Date(Date.now() + 3*86400000).toISOString(),
    appointment_type: data.resched_new_type || 'Return Visit (Existing Clients)',
    practitioner: data.resched_new_physio || 'Sample Physio',
    clinic: data.resched_new_clinic || 'Prohealth In Touch Physiotherapy',
    patient_email: data.email || row.email || '',
    patient_phone: row.phone_number
  };

  const payload = await engine._composeSupportEmailPayloadRescheduled(row, data, oldAppt, newAppt);

  const intended = Array.isArray(payload.to) && payload.to.length ? payload.to.join(', ') : '—';
  const subject  = `${payload.subject} (intended: ${intended})`;
  const text     = `Intended recipients: ${intended}\n\n${payload.text || ''}`;

  console.log('--- EMAIL PREVIEW (RESCHEDULED) -------------------------');
  console.log('Sending to:', DEST);
  console.log('Subject   :', subject);
  console.log('Body:\n' + text);
  console.log('----------------------------------------------------------');

  const body = JSON.stringify({ to: [DEST], subject, text });
  const req = http.request(
    { method: 'POST', host: '127.0.0.1', port: 8089, path: '/email',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    (res) => { res.resume(); console.log('Mailer HTTP:', res.statusCode); process.exit(res.statusCode === 200 ? 0 : 1); }
  );
  req.on('error', (e) => { console.error('Mailer error:', e.message); process.exit(1); });
  req.write(body); req.end();
})().catch(e => { console.error('ERROR:', e?.message || e); process.exit(1); });
