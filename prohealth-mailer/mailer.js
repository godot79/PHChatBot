/**
 * Minimal mailer with HTML + inline logo support (backward compatible).
 * - Accepts payload: { to: string[], subject: string, text: string }
 * - Optional: { html?: string, attachments?: Array<nodemailer.AttachmentLike> }
 * - If html is provided, sends HTML (with optional inline images via cid).
 * - If html is not provided, sends text-only.
 *
 * Environment:
 *   GMAIL_USER, GMAIL_APP_PASSWORD, GMAIL_FROM_NAME (optional)
 *
 * Smoke testing:
 *   - POST /email with a full payload
 *   - GET  /smoke to send a test message to GMAIL_USER
 */
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;
const displayName = process.env.GMAIL_FROM_NAME || 'ProHealth Support';

if (!user || !pass) {
  console.error('Missing GMAIL_USER or GMAIL_APP_PASSWORD in environment.');
  process.exit(1);
}

const tx = nodemailer.createTransport({
  service: 'gmail',
  auth: { user, pass }
});

app.post('/email', async (req, res) => {
  try {
    const body = req && req.body ? req.body : {};
    const to = Array.isArray(body.to) ? body.to.filter(Boolean) : [];
    const subject = body.subject ? String(body.subject) : 'Support message';
    const text = body.text ? String(body.text) : '';
    const html = body.html ? String(body.html) : '';
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];

    if (!to.length) {
      return res.status(400).send('missing to');
    }

    const mailOptions = {
      from: { name: displayName, address: user },
      to: to.join(','),
      subject
    };

    if (html) {
      mailOptions.html = html;
      if (text) mailOptions.text = text; // plain-text fallback
      if (attachments.length) mailOptions.attachments = attachments;
    } else {
      mailOptions.text = text || '(no content)';
    }

    await tx.sendMail(mailOptions);
    res.send('ok');
  } catch (e) {
    console.error('send fail:', e && e.message ? e.message : e);
    res.status(500).send('error');
  }
});

/**
 * GET /smoke
 * Sends a simple HTML email with the inline logo to the configured GMAIL_USER.
 * Useful to quickly verify that mailer + credentials + HTML + CID work.
 */
app.get('/smoke', async (_req, res) => {
  try {
    const logo = {
      filename: 'prohealth-logo.png',
      content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
      encoding: 'base64',
      cid: 'prohealth-logo',
      contentType: 'image/png'
    };
    await tx.sendMail({
      from: { name: displayName, address: user },
      to: user,
      subject: 'Mailer Smoke Test',
      text: 'HTML inline-logo smoke test.',
      html: '<div style="font-family:Arial">Smoke OK<br/><img src="cid:prohealth-logo" alt="logo" style="max-width:180px;"/></div>',
      attachments: [logo]
    });
    res.send('smoke-ok');
  } catch (e) {
    console.error('smoke fail:', e && e.message ? e.message : e);
    res.status(500).send('smoke-error');
  }
});

app.listen(8089, '127.0.0.1', () => {
  console.log('mailer up on 127.0.0.1:8089');
});
