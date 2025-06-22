// ✅ src/services/NotificationService.js
const WhatsAppAPI = require('../api/WhatsAppAPI');

async function sendReminder({ phoneNumber, time }) {
  const message = `📅 Reminder: You have an appointment scheduled at ${new Date(time).toLocaleString()}.`;
  try {
    await WhatsAppAPI.sendMessage(phoneNumber, message);
    return true;
  } catch (error) {
    console.error('Failed to send reminder:', error);
    return false;
  }
}

module.exports = { sendReminder };
