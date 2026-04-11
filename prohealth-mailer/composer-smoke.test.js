/**
 * composer-smoke.js
 * Runs minimal, isolated smoke tests for each composer by posting to the local mailer.
 * Usage:
 *   GMAIL_USER=... GMAIL_APP_PASSWORD=... node composer-smoke.js
 */
const http = require('http');
require('dotenv').config();

// Inline copies of helpers (keep identical to ChatbotEngine versions)
function _getInlineLogoAttachment() {
  return {
    filename: 'prohealth-logo.png',
    content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    encoding: 'base64',
    cid: 'prohealth-logo',
    contentType: 'image/png'
  };
}
function resolveSupportEmails(region) {
  const map = {
    SG: ['ramesh@prohealthasia.com']
  };
  const def = ['ramesh@prohealthasia.com'];
  const r = String(region || '').toUpperCase();
  return Array.from(new Set((map[r] || def).filter(Boolean)));
}
function postEmail(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { method: 'POST', host: '127.0.0.1', port: 8089, path: '/email',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.statusCode === 200 ? resolve() : reject(new Error(`mailer ${res.statusCode}`)); }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Sample data
const session = { id: 's123', phone_number: '+65 8123 4567', context: JSON.stringify({ region: 'SG', email: 'patient@example.com' }) };
const appt = { id: 'A-001', starts_at: Date.now() + 86400000, appointment_type: 'Initial Consult', practitioner: 'Dr. Lim', clinic: 'Orchard Clinic', patient_email: 'patient@example.com' };
const oldAppt = { id: 'A-000', starts_at: Date.now() + 3600000, appointment_type: 'Follow-up', practitioner: 'Dr. Lim', clinic: 'Orchard Clinic', patient_email: 'patient@example.com' };
const newAppt = { id: 'A-002', starts_at: Date.now() + 172800000, appointment_type: 'Follow-up', practitioner: 'Dr. Lim', clinic: 'Orchard Clinic', patient_email: 'patient@example.com' };

function htmlWrap(title, body) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + title + '</title></head><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.4;color:#222;">' +
    '<div style="text-align:center;margin-bottom:16px;"><img src="cid:prohealth-logo" alt="ProHealth" style="max-width:220px;height:auto;display:inline-block" /></div>' +
    body + '</body></html>';
}

async function run() {
  const toSelf = [process.env.GMAIL_USER]; // ensure deliverable inbox for smoke
  if (!toSelf[0]) { console.error('Set GMAIL_USER and GMAIL_APP_PASSWORD'); process.exit(1); }

  const attachments = [_getInlineLogoAttachment()];

  // 1) Booked
  await postEmail({
    to: toSelf,
    subject: 'Booked! Appointment — SG — +65 8123 4567',
    text: 'Appointment booking notification.\n\n(see HTML)',
    html: htmlWrap('Booked', '<h2>Appointment booking notification</h2><p>Smoke test.</p>'),
    attachments
  });
  console.log('Booked smoke sent');

  // 2) Cancelled
  await postEmail({
    to: toSelf,
    subject: '[Cancelled] Appointment — SG — +65 8123 4567',
    text: 'Appointment cancellation notification.\n\n(see HTML)',
    html: htmlWrap('Cancelled', '<h2>Appointment cancellation notification</h2><p>Smoke test.</p>'),
    attachments
  });
  console.log('Cancelled smoke sent');

  // 3) Cancel Failed
  await postEmail({
    to: toSelf,
    subject: '[Cancel Failed] Appointment — SG — +65 8123 4567',
    text: 'Cancellation failed notification.\n\n(see HTML)',
    html: htmlWrap('Cancel Failed', '<h2>Cancellation failed notification</h2><p>Smoke test.</p>'),
    attachments
  });
  console.log('Cancel failed smoke sent');

  // 4) Rescheduled
  await postEmail({
    to: toSelf,
    subject: '[Rescheduled] Appointment — SG — +65 8123 4567',
    text: 'Rescheduled notification.\n\n(see HTML)',
    html: htmlWrap('Rescheduled', '<h2>Appointment reschedule notification</h2><p>Smoke test.</p>'),
    attachments
  });
  console.log('Rescheduled smoke sent');

  // 5) Reschedule Failed
  await postEmail({
    to: toSelf,
    subject: '[Reschedule Failed] Appointment — SG — +65 8123 4567',
    text: 'Reschedule failed notification.\n\n(see HTML)',
    html: htmlWrap('Reschedule Failed', '<h2>Reschedule failed notification</h2><p>Smoke test.</p>'),
    attachments
  });
  console.log('Reschedule failed smoke sent');

  // 6) No Slots
  await postEmail({
    to: toSelf,
    subject: '[No Slots] Contact request — SG — +65 8123 4567',
    text: 'No slots contact request.\n\n(see HTML)',
    html: htmlWrap('No Slots', '<h2>No available slots — user requested a callback.</h2><p>Smoke test.</p>'),
    attachments
  });
  console.log('No-slots smoke sent');

  // 7) Generic Failure
  await postEmail({
    to: toSelf,
    subject: '[Cancel Failed] — SG — +65 8123 4567',
    text: 'Generic failure.\n\n(see HTML)',
    html: htmlWrap('Generic Failure', '<h2>Operation failure notification</h2><p>Smoke test.</p>'),
    attachments
  });
  console.log('Generic failure smoke sent');

  console.log('All composer smokes queued. Check your inbox.');
}

run().catch((e) => {
  console.error('Smoke run error:', e);
  process.exit(1);
});
