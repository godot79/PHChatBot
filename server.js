// Physiotherapy Chatbot with Cliniko Phone Verification
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new sqlite3.Database(process.env.DB_PATH || './chatbot.db');

// Initialize database tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    patient_id TEXT,
    phone_number TEXT,
    verified BOOLEAN,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    message TEXT,
    response TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS verification_codes (
    id TEXT PRIMARY KEY,
    phone_number TEXT,
    code TEXT,
    patient_id TEXT,
    attempts INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  )`);
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? 
    ['https://your-domain.com'] : 
    ['http://localhost:3000', 'http://127.0.0.1:3000']
}));
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

// Stricter rate limiting for verification endpoints
const verificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // limit each IP to 5 verification attempts per hour
  message: { error: 'Too many verification attempts, please try again later.' }
});

// Environment variables validation
const requiredEnvVars = ['CLINIKO_API_KEY', 'CLINIKO_SUBDOMAIN', 'JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
  console.error('Please copy .env.example to .env and fill in the required values.');
  process.exit(1);
}

// Cliniko API helper
class ClinikoAPI {
  constructor(apiKey, subdomain) {
    this.apiKey = apiKey;
    this.baseURL = `https://api.${subdomain}.cliniko.com/v1`;
    this.headers = {
      'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
  }

  async findPatientByPhone(phoneNumber) {
    try {
      // Clean phone number (remove spaces, dashes, etc.)
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      
      // In development mode, allow test numbers
      if (process.env.NODE_ENV === 'development' && phoneNumber.includes('555')) {
        return {
          id: 'test-patient-1',
          first_name: 'Test',
          last_name: 'Patient',
          phone_number: phoneNumber,
          mobile_phone_number: phoneNumber
        };
      }
      
      // Search patients by phone number
      const response = await axios.get(`${this.baseURL}/patients`, {
        headers: this.headers,
        params: {
          q: phoneNumber,
          per_page: 50
        }
      });

      // Filter results to match phone number exactly
      const patients = response.data.patients || [];
      const matchingPatient = patients.find(patient => {
        const patientPhone = (patient.phone_number || '').replace(/\D/g, '');
        const patientMobile = (patient.mobile_phone_number || '').replace(/\D/g, '');
        return patientPhone === cleanPhone || patientMobile === cleanPhone;
      });

      return matchingPatient;
    } catch (error) {
      console.error('Cliniko API error:', error.response?.data || error.message);
      throw new Error('Failed to verify patient information');
    }
  }

  async getPatientAppointments(patientId) {
    try {
      // In development mode, return mock appointments
      if (process.env.NODE_ENV === 'development' && patientId === 'test-patient-1') {
        return [{
          id: 'test-appt-1',
          starts_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          practitioner: {
            first_name: 'Dr. Sarah',
            last_name: 'Johnson'
          }
        }];
      }

      const response = await axios.get(`${this.baseURL}/patients/${patientId}/appointments`, {
        headers: this.headers,
        params: {
          sort: 'starts_at',
          per_page: 10
        }
      });
      return response.data.appointments || [];
    } catch (error) {
      console.error('Failed to fetch appointments:', error.message);
      return [];
    }
  }
}

const cliniko = new ClinikoAPI(process.env.CLINIKO_API_KEY, process.env.CLINIKO_SUBDOMAIN);

