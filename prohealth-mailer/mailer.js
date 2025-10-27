const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');

const app = express();
app.use(bodyParser.json({ limit: '256kb' }));

const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;
const displayName = process.env.GMAIL_FROM_NAME || 'ProHealth Support';

if (!user || !pass) {
  console.error('Missing GMAIL_USER/GMAIL_APP_PASSWORD');
  process.exit(1);
}

const tx = nodemailer.createTransport({
  service: 'gmail',
  auth: { user, pass }
});

app.post('/email', async (req, res) => {
  try {
    const body = req && req.body ? req.body : {};
    const to = Array.isArray(body.to) ? body.to : [];
    const subject = body.subject ? String(body.subject) : 'Support message';
    const text = body.text ? String(body.text) : '';

    if (!to.length) {
      return res.status(400).send('missing to');
    }

    const fromHeader = { name: displayName, address: user };
    await tx.sendMail({
      from: fromHeader,           // or: `${displayName} <${user}>`
      to: to.join(','),
      subject,
      text
    });

    res.send('ok');
  } catch (e) {
    try {
      console.error('send fail', e && e.message ? e.message : e);
    } catch (_) {}
    res.status(500).send('error');
  }
});

app.listen(8089, '127.0.0.1', () => {
  console.log('mailer up on 127.0.0.1:8089');
});
