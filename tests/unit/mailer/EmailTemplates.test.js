'use strict';

const { cancellationBlocked, rescheduleBlocked } = require('../../../prohealth-mailer/EmailTemplates');

describe('cancellationBlocked()', () => {
  const opts = {
    practitioner: 'Dr. Jane Tan',
    clinic: 'Prohealth Novena',
    dateTime: '21 Jul 2026, 2:00 PM',
    apptType: 'Follow-up Physio',
  };

  test('subject clearly signals contact is required, not a confirmed cancellation', () => {
    const { subject } = cancellationBlocked(opts);
    expect(subject).toMatch(/contact required/i);
    expect(subject).not.toMatch(/has been cancelled/i);
  });

  test('text body never claims the appointment was cancelled', () => {
    const { text } = cancellationBlocked(opts);
    expect(text).not.toMatch(/successfully cancelled|has been cancelled/i);
    expect(text).toMatch(/within the next 24 hours/i);
    expect(text).toMatch(/cancellation fees may apply/i);
  });

  test('text body includes appointment details', () => {
    const { text } = cancellationBlocked(opts);
    expect(text).toContain('Dr. Jane Tan');
    expect(text).toContain('Prohealth Novena');
    expect(text).toContain('21 Jul 2026, 2:00 PM');
    expect(text).toContain('Follow-up Physio');
  });

  test('omits the Type line when apptType is empty', () => {
    const { text } = cancellationBlocked({ ...opts, apptType: '' });
    expect(text).not.toMatch(/Type\s*:/);
  });

  test('falls back to em-dash for missing practitioner/clinic/dateTime', () => {
    const { text } = cancellationBlocked({});
    expect(text).toMatch(/Practitioner : —/);
    expect(text).toMatch(/Clinic\s*: —/);
    expect(text).toMatch(/Date & Time\s*: —/);
  });

  test('html renders without throwing and never claims the appointment was cancelled', () => {
    const { html } = cancellationBlocked(opts);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    expect(html).not.toMatch(/successfully cancelled/i);
    expect(html).toContain('Dr. Jane Tan');
  });
});

describe('rescheduleBlocked()', () => {
  const opts = {
    practitioner: 'Dr. Jane Tan',
    clinic: 'Prohealth Novena',
    dateTime: '21 Jul 2026, 2:00 PM',
    apptType: 'Follow-up Physio',
  };

  test('subject clearly signals contact is required, not a confirmed reschedule', () => {
    const { subject } = rescheduleBlocked(opts);
    expect(subject).toMatch(/contact required/i);
    expect(subject).not.toMatch(/has been rescheduled/i);
  });

  test('text body never claims the appointment was rescheduled', () => {
    const { text } = rescheduleBlocked(opts);
    expect(text).not.toMatch(/successfully rescheduled|has been rescheduled/i);
    expect(text).toMatch(/within the next 24 hours/i);
    expect(text).toMatch(/cancellation fees may apply/i);
  });

  test('text body includes appointment details', () => {
    const { text } = rescheduleBlocked(opts);
    expect(text).toContain('Dr. Jane Tan');
    expect(text).toContain('Prohealth Novena');
    expect(text).toContain('21 Jul 2026, 2:00 PM');
    expect(text).toContain('Follow-up Physio');
  });

  test('omits the Type line when apptType is empty', () => {
    const { text } = rescheduleBlocked({ ...opts, apptType: '' });
    expect(text).not.toMatch(/Type\s*:/);
  });

  test('falls back to em-dash for missing practitioner/clinic/dateTime', () => {
    const { text } = rescheduleBlocked({});
    expect(text).toMatch(/Practitioner : —/);
    expect(text).toMatch(/Clinic\s*: —/);
    expect(text).toMatch(/Date & Time\s*: —/);
  });

  test('html renders without throwing and never claims the appointment was rescheduled', () => {
    const { html } = rescheduleBlocked(opts);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    expect(html).not.toMatch(/successfully rescheduled/i);
    expect(html).toContain('Dr. Jane Tan');
  });
});

describe('brand name casing', () => {
  test('no template renders "ProHealth" (capital H) — must be "Prohealth" or "Prohealth Asia"', () => {
    const opts = { practitioner: 'X', clinic: 'Y', dateTime: 'Z', apptType: 'W' };
    const outputs = [
      cancellationBlocked(opts),
      rescheduleBlocked(opts),
    ];
    for (const { subject, text, html } of outputs) {
      expect(subject).not.toMatch(/ProHealth/);
      expect(text).not.toMatch(/ProHealth/);
      expect(html).not.toMatch(/ProHealth/);
    }
  });
});
