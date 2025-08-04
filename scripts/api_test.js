import axios from "axios";
import dotenv from "dotenv";
import base64 from "base-64";

dotenv.config();

const practitionerId = "1446168189565142292"; // Jolinna Chan

async function fetchAppointmentTypesForPractitioner() {
  const apiKey = process.env.CLINIKO_API_KEY;

  if (!apiKey) {
    console.error("❌ Missing CLINIKO_API_KEY in .env");
    return;
  }

  const authHeader = "Basic " + base64.encode(`${apiKey}:`);
  const headers = {
    Authorization: authHeader,
    Accept: "application/json",
    "User-Agent": "PHCDevBot (rrv1979@gmail.com)"
  };

  const url = `https://api.cliniko.com/v1/practitioners/${practitionerId}/appointment_types`;

  try {
    const response = await axios.get(url, { headers });
    console.log("✅ Appointment types fetched:");
    console.dir(response.data, { depth: null });
  } catch (error) {
    console.error("❌ Error fetching appointment types:", error.message);
    if (error.response) {
      console.error("🔎 Response:", JSON.stringify(error.response.data));
    }
  }
}

fetchAppointmentTypesForPractitioner();
