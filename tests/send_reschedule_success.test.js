const { safeParse, preview, loadCore, getSessionByPhone, forceTestRecipient } = require('./_email_test_util');

(async () => {
  const phone = process.argv[2] || '+85298377469';
  const { engine, sessionManager, db } = await loadCore();
  const session = await getSessionByPhone(sessionManager, phone);
  if (!session) { console.error('FAIL: session not found for', phone); process.exit(1); }

  const data = safeParse(session.data);
  const oldAppt = {
    id: 'TEST-RESCHED-OLD-1',
    starts_at: new Date(Date.now() + 864e5).toISOString(),
    appointment_type: data?.selected_appt_type?.name || 'Return Visit (Existing Clients)',
    practitioner: data?.selected_physio?.display_name || 'Sample Physio',
    clinic: data?.selected_clinic?.business_name || 'Prohealth In Touch Physiotherapy'
  };
  const newAppt = {
    id: 'TEST-RESCHED-NEW-1',
    starts_at: new Date(Date.now() + 2*864e5).toISOString(),
    appointment_type: oldAppt.appointment_type,
    practitioner: oldAppt.practitioner,
    clinic: oldAppt.clinic
  };

  const payload = await engine._composeSupportEmailPayloadRescheduled(session, data, oldAppt, newAppt);
  const forced = forceTestRecipient(payload, (payload.to && payload.to[0]) || 'support@prohealth.com.sg');
  preview('RESCHEDULED', forced);

  await engine._postEmail(forced);
  await db.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(2); });
