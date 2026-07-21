const { safeParse, preview, loadCore, getSessionByPhone, forceTestRecipient } = require('./_email_test_util');

(async () => {
  const phone = process.argv[2] || '+85298377469';
  const { engine, sessionManager, db } = await loadCore();
  const session = await getSessionByPhone(sessionManager, phone);
  if (!session) { console.error('FAIL: session not found for', phone); process.exit(1); }

  const data = safeParse(session.data);
  const appt = {
    id: 'TEST-CANCEL-FAIL-1',
    starts_at: new Date().toISOString(),
    appointment_type: data?.selected_appt_type?.name || 'Initial 60 Min Visit (New Clients)',
    practitioner: data?.selected_physio?.display_name || 'Sample Physio',
    clinic: data?.selected_clinic?.business_name || 'Prohealth In Touch Physiotherapy',
    note: 'User attempted cancellation, system returned failure.'
  };

  const payload = await engine._composeSupportEmailPayloadCancelled(session, data, appt);
  const forced = forceTestRecipient(payload, (payload.to && payload.to[0]) || 'support@prohealth.com.sg');
  preview('CANCEL FAILED → CONTACT', forced);

  await engine._postEmail(forced);
  await db.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(2); });
