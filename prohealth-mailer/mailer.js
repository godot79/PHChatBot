/**
 * ProHealth Mailer Service
 *
 * Accepts:
 *   POST /email  { to: string[], subject: string, html: string, text?: string }
 *   GET  /smoke  sends a test email to GMAIL_USER
 *
 * Logo: reads prohealth-logo.png from the same directory as this file and
 * attaches it as an inline CID image (cid:prohealth-logo) whenever the HTML
 * body contains that reference. No manual attachment field needed from callers.
 *
 * Environment:
 *   GMAIL_USER, GMAIL_APP_PASSWORD, GMAIL_FROM_NAME (optional)
 */

'use strict';

const express    = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
require('dotenv').config();

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// ─── Config ──────────────────────────────────────────────────────────────────

const user        = process.env.GMAIL_USER;
const pass        = process.env.GMAIL_APP_PASSWORD;
const displayName = process.env.GMAIL_FROM_NAME || 'ProHealth';
const PORT        = process.env.PORT || 8089;

// ─── Logo attachment ──────────────────────────────────────────────────────────

const LOGO_PATH = path.join(__dirname, 'prohealth-logo.png');
const LOGO_CID  = 'prohealth-logo';

/**
 * Returns the nodemailer inline attachment object for the ProHealth logo,
 * or null if the logo file is not found.
 */
function getLogoAttachment() {
  try {
    if (!fs.existsSync(LOGO_PATH)) {
      console.warn(`[Mailer] Logo not found at ${LOGO_PATH} — emails will send without logo.`);
      return null;
    }
    return {
      filename:    'prohealth-logo.png',
      path:        LOGO_PATH,
      cid:         LOGO_CID,
      contentType: 'image/png',
    };
  } catch (e) {
    console.warn('[Mailer] Could not read logo file:', e.message);
    return null;
  }
}

/**
 * Returns missing required mailer environment variables.
 *
 * @returns {string[]}
 */
function getMissingMailerEnv() {
  const missing = [];
  if (!user) missing.push('GMAIL_USER');
  if (!pass) missing.push('GMAIL_APP_PASSWORD');
  return missing;
}

// ─── Transport ────────────────────────────────────────────────────────────────

const tx = (user && pass)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    })
  : null;

// ─── Send helper ─────────────────────────────────────────────────────────────

/**
 * Sends one email. Automatically inlines the logo when the HTML body
 * references cid:prohealth-logo.
 *
 * @param {object} opts
 * @param {string[]} opts.to
 * @param {string}   opts.subject
 * @param {string}   [opts.html]
 * @param {string}   [opts.text]
 */
async function sendEmail({ to, subject, html, text }) {
  const missing = getMissingMailerEnv();
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const mailOptions = {
    from:    { name: displayName, address: user },
    to:      to.join(','),
    subject,
  };

  if (html) {
    mailOptions.html = html;
    if (text) mailOptions.text = text;

    // Auto-attach logo if the HTML references the CID
    if (html.includes(`cid:${LOGO_CID}`)) {
      const logo = getLogoAttachment();
      if (logo) {
        mailOptions.attachments = [logo];
      }
    }
  } else {
    mailOptions.text = text || '(no content)';
  }

  console.log(`[Mailer] Attempting sendMail → to: ${mailOptions.to} | subject: ${subject} | from: ${user}`);
  const info = await tx.sendMail(mailOptions);
  console.log(`[Mailer] sendMail OK | messageId: ${info.messageId} | response: ${info.response} | accepted: ${JSON.stringify(info.accepted)} | rejected: ${JSON.stringify(info.rejected)}`);
  if (info.rejected && info.rejected.length) {
    console.error(`[Mailer] ⚠️  REJECTED addresses: ${info.rejected.join(', ')}`);
  }
  return info;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /email
 * Body: { to: string[], subject: string, html: string, text?: string }
 */
app.post('/email', async (req, res) => {
  try {
    const missing = getMissingMailerEnv();
    if (missing.length) {
      console.error(`[Mailer] /email unavailable — missing env vars: ${missing.join(', ')}`);
      return res.status(500).send(`missing env: ${missing.join(', ')}`);
    }

    const body    = req.body || {};
    const to      = Array.isArray(body.to) ? body.to.filter(Boolean) : [];
    const subject = String(body.subject || 'ProHealth Notification');
    const html    = body.html  ? String(body.html)  : '';
    const text    = body.text  ? String(body.text)  : '';

    if (!to.length) {
      return res.status(400).send('missing to');
    }

    await sendEmail({ to, subject, html, text });
    console.log(`[Mailer] Sent "${subject}" → ${to.join(', ')}`);
    res.send('ok');
  } catch (e) {
    console.error('[Mailer] Send failed:', e.message || e);
    res.status(500).send('error');
  }
});

/**
 * GET /smoke
 * Sends a test HTML email (with logo) to GMAIL_USER.
 */
app.get('/smoke', async (_req, res) => {
  try {
    const missing = getMissingMailerEnv();
    if (missing.length) {
      console.error(`[Mailer] /smoke unavailable — missing env vars: ${missing.join(', ')}`);
      return res.status(500).send(`missing env: ${missing.join(', ')}`);
    }

    const html = `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;padding:32px;">
  <img src="cid:${LOGO_CID}" alt="ProHealth" style="max-width:180px;display:block;margin-bottom:16px;"/>
  <h2 style="color:#005587;">Mailer Smoke Test ✅</h2>
  <p>If you can see the logo above and this text, the mailer is working correctly.</p>
</body></html>`;

    await sendEmail({
      to:      [user],
      subject: 'ProHealth Mailer Smoke Test',
      html,
      text:    'Mailer smoke test — if you see this, it works.',
    });
    res.send('smoke-ok');
  } catch (e) {
    console.error('[Mailer] Smoke failed:', e.message || e);
    res.status(500).send('smoke-error: ' + (e.message || e));
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  const logoStatus = fs.existsSync(LOGO_PATH) ? '✅ logo found' : '⚠️  logo missing';
  console.log(`[Mailer] Listening on 0.0.0.0:${PORT} — ${logoStatus}`);
  console.log(`[Mailer] GMAIL_USER = ${user || '(missing)'}`);

  const missing = getMissingMailerEnv();
  if (missing.length) {
    console.error(`[Mailer] Missing required env vars: ${missing.join(', ')} — service started, but email routes will fail until configured.`);
    return;
  }

  // Verify SMTP credentials on startup
  tx.verify((err, success) => {
    if (err) {
      console.error('[Mailer] ❌ SMTP verify FAILED — emails will not send:', err.message || err);
    } else {
      console.log('[Mailer] ✅ SMTP credentials verified — ready to send');
    }
  });
});
