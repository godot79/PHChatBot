// File: /opt/prohealth-mailer/EmailTemplates.js
//
// Modular HTML email templates for Prohealth appointment notifications.
// Each exported function returns { subject, html, text } ready to POST to /email.
//
// Logo is embedded via CID (cid:prohealth-logo). The mailer service attaches
// the logo file and nodemailer resolves the CID reference inline.
//
// Usage:
//   const { bookingConfirmed } = require('./EmailTemplates');
//   const payload = bookingConfirmed({ practitioner, clinic, dateTime });
//   // payload: { subject, html, text }

'use strict';

// ─── Shared layout helpers ────────────────────────────────────────────────────

const BRAND_COLOR      = '#005587';   // Prohealth navy
const ACCENT_COLOR     = '#00AEEF';   // Prohealth teal
const SUCCESS_COLOR    = '#27AE60';
const CANCEL_COLOR     = '#E74C3C';
const RESCHEDULE_COLOR = '#F39C12';
const FONT_STACK       = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

/**
 * Wraps content in the shared Prohealth email chrome:
 *   - White card on a light-grey background
 *   - Logo at top
 *   - Coloured header bar with title
 *   - Body content
 *   - Footer with support link
 *
 * @param {object} opts
 * @param {string} opts.headerColor  - hex colour for the header bar
 * @param {string} opts.headerIcon   - emoji shown before the title
 * @param {string} opts.headerTitle  - bold title text in the header bar
 * @param {string} opts.bodyHtml     - inner HTML injected into the card body
 * @returns {string} complete HTML document string
 */