// Utility functions
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendSMSVerificationCode(phoneNumber, code) {
  if (process.env.NODE_ENV === 'development') {
    console.log(`🔐 DEV MODE - SMS Code for ${phoneNumber}: ${code}`);
    return true;
  }
  
  // Production SMS integration (Twilio example)
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      
      await client.messages.create({
        body: `Your ${process.env.CLINIC_NAME || 'physiotherapy clinic'} verification code is: ${code}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phoneNumber
      });
      
      return true;
    } catch (error) {
      console.error('SMS sending failed:', error.message);
      return false;
    }
  }
  
  // For demo purposes without Twilio
  console.log(`📱 Would send SMS to ${phoneNumber}: ${code}`);
  return true;
}

// Database helper functions
function saveSession(sessionData) {
  return new Promise((resolve, reject) => {
    const { id, patientId, phoneNumber, verified, expiresAt } = sessionData;
    db.run(
      'INSERT OR REPLACE INTO sessions (id, patient_id, phone_number, verified, expires_at) VALUES (?, ?, ?, ?, ?)',
      [id, patientId, phoneNumber, verified, expiresAt],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

function getSession(sessionId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM sessions WHERE id = ? AND expires_at > datetime("now")',
      [sessionId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

function saveChatHistory(sessionId, message, response) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO chat_history (session_id, message, response) VALUES (?, ?, ?)',
      [sessionId, message, response],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

// API Routes

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Step 1: Request phone verification
app.post('/api/verify-phone', verificationLimiter, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Find patient in Cliniko
    const patient = await cliniko.findPatientByPhone(phoneNumber);
    
    if (!patient) {
      return res.status(404).json({ 
        error: 'Phone number not found in our records. Please contact the clinic to verify your details.',
        verified: false 
      });
    }

    // Generate and save verification code
    const verificationCode = generateVerificationCode();
    const codeId = `${phoneNumber}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    
    db.run(
      'INSERT INTO verification_codes (id, phone_number, code, patient_id, expires_at) VALUES (?, ?, ?, ?, ?)',
      [codeId, phoneNumber, verificationCode, patient.id, expiresAt]
    );

    const smsSent = await sendSMSVerificationCode(phoneNumber, verificationCode);
    
    if (!smsSent) {
      return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
    }

    res.json({
      message: 'Verification code sent to your phone',
      codeId,
      patientName: `${patient.first_name} ${patient.last_name}`,
      verified: false
    });

  } catch (error) {
    console.error('Phone verification error:', error.message);
    res.status(500).json({ error: 'Failed to verify phone number' });
  }
});

// Step 2: Verify SMS code
app.post('/api/verify-code', async (req, res) => {
  try {
    const { codeId, code } = req.body;
    
    if (!codeId || !code) {
      return res.status(400).json({ error: 'Code ID and verification code are required' });
    }

    // Get verification record
    db.get(
      'SELECT * FROM verification_codes WHERE id = ? AND expires_at > datetime("now")',
      [codeId],
      async (err, verification) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        
        if (!verification) {
          return res.status(404).json({ error: 'Invalid or expired verification request' });
        }

        // Update attempts
        const newAttempts = verification.attempts + 1;
        db.run('UPDATE verification_codes SET attempts = ? WHERE id = ?', [newAttempts, codeId]);

        if (newAttempts > 3) {
          db.run('DELETE FROM verification_codes WHERE id = ?', [codeId]);
          return res.status(429).json({ error: 'Too many failed attempts' });
        }

        if (verification.code !== code) {
          return res.status(400).json({ error: 'Invalid verification code' });
        }

        // Create authenticated session
        const sessionToken = jwt.sign(
          { 
            patientId: verification.patient_id,
            phoneNumber: verification.phone_number,
            verified: true 
          },
          process.env.JWT_SECRET,
          { expiresIn: '24h' }
        );

        // Save session to database
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await saveSession({
          id: sessionToken,
          patientId: verification.patient_id,
          phoneNumber: verification.phone_number,
          verified: true,
          expiresAt
        });

        // Clean up verification code
        db.run('DELETE FROM verification_codes WHERE id = ?', [codeId]);

        res.json({
          message: 'Phone number verified successfully',
          sessionToken,
          verified: true
        });
      }
    );

  } catch (error) {
    console.error('Code verification error:', error.message);
    res.status(500).json({ error: 'Failed to verify code' });
  }
});

