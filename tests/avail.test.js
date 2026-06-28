// File: tests/avail.test.js

const dotenv = require('dotenv');
dotenv.config();

const Logger = require('../src/core/Logger.js');
const ClinikoAPI = require('../src/api/ClinikoAPI.js');

const logger = new Logger('cliniko-test');
const cliniko = new ClinikoAPI();

/**
 * Helper to format a date as YYYY-MM-DD
 */
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Standard logger for result blocks
 */
function logBlocks(title, blocks, blockFormatter) {
  if (Array.isArray(blocks) && blocks.length > 0) {
    logger.info(`✅ Found ${blocks.length} ${title}:`);
    blocks.forEach(blockFormatter);
  } else {
    logger.warn(`⚠️ No ${title} found in the given range.`);
  }
}

async function main() {
  logger.info('📦 Running ClinikoAPI endpoint tests...');

  // --- Test: Appointment Types
  try {
    const types = await cliniko.getAppointmentTypes({
      practitioner_id: '1547593080683627726'
    });
    logBlocks('appointment types', types.slice(0, 1), (block, i) =>
      logger.info(`  ${i + 1}. ${block.starts_at} - ${block.ends_at} for ${block.id}`)
    );
  } catch (err) {
    logger.error(`❌ Failed to fetch appointment types: ${err.message}`);
  }

  // --- Test: Availability Blocks
  const today = new Date();
  const from = formatDate(today);
  const to = formatDate(new Date(today.setDate(today.getDate() + 10)));

  try {
    const blocks = await cliniko.getAvailabilityBlocks({
      practitioner_id: '1547593080683627726',
      business_id: '76182',
      from,
      to
    });
    logBlocks('availability blocks', blocks, (block, i) =>
      logger.info(`  ${i + 1}. ${block.starts_at} - ${block.ends_at} for`, block.practitioner)
    );
  } catch (err) {
    logger.error(`❌ Failed to fetch availability blocks: ${err.message}`);
  }
}

if (require.main === module) main();
