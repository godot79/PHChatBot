const { safeParse, preview, loadCore, getSessionByPhone, forceTestRecipient } = require('./_email_test_util');

(async () => {
  const phone = process.argv[2] || '+85298377469';
  const { engine, sessionManager, db } = await loadCore();

  const session = await getSessionByPhone(sessionManager, phone);
  if (!session) { console.error('FAIL: session not found for', phone); process.exit(1); }

  const data = safeParse(session.data);
  // Minimal appointment summary, adjust names from real state if present
  const appt = {
    id: 'TEST-CANCEL-OK-1',
    starts_at: new Date().toISOString(),
    appointment_type: data?.selected_appt_type?.name || 'Return Visit (Existing Clients)',
    practitioner: data?.selected_physio?.display_name || 'Sample Physio',
    clinic: data?.selected_clinic?.business_name || 'Prohealth In Touch Physiotherapy',
    patient_email: data?.email || session.email || ''
  };

  const payload = await engine._composeSupportEmailPayloadCancelled(session, data, appt);
  const intended = (payload.to && payload.to[0]) || 'support@prohealth.com.sg';
  const forced = forceTestRecipient(payload, intended);
  preview('CANCELLED', forced);

  // Actually send through local mailer
  await engine._postEmail(forced);
  await db.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(2); });