// Chatbot endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionToken } = req.body;
    
    if (!sessionToken) {
      return res.status(401).json({ 
        error: 'Please verify your phone number first',
        requiresVerification: true 
      });
    }

    // Verify session
    const session = await getSession(sessionToken);
    if (!session || !session.verified) {
      return res.status(401).json({ 
        error: 'Invalid or expired session',
        requiresVerification: true 
      });
    }

    // Process chatbot message
    const response = await processChatMessage(message, session);
    
    // Save chat history
    await saveChatHistory(sessionToken, message, response);
    
    res.json({
      response,
      sessionValid: true
    });

  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// Simple chatbot logic
async function processChatMessage(message, session) {
  const lowerMessage = message.toLowerCase();
  
  try {
    if (lowerMessage.includes('appointment') || lowerMessage.includes('booking')) {
      const appointments = await cliniko.getPatientAppointments(session.patient_id);
      
      if (appointments.length === 0) {
        return `I don't see any upcoming appointments for you. Would you like me to help you book one? Please call our clinic at ${process.env.CLINIC_PHONE || '(555) 123-4567'}.`;
      }
      
      const nextAppt = appointments[0];
      const apptDate = new Date(nextAppt.starts_at).toLocaleDateString();
      const apptTime = new Date(nextAppt.starts_at).toLocaleTimeString();
      
      return `Your next appointment is on ${apptDate} at ${apptTime} with ${nextAppt.practitioner?.first_name || 'your practitioner'}. Is there anything specific you'd like to know about this appointment?`;
    }
    
    if (lowerMessage.includes('cancel') || lowerMessage.includes('reschedule')) {
      return `To cancel or reschedule your appointment, please call our clinic at ${process.env.CLINIC_PHONE || '(555) 123-4567'} at least 24 hours in advance. Our staff will be happy to help you find a new time that works.`;
    }
    
    if (lowerMessage.includes('location') || lowerMessage.includes('address') || lowerMessage.includes('where')) {
      return `Our clinic is located at ${process.env.CLINIC_ADDRESS || '123 Health Street, Wellness City'}. We have parking available and are accessible by public transport. Do you need directions?`;
    }
    
    if (lowerMessage.includes('hours') || lowerMessage.includes('open') || lowerMessage.includes('time')) {
      return `Our clinic hours are:\n${process.env.CLINIC_HOURS || 'Monday-Friday: 8:00 AM - 6:00 PM\nSaturday: 9:00 AM - 2:00 PM\nSunday: Closed'}\n\nIs there anything else I can help you with?`;
    }
    
    if (lowerMessage.includes('pain') || lowerMessage.includes('exercise') || lowerMessage.includes('treatment')) {
      return "I understand you're asking about pain or exercises. While I can provide general information, it's important that you discuss your specific condition with your physiotherapist. Would you like to schedule an appointment or do you have questions about your current treatment plan?";
    }

    if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('hey')) {
      return "Hello! I'm here to help with your physiotherapy needs. I can assist with appointment information, clinic details, and general questions about our services. What would you like to know?";
    }

    if (lowerMessage.includes('thank') || lowerMessage.includes('thanks')) {
      return "You're welcome! Is there anything else I can help you with today?";
    }
    
    // Default response
    return "I'm here to help with appointment information, clinic details, and general questions about our physiotherapy services. You can ask me about:\n• Your appointments\n• Clinic hours and location\n• How to cancel or reschedule\n• General treatment information\n\nWhat would you like to know?";
    
  } catch (error) {
    console.error('Chat processing error:', error.message);
    return "I'm having trouble accessing your information right now. Please try again or call our clinic directly.";
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: require('./package.json').version
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('📊 Database connection closed.');
    }
    process.exit(0);
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Physiotherapy chatbot server running on port ${PORT}`);
  console.log(`🌐 Frontend available at: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('\n📋 Development mode active:');
    console.log('   • SMS codes will be logged to console');
    console.log('   • Test phone numbers (555-xxx-xxxx) will work');
    console.log('   • Mock patient data will be returned');
  }
  
  console.log('\n🔧 Make sure these environment variables are set:');
  console.log('   • CLINIKO_API_KEY');
  console.log('   • CLINIKO_SUBDOMAIN');
  console.log('   • JWT_SECRET');
});

module.exports = app;
