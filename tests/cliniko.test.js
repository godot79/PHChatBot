// File: tests/cliniko.test.js

const dotenv = require('dotenv');
dotenv.config();

const Logger = require('../src/core/Logger.js');
const ClinikoAPI = require('../src/api/ClinikoAPI.js');

const logger = new Logger('cliniko-test');
const cliniko = new ClinikoAPI();

const TEST_PATIENT_EMAIL = process.env.TEST_PATIENT_EMAIL;

/**
 * Helper to format a date as YYYY-MM-DD
 */
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function logBlocks(title, blocks, blockFormatter) {
  if (Array.isArray(blocks) && blocks.length > 0) {
    logger.info(`✅ Found ${blocks.length} ${title}:`);
    blocks.forEach(blockFormatter);
  } else {
    logger.warn(`⚠️ No ${title} found.`);
  }
}

async function main() {
  logger.info('📦 Running ClinikoAPI endpoint tests...');

  // --- Clinics
  logger.info('\n🔹 Testing getClinics...');
  try {
    const clinics = await cliniko.getClinics();
    logBlocks('clinics', clinics, clinic =>
      logger.info(`  ▪ ${clinic.business_name ?? '(no name)'} (ID: ${clinic.id}) (OB:${clinic.show_in_online_bookings ?? '(no value)'})`)
    );
  } catch (err) {
    logger.error('❌ Failed to fetch clinics with names:', err);
  }

  // --- Clinics and practitioners per clinic
  logger.info('\n🔹 Listing clinics and practitioners per clinic...');
  try {
    const clinics = await cliniko.getClinics();
    const practitionersByClinicId = await cliniko.getPractitionersByClinic();
    clinics.forEach(clinic => {
      const practitioners = practitionersByClinicId[clinic.id] ?? [];
      logger.info(`Clinic: ${clinic.business_name ?? '(no name)'} (ID: ${clinic.id}), Practitioners:`);
      if (practitioners.length === 0) {
        logger.info(`  ▪ (none)`);
      } else {
        practitioners.forEach(p =>
          logger.info(`  ▪ ${p.first_name} ${p.last_name} (ID: ${p.id})`)
        );
      }
    });
  } catch (err) {
    logger.error(`❌ Failed to list clinics and practitioners: ${err}`);
  }

  // --- Fees (mocked)
  logger.info('\n🔹 Testing getFeesByClinic (mocked)...');
  try {
    const fees = await cliniko.getFeesByClinic();
    logger.info('✅ Fees retrieved:', fees);
  } catch (err) {
    logger.error('❌ Failed to fetch fees:', err);
  }

  // --- Patient verification and bookings
  logger.info('\n🔹 Testing verifyPatientByEmail and getBookingsByPatientId...');
  if (!TEST_PATIENT_EMAIL) {
    logger.error('❌ TEST_PATIENT_EMAIL not set in .env');
  } else {
    try {
      const patient = await cliniko.findPatientByEmail(TEST_PATIENT_EMAIL);
      if (!patient || !patient.id) throw new Error('Patient not found');
      logger.info(`✅ Verified patient: ${patient.first_name} ${patient.last_name} (${patient.id})`);
      const bookings = await cliniko.getBookingsByPatientId(patient.id);
      logger.info(`✅ Retrieved ${bookings.length} bookings for ${patient.first_name}`);
    } catch (err) {
      logger.error('❌ Failed to verify patient or fetch bookings:', err);
    }
  }

  // --- Available Times
  logger.info('\n🔹 Testing getAvailable Times for Michi Cole at Prohealth Physiofocus...');
  const today = new Date();
  const from = formatDate(new Date(today.setDate(today.getDate() + 1)));
  const to = formatDate(new Date(today.setDate(today.getDate() + 5)));

  try {
    const blocks = await cliniko.getAvailableTimes({
      practitioner_id: '120681',
      business_id: '76182',
      appt_type: '1710554058701407263',
      from,
      to
    });
    logBlocks('availability slots', blocks, (block, i) =>
      logger.info(`  ${i + 1}. ${block.appointment_start}`)
    );
  } catch (err) {
    logger.error(`❌ Failed to fetch available times: ${err.message}`);
  }

  // --- Appointment Types
  logger.info('\n🔹 Testing Appointment Types for Michi Cole at Prohealth Physiofocus...');
  try {
    const types = await cliniko.getAppointmentTypes({
      practitioner_id: '120681'
    });
    logBlocks('appt types', types, (block, i) =>
      logger.info(`  ${i + 1}. ${block.name}  ${block.id}`)
    );
  } catch (err) {
    logger.error(`❌ Failed to fetch appt types: ${err.message}`);
  }

  // --- Next Appointment slots for practitioner
  logger.info('\n🔹 Testing Next Appointment slots for Michi Cole at Prohealth Physiofocus...');
  try {
    const slots = await cliniko.getNextAvailableSlots({
      practitioner_id: '120681',
      business_id: '76182'
    });
    logBlocks('slots', slots, (block, i) =>
      logger.info(`  ${i + 1}. ${block.practitioner_id} ${block.practitioner_name} ${block.appointment_type_id} ${block.appointment_type_name} ${block.slot}`)
    );
  } catch (err) {
    logger.error(`❌ Failed to fetch appt types: ${err.message}`);
  }

  // --- Next Appointment slots for business
  logger.info('\n🔹 Testing Next Appointment slots at Prohealth Physiofocus...');
  try {
    const slots = await cliniko.getNextAvailableSlotsByBusiness({
      business_id: '76182',
      maxSlots: 3
    });
    logBlocks('slots', slots, (block, i) =>
      logger.info(`  ${i + 1}. ${block.practitioner_id} ${block.practitioner_name} ${block.appointment_type_id} ${block.appointment_type_name} ${block.slot}`)
    );
  } catch (err) {
    logger.error(`❌ Failed to fetch appt types: ${err.message}`);
  }
}

main();
