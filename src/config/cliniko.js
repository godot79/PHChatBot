module.exports = {
  apiKey: process.env.CLINIKO_API_KEY,
  baseUrl: process.env.CLINIKO_API_BASE || 'https://api.cliniko.com/v1',
  subdomain: process.env.CLINIKO_SUBDOMAIN || '',
  // Controls for getNextAvailableSlots
  maxSlotDays: process.env.CLINIKO_MAX_SLOT_DAYS ? Number(process.env.CLINIKO_MAX_SLOT_DAYS) : 5,
  maxSlots: process.env.CLINIKO_MAX_SLOTS ? Number(process.env.CLINIKO_MAX_SLOTS) : 5
};

