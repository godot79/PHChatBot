-- File: 001_create_sessions_table.sql
-- Migration: Create sessions table
-- Version: 1

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT UNIQUE NOT NULL,
    session_id TEXT UNIQUE NOT NULL,
    user_state TEXT DEFAULT 'initial',
    verification_status TEXT DEFAULT 'unverified',
    verification_attempts INTEGER DEFAULT 0,
    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    patient_id INTEGER,
    context_data TEXT, -- JSON string for session context
    FOREIGN KEY (patient_id) REFERENCES patients(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_phone_number ON sessions(phone_number);
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);

---

-- File: 002_create_conversations_table.sql
-- Migration: Create conversations table
-- Version: 2

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    message_id TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_type TEXT DEFAULT 'text',
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'sent',
    error_message TEXT,
    metadata TEXT, -- JSON string for additional message data
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_phone_number ON conversations(phone_number);
CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_message_id ON conversations(message_id);

---

-- File: 003_create_patients_table.sql
-- Migration: Create patients cache table
-- Version: 3

CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliniko_id INTEGER UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    phone_number TEXT,
    mobile_number TEXT,
    date_of_birth DATE,
    gender TEXT,
    address_line_1 TEXT,
    address_line_2 TEXT,
    city TEXT,
    state TEXT,
    post_code TEXT,
    country TEXT,
    emergency_contact TEXT,
    medical_alerts TEXT,
    notes TEXT,
    archived BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_patients_cliniko_id ON patients(cliniko_id);
CREATE INDEX IF NOT EXISTS idx_patients_phone_number ON patients(phone_number);
CREATE INDEX IF NOT EXISTS idx_patients_mobile_number ON patients(mobile_number);
CREATE INDEX IF NOT EXISTS idx_patients_email ON patients(email);
CREATE INDEX IF NOT EXISTS idx_patients_last_name ON patients(last_name);

---

-- File: 004_create_appointments_table.sql
-- Migration: Create appointments cache table
-- Version: 4

CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliniko_id INTEGER UNIQUE NOT NULL,
    patient_id INTEGER NOT NULL,
    practitioner_id INTEGER,
    appointment_type_id INTEGER,
    business_id INTEGER,
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    appointment_type_name TEXT,
    practitioner_name TEXT,
    business_name TEXT,
    notes TEXT,
    patient_arrived BOOLEAN DEFAULT FALSE,
    patient_arrived_at DATETIME,
    cancellation_reason TEXT,
    cancelled_at DATETIME,
    did_not_arrive BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id)
);

CREATE INDEX IF NOT EXISTS idx_appointments_cliniko_id ON appointments(cliniko_id);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_starts_at ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_practitioner_id ON appointments(practitioner_id);
CREATE INDEX IF NOT EXISTS idx_appointments_business_id ON appointments(business_id);

---

-- File: 005_create_reminders_table.sql
-- Migration: Create reminders table
-- Version: 5

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL,
    patient_id INTEGER NOT NULL,
    phone_number TEXT NOT NULL,
    reminder_type TEXT NOT NULL CHECK (reminder_type IN ('24h', '2h', 'custom')),
    scheduled_for DATETIME NOT NULL,
    sent_at DATETIME,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
    message_content TEXT,
    error_message TEXT,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id),
    FOREIGN KEY (patient_id) REFERENCES patients(id)
);

CREATE INDEX IF NOT EXISTS idx_reminders_appointment_id ON reminders(appointment_id);
CREATE INDEX IF NOT EXISTS idx_reminders_patient_id ON reminders(patient_id);
CREATE INDEX IF NOT EXISTS idx_reminders_scheduled_for ON reminders(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
CREATE INDEX IF NOT EXISTS idx_reminders_phone_number ON reminders(phone_number);

---

-- File: 006_create_practitioners_table.sql
-- Migration: Create practitioners cache table
-- Version: 6

CREATE TABLE IF NOT EXISTS practitioners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliniko_id INTEGER UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    title TEXT,
    email TEXT,
    phone_number TEXT,
    specialization TEXT,
    active BOOLEAN DEFAULT TRUE,
    show_in_online_bookings BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_practitioners_cliniko_id ON practitioners(cliniko_id);
CREATE INDEX IF NOT EXISTS idx_practitioners_active ON practitioners(active);
CREATE INDEX IF NOT EXISTS idx_practitioners_last_name ON practitioners(last_name);

---

-- File: 007_create_appointment_types_table.sql
-- Migration: Create appointment types cache table
-- Version: 7

CREATE TABLE IF NOT EXISTS appointment_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliniko_id INTEGER UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    duration_minutes INTEGER NOT NULL,
    color TEXT,
    max_attendees INTEGER DEFAULT 1,
    bookable_online BOOLEAN DEFAULT TRUE,
    active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_appointment_types_cliniko_id ON appointment_types(cliniko_id);
CREATE INDEX IF NOT EXISTS idx_appointment_types_active ON appointment_types(active);
CREATE INDEX IF NOT EXISTS idx_appointment_types_bookable_online ON appointment_types(bookable_online);

---

-- File: 008_create_businesses_table.sql
-- Migration: Create businesses cache table
-- Version: 8

CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliniko_id INTEGER UNIQUE NOT NULL,
    name TEXT NOT NULL,
    address_line_1 TEXT,
    address_line_2 TEXT,
    city TEXT,
    state TEXT,
    post_code TEXT,
    country TEXT,
    phone_number TEXT,
    email TEXT,
    website_url TEXT,
    appointment_booking_url TEXT,
    active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_businesses_cliniko_id ON businesses(cliniko_id);
CREATE INDEX IF NOT EXISTS idx_businesses_active ON businesses(active);

---

-- File: 009_create_audit_log_table.sql
-- Migration: Create audit log table
-- Version: 9

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_values TEXT, -- JSON string
    new_values TEXT, -- JSON string
    user_id TEXT,
    session_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_table_name ON audit_log(table_name);
CREATE INDEX IF NOT EXISTS idx_audit_log_record_id ON audit_log(record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);

---

-- File: 010_create_chatbot_settings_table.sql
-- Migration: Create chatbot settings table
-- Version: 10

CREATE TABLE IF NOT EXISTS chatbot_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT UNIQUE NOT NULL,
    setting_value TEXT,
    setting_type TEXT DEFAULT 'string' CHECK (setting_type IN ('string', 'number', 'boolean', 'json')),
    description TEXT,
    is_system BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default settings
INSERT OR IGNORE INTO chatbot_settings (setting_key, setting_value, setting_type, description, is_system) VALUES
('session_timeout_minutes', '30', 'number', 'Session timeout in minutes', TRUE),
('max_verification_attempts', '3', 'number', 'Maximum verification attempts allowed', TRUE),
('welcome_message', 'Hello! Welcome to our clinic. How can I help you today?', 'string', 'Default welcome message', FALSE),
('business_hours', '{"monday": "9:00-17:00", "tuesday": "9:00-17:00", "wednesday": "9:00-17:00", "thursday": "9:00-17:00", "friday": "9:00-17:00", "saturday": "closed", "sunday": "closed"}', 'json', 'Business hours configuration', FALSE),
('reminder_24h_enabled', 'true', 'boolean', 'Enable 24-hour appointment reminders', FALSE),
('reminder_2h_enabled', 'true', 'boolean', 'Enable 2-hour appointment reminders', FALSE);

CREATE INDEX IF NOT EXISTS idx_chatbot_settings_key ON chatbot_settings(setting_key);
CREATE INDEX IF NOT EXISTS idx_chatbot_settings_system ON chatbot_settings(is_system);