function wrapTemplate({ headerColor, headerIcon, headerTitle, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${headerTitle}</title>
  <!--[if mso]>
  <noscript>
    <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:${FONT_STACK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!-- Card -->
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;
                      box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden;">

          <!-- Logo row -->
          <tr>
            <td align="center" style="background:#ffffff;padding:28px 32px 20px;">
              <img src="cid:prohealth-logo" alt="Prohealth" width="180"
                   style="display:block;max-width:180px;height:auto;border:0;"/>
            </td>
          </tr>

          <!-- Coloured header bar -->
          <tr>
            <td style="background:${headerColor};padding:20px 32px;">
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;
                         line-height:1.3;letter-spacing:0.3px;">
                ${headerIcon}&nbsp; ${headerTitle}
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 32px 24px;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 32px;">
              <hr style="border:none;border-top:1px solid #e8ecef;margin:0;"/>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 28px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#8a9ab0;line-height:1.6;">
                Need help? Reply to this email or message us on WhatsApp.<br/>
                &copy; ${new Date().getFullYear()} Prohealth Asia. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Renders a detail row inside the appointment info table.
 * @param {string} label
 * @param {string} value
 * @returns {string}
 */
function detailRow(label, value) {
  if (!value) return '';
  return `
    <tr>
      <td style="padding:8px 12px;font-size:13px;color:#8a9ab0;
                 font-weight:600;white-space:nowrap;width:130px;
                 vertical-align:top;">${label}</td>
      <td style="padding:8px 12px;font-size:14px;color:#2c3e50;
                 vertical-align:top;">${value}</td>
    </tr>`;
}

/**
 * Renders the appointment details info-box used in all three templates.
 * @param {object} fields - key/value pairs of label → value
 * @returns {string}
 */
function appointmentBox(fields) {
  const rows = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([label, value]) => detailRow(label, value))
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;
                  margin:20px 0;overflow:hidden;">
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Simple paragraph helper.
 * @param {string} text
 * @param {object} [style={}]
 * @returns {string}
 */
function p(text, style = {}) {
  const css = Object.entries({
    margin: '0 0 14px',
    'font-size': '15px',
    'line-height': '1.6',
    color: '#2c3e50',
    ...style
  }).map(([k, v]) => `${k}:${v}`).join(';');
  return `<p style="${css}">${text}</p>`;
}

// ─── Exported template functions ──────────────────────────────────────────────

/**
 * Booking confirmation email.
 *
 * @param {object} opts
 * @param {string} opts.practitioner  - e.g. "Dr. Jane Smith"
 * @param {string} opts.clinic        - e.g. "Prohealth In Touch Physiotherapy"
 * @param {string} opts.dateTime      - human-readable date/time string
 * @param {string} [opts.apptType]    - e.g. "Initial Physiotherapy"
 * @returns {{ subject: string, html: string, text: string }}
 */
function bookingConfirmed({ practitioner, clinic, dateTime, apptType }) {
  const subject = 'Your Appointment is Confirmed – Prohealth';

  const bodyHtml = `
    ${p('Hi there,')}
    ${p('Great news! Your appointment has been successfully booked. Here are your details:')}
    ${appointmentBox({
      'Practitioner': practitioner,
      'Clinic':       clinic,
      'Date & Time':  dateTime,
      'Type':         apptType,
    })}
    ${p('Please arrive <strong>10 minutes early</strong> to complete any necessary paperwork.')}
    ${p('If you need to cancel or reschedule, simply message us on WhatsApp and we\'ll take care of it for you.')}
    ${p('We look forward to seeing you! 😊', { 'margin-bottom': '0' })}
  `;

  const text =
    `Your Appointment is Confirmed – Prohealth\n\n` +
    `Hi there,\n\n` +
    `Your appointment has been successfully booked.\n\n` +
    `Practitioner : ${practitioner || '—'}\n` +
    `Clinic       : ${clinic || '—'}\n` +
    `Date & Time  : ${dateTime || '—'}\n` +
    (apptType ? `Type         : ${apptType}\n` : '') +
    `\nPlease arrive 10 minutes early to complete any necessary paperwork.\n\n` +
    `To cancel or reschedule, message us on WhatsApp.\n\n` +
    `We look forward to seeing you!\n\nProhealth`;

  const html = wrapTemplate({
    headerColor: SUCCESS_COLOR,
    headerIcon:  '✅',
    headerTitle: 'Appointment Confirmed',
    bodyHtml,
  });

  return { subject, html, text };
}

/**
 * Cancellation confirmation email.
 *
 * @param {object} opts
 * @param {string} opts.practitioner
 * @param {string} opts.clinic
 * @param {string} opts.dateTime
 * @param {string} [opts.apptType]
 * @returns {{ subject: string, html: string, text: string }}
 */
function appointmentCancelled({ practitioner, clinic, dateTime, apptType }) {
  const subject = 'Your Appointment Has Been Cancelled – Prohealth';

  const bodyHtml = `
    ${p('Hi there,')}
    ${p('Your appointment has been successfully cancelled. Here are the details of the cancelled booking:')}
    ${appointmentBox({
      'Practitioner': practitioner,
      'Clinic':       clinic,
      'Date & Time':  dateTime,
      'Type':         apptType,
    })}
    ${p('If this was a mistake or you\'d like to rebook, just message us on WhatsApp and we\'ll get you a new slot as soon as possible.')}
    ${p('We hope to see you again soon.', { 'margin-bottom': '0' })}
  `;

  const text =
    `Your Appointment Has Been Cancelled – Prohealth\n\n` +
    `Hi there,\n\n` +
    `Your appointment has been cancelled.\n\n` +
    `Practitioner : ${practitioner || '—'}\n` +
    `Clinic       : ${clinic || '—'}\n` +
    `Date & Time  : ${dateTime || '—'}\n` +
    (apptType ? `Type         : ${apptType}\n` : '') +
    `\nIf this was a mistake or you'd like to rebook, message us on WhatsApp.\n\n` +
    `We hope to see you again soon.\n\nProhealth`;

  const html = wrapTemplate({
    headerColor: CANCEL_COLOR,
    headerIcon:  '❌',
    headerTitle: 'Appointment Cancelled',
    bodyHtml,
  });

  return { subject, html, text };
}

/**
 * Cancellation blocked by the 24-hour policy — contact-required notice.
 * Sent when a patient tries to cancel via WhatsApp within 24h of the
 * appointment start; the bot does not cancel it, so front desk needs to
 * follow up directly (cancellation fees may apply).
 *
 * @param {object} opts
 * @param {string} opts.practitioner
 * @param {string} opts.clinic
 * @param {string} opts.dateTime
 * @param {string} [opts.apptType]
 * @returns {{ subject: string, html: string, text: string }}
 */
function cancellationBlocked({ practitioner, clinic, dateTime, apptType }) {
  const subject = 'Cancellation Request Within 24 Hours – Contact Required – Prohealth';

  const bodyHtml = `
    ${p('Hi there,')}
    ${p('A patient tried to cancel the appointment below via WhatsApp, but it starts within the next 24 hours, so it was not cancelled automatically. Cancellation fees may apply — please contact the patient directly to confirm.')}
    ${appointmentBox({
      'Practitioner': practitioner,
      'Clinic':       clinic,
      'Date & Time':  dateTime,
      'Type':         apptType,
    })}
    ${p('Please follow up with the patient as soon as possible.', { 'margin-bottom': '0' })}
  `;

  const text =
    `Cancellation Request Within 24 Hours – Contact Required – Prohealth\n\n` +
    `Hi there,\n\n` +
    `A patient tried to cancel the appointment below via WhatsApp, but it starts within the next 24 hours, so it was not cancelled automatically. Cancellation fees may apply — please contact the patient directly to confirm.\n\n` +
    `Practitioner : ${practitioner || '—'}\n` +
    `Clinic       : ${clinic || '—'}\n` +
    `Date & Time  : ${dateTime || '—'}\n` +
    (apptType ? `Type         : ${apptType}\n` : '') +
    `\nPlease follow up with the patient as soon as possible.\n\nProhealth`;

  const html = wrapTemplate({
    headerColor: CANCEL_COLOR,
    headerIcon:  '⚠️',
    headerTitle: 'Cancellation Needs Attention',
    bodyHtml,
  });

  return { subject, html, text };
}

/**
 * Reschedule blocked by the 24-hour policy — contact-required notice.
 * Sent when a patient tries to reschedule via WhatsApp within 24h of the
 * appointment start; the bot does not reschedule it, so front desk needs to
 * follow up directly (cancellation fees may apply).
 *
 * @param {object} opts
 * @param {string} opts.practitioner
 * @param {string} opts.clinic
 * @param {string} opts.dateTime
 * @param {string} [opts.apptType]
 * @returns {{ subject: string, html: string, text: string }}
 */
function rescheduleBlocked({ practitioner, clinic, dateTime, apptType }) {
  const subject = 'Reschedule Request Within 24 Hours – Contact Required – Prohealth';

  const bodyHtml = `
    ${p('Hi there,')}
    ${p('A patient tried to reschedule the appointment below via WhatsApp, but it starts within the next 24 hours, so it was not rescheduled automatically. Cancellation fees may apply — please contact the patient directly to confirm.')}
    ${appointmentBox({
      'Practitioner': practitioner,
      'Clinic':       clinic,
      'Date & Time':  dateTime,
      'Type':         apptType,
    })}
    ${p('Please follow up with the patient as soon as possible.', { 'margin-bottom': '0' })}
  `;

  const text =
    `Reschedule Request Within 24 Hours – Contact Required – Prohealth\n\n` +
    `Hi there,\n\n` +
    `A patient tried to reschedule the appointment below via WhatsApp, but it starts within the next 24 hours, so it was not rescheduled automatically. Cancellation fees may apply — please contact the patient directly to confirm.\n\n` +
    `Practitioner : ${practitioner || '—'}\n` +
    `Clinic       : ${clinic || '—'}\n` +
    `Date & Time  : ${dateTime || '—'}\n` +
    (apptType ? `Type         : ${apptType}\n` : '') +
    `\nPlease follow up with the patient as soon as possible.\n\nProhealth`;

  const html = wrapTemplate({
    headerColor: RESCHEDULE_COLOR,
    headerIcon:  '⚠️',
    headerTitle: 'Reschedule Needs Attention',
    bodyHtml,
  });

  return { subject, html, text };
}

/**
 * Reschedule confirmation email.
 *
 * @param {object} opts
 * @param {string} opts.practitioner
 * @param {string} opts.clinic
 * @param {string} opts.oldDateTime   - the original slot
 * @param {string} opts.newDateTime   - the new slot
 * @param {string} [opts.apptType]
 * @returns {{ subject: string, html: string, text: string }}
 */
function appointmentRescheduled({ practitioner, clinic, oldDateTime, newDateTime, apptType }) {
  const subject = 'Your Appointment Has Been Rescheduled – Prohealth';

  const bodyHtml = `
    ${p('Hi there,')}
    ${p('Your appointment has been successfully rescheduled. Here\'s a summary of the change:')}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr>
        <!-- Old slot -->
        <td width="48%" valign="top"
            style="background:#fff5f5;border:1px solid #fcd5d5;border-radius:6px;
                   padding:14px 16px;">
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:${CANCEL_COLOR};
                    text-transform:uppercase;letter-spacing:0.6px;">Previous slot</p>
          <p style="margin:0;font-size:14px;color:#2c3e50;line-height:1.5;">
            <s>${oldDateTime || '—'}</s>
          </p>
        </td>
        <td width="4%" align="center" valign="middle"
            style="font-size:22px;color:#8a9ab0;padding:0 6px;">→</td>
        <!-- New slot -->
        <td width="48%" valign="top"
            style="background:#f0fff4;border:1px solid #b7e8c8;border-radius:6px;
                   padding:14px 16px;">
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:${SUCCESS_COLOR};
                    text-transform:uppercase;letter-spacing:0.6px;">New slot</p>
          <p style="margin:0;font-size:14px;font-weight:700;color:#2c3e50;line-height:1.5;">
            ${newDateTime || '—'}
          </p>
        </td>
      </tr>
    </table>

    ${appointmentBox({
      'Practitioner': practitioner,
      'Clinic':       clinic,
      'Type':         apptType,
    })}
    ${p('Please arrive <strong>10 minutes early</strong> for your rescheduled appointment.')}
    ${p('If you need to make further changes, message us on WhatsApp anytime.', { 'margin-bottom': '0' })}
  `;

  const text =
    `Your Appointment Has Been Rescheduled – Prohealth\n\n` +
    `Hi there,\n\n` +
    `Your appointment has been rescheduled.\n\n` +
    `Previous slot : ${oldDateTime || '—'}\n` +
    `New slot      : ${newDateTime || '—'}\n\n` +
    `Practitioner : ${practitioner || '—'}\n` +
    `Clinic       : ${clinic || '—'}\n` +
    (apptType ? `Type         : ${apptType}\n` : '') +
    `\nPlease arrive 10 minutes early for your rescheduled appointment.\n\n` +
    `To make further changes, message us on WhatsApp.\n\nProhealth`;

  const html = wrapTemplate({
    headerColor: RESCHEDULE_COLOR,
    headerIcon:  '🔄',
    headerTitle: 'Appointment Rescheduled',
    bodyHtml,
  });

  return { subject, html, text };
}

module.exports = { bookingConfirmed, appointmentCancelled, cancellationBlocked, appointmentRescheduled, rescheduleBlocked };
