// scripts/api_available_appointments.js
import axios from "axios";
import dotenv from "dotenv";
import base64 from "base-64";

dotenv.config();

const businessId = "77531"; // replace with real known business ID
const practitionerId = "1446168189565142292"; // Jolinna Chan
const appointmentTypeId = "359328"; // Physio 30 mins — use real ID

const from = new Date().toISOString().split("T")[0]; // today
const to = new Date(Date.now() + 7 * 86400 * 1000).toISOString().split("T")[0]; // 7 days later

async function fetchAvailableAppointments() {
  const apiKey = process.env.CLINIKO_API_KEY;
  if (!apiKey) return console.error("❌ Missing CLINIKO_API_KEY in .env");

  const authHeader = "Basic " + base64.encode(`${apiKey}:`);
  const headers = {
    Authorization: authHeader,
    Accept: "application/json",
    "User-Agent": "PHCDevBot (rrv1979@gmail.com)"
  };

  const url = `https://api.cliniko.com/v1/available_appointments`;
  const params = {
    business_id: businessId,
    practitioner_id: practitionerId,
    appointment_type_id: appointmentTypeId,
    from,
    to
  };

  try {
    const response = await axios.get(url, { headers, params });
    console.log("✅ Available appointments:");
    console.dir(response.data, { depth: null });
  } catch (error) {
    console.error("❌ Error fetching available appointments:", error.message);
    if (error.response) {
      console.error("🔎 Response:", JSON.stringify(error.response.data));
    }
  }
}

fetchAvailableAppointments();
