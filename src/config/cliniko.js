module.exports = {
  apiKey: process.env.CLINIKO_API_KEY,
  baseUrl: process.env.CLINIKO_API_BASE || 'https://api.cliniko.com/v1',
  subdomain: process.env.CLINIKO_SUBDOMAIN || '',
  // Controls for getNextAvailableSlots
  maxSlotDays: process.env.CLINIKO_MAX_SLOT_DAYS ? Number(process.env.CLINIKO_MAX_SLOT_DAYS) : 5,
  maxSlots: process.env.CLINIKO_MAX_SLOTS ? Number(process.env.CLINIKO_MAX_SLOTS) : 5,
  // How long a getAvailableTimes() result stays cached before being re-fetched.
  availableTimesCacheTtlMs: process.env.CLINIKO_AVAILABLE_TIMES_CACHE_TTL_MS
    ? Number(process.env.CLINIKO_AVAILABLE_TIMES_CACHE_TTL_MS)
    : 5 * 60 * 1000
};

