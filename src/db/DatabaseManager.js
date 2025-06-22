const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;

class DatabaseManager {
    constructor(dbPath = './data/chatbot.db') {
        this.dbPath = dbPath;
        this.db = null;
        this.isInitialized = false;
    }

    async initialize() {
        try {
            // Ensure data directory exists
            const dir = path.dirname(this.dbPath);
            await fs.mkdir(dir, { recursive: true });

            // Initialize database connection
            this.db = new sqlite3.Database(this.dbPath);
            
            // Enable foreign keys
            await this.run('PRAGMA foreign_keys = ON');
            
            // Create tables if they don't exist
            await this.createTables();
            
            this.isInitialized = true;
            console.log('Database initialized successfully');
        } catch (error) {
            console.error('Database initialization failed:', error);
            throw error;
        }
    }

    async createTables() {
        const tables = [
            // Sessions table for managing user sessions
            `CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone_number TEXT UNIQUE NOT NULL,
                session_id TEXT UNIQUE NOT NULL,
                is_verified BOOLEAN DEFAULT FALSE,
                verification_attempts INTEGER DEFAULT 0,
                patient_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME,
                context TEXT -- JSON string for conversation context
            )`,

            // Conversations table for message logging
            `CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                phone_number TEXT NOT NULL,
                message_type TEXT NOT NULL, -- 'incoming', 'outgoing'
                message_content TEXT NOT NULL,
                message_id TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                processed BOOLEAN DEFAULT FALSE,
                error_message TEXT,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            )`,

            // Local patient cache
            `CREATE TABLE IF NOT EXISTS patients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cliniko_id TEXT UNIQUE NOT NULL,
                phone_number TEXT,
                email TEXT,
                first_name TEXT,
                last_name TEXT,
                date_of_birth DATE,
                last_synced DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Appointment reminders tracking
            `CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                appointment_id TEXT NOT NULL,
                patient_id TEXT NOT NULL,
                phone_number TEXT NOT NULL,
                reminder_type TEXT NOT NULL, -- '24h', '2h', 'confirmation'
                scheduled_time DATETIME NOT NULL,
                sent BOOLEAN DEFAULT FALSE,
                sent_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Clinic information cache
            `CREATE TABLE IF NOT EXISTS clinic_info (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                info_type TEXT NOT NULL, -- 'location', 'rates', 'services'
                key_name TEXT NOT NULL,
                content TEXT NOT NULL,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(info_type, key_name)
            )`
        ];

        for (const table of tables) {
            await this.run(table);
        }

        // Create indexes for performance
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone_number)',
            'CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id)',
            'CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone_number)',
            'CREATE INDEX IF NOT EXISTS idx_reminders_scheduled ON reminders(scheduled_time, sent)'
        ];

        for (const index of indexes) {
            await this.run(index);
        }
    }

    // Promisify database operations
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    // Session management methods
    async createSession(phoneNumber, sessionId, expiresInMinutes = 60) {
        const expiresAt = new Date(Date.now() + (expiresInMinutes * 60 * 1000));
        
        const sql = `
            INSERT OR REPLACE INTO sessions 
            (phone_number, session_id, expires_at, updated_at) 
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `;
        
        return await this.run(sql, [phoneNumber, sessionId, expiresAt.toISOString()]);
    }

    async getSession(phoneNumber) {
        const sql = `
            SELECT * FROM sessions 
            WHERE phone_number = ? 
            AND (expires_at IS NULL OR expires_at > datetime('now'))
        `;
        
        const session = await this.get(sql, [phoneNumber]);
        
        if (session && session.context) {
            try {
                session.context = JSON.parse(session.context);
            } catch (e) {
                session.context = {};
            }
        }
        
        return session;
    }

    async updateSession(phoneNumber, updates) {
        const allowedFields = ['is_verified', 'verification_attempts', 'patient_id', 'context', 'expires_at'];
        const setClause = [];
        const params = [];

        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                setClause.push(`${key} = ?`);
                params.push(key === 'context' ? JSON.stringify(value) : value);
            }
        }

        if (setClause.length === 0) return { changes: 0 };

        setClause.push('updated_at = CURRENT_TIMESTAMP');
        params.push(phoneNumber);

        const sql = `UPDATE sessions SET ${setClause.join(', ')} WHERE phone_number = ?`;
        return await this.run(sql, params);
    }

    async deleteSession(phoneNumber) {
        const sql = 'DELETE FROM sessions WHERE phone_number = ?';
        return await this.run(sql, [phoneNumber]);
    }

    // Conversation logging
    async logMessage(sessionId, phoneNumber, messageType, content, messageId = null) {
        const sql = `
            INSERT INTO conversations 
            (session_id, phone_number, message_type, message_content, message_id) 
            VALUES (?, ?, ?, ?, ?)
        `;
        
        return await this.run(sql, [sessionId, phoneNumber, messageType, content, messageId]);
    }

    async getConversationHistory(phoneNumber, limit = 50) {
        const sql = `
            SELECT * FROM conversations 
            WHERE phone_number = ? 
            ORDER BY timestamp DESC 
            LIMIT ?
        `;
        
        return await this.all(sql, [phoneNumber, limit]);
    }

    // Patient management
    async cachePatient(patientData) {
        const sql = `
            INSERT OR REPLACE INTO patients 
            (cliniko_id, phone_number, email, first_name, last_name, date_of_birth, last_synced) 
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;
        
        const { cliniko_id, phone_number, email, first_name, last_name, date_of_birth } = patientData;
        return await this.run(sql, [cliniko_id, phone_number, email, first_name, last_name, date_of_birth]);
    }

    async getPatientByPhone(phoneNumber) {
        const sql = 'SELECT * FROM patients WHERE phone_number = ?';
        return await this.get(sql, [phoneNumber]);
    }

    async getPatientById(clinikoId) {
        const sql = 'SELECT * FROM patients WHERE cliniko_id = ?';
        return await this.get(sql, [clinikoId]);
    }

    // Reminder management
    async scheduleReminder(appointmentId, patientId, phoneNumber, reminderType, scheduledTime) {
        const sql = `
            INSERT INTO reminders 
            (appointment_id, patient_id, phone_number, reminder_type, scheduled_time) 
            VALUES (?, ?, ?, ?, ?)
        `;
        
        return await this.run(sql, [appointmentId, patientId, phoneNumber, reminderType, scheduledTime]);
    }

    async getPendingReminders() {
        const sql = `
            SELECT * FROM reminders 
            WHERE sent = FALSE 
            AND scheduled_time <= datetime('now') 
            ORDER BY scheduled_time ASC
        `;
        
        return await this.all(sql);
    }

    async markReminderSent(reminderId) {
        const sql = `
            UPDATE reminders 
            SET sent = TRUE, sent_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `;
        
        return await this.run(sql, [reminderId]);
    }

    // Clinic information cache
    async setCacheInfo(infoType, keyName, content) {
        const sql = `
            INSERT OR REPLACE INTO clinic_info 
            (info_type, key_name, content, last_updated) 
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `;
        
        return await this.run(sql, [infoType, keyName, content]);
    }

    async getCacheInfo(infoType, keyName = null) {
        let sql, params;
        
        if (keyName) {
            sql = 'SELECT * FROM clinic_info WHERE info_type = ? AND key_name = ?';
            params = [infoType, keyName];
        } else {
            sql = 'SELECT * FROM clinic_info WHERE info_type = ?';
            params = [infoType];
        }
        
        return keyName ? await this.get(sql, params) : await this.all(sql, params);
    }

    // Cleanup methods
    async cleanupExpiredSessions() {
        const sql = "DELETE FROM sessions WHERE expires_at < datetime('now')";
        return await this.run(sql);
    }

    async cleanupOldConversations(daysOld = 30) {
        const sql = `
            DELETE FROM conversations 
            WHERE timestamp < datetime('now', '-${daysOld} days')
        `;
        return await this.run(sql);
    }

    async cleanupOldReminders(daysOld = 7) {
        const sql = `
            DELETE FROM reminders 
            WHERE sent = TRUE 
            AND sent_at < datetime('now', '-${daysOld} days')
        `;
        return await this.run(sql);
    }

    // Health check and stats
    async getStats() {
        const stats = {};
        
        const queries = [
            { key: 'total_sessions', sql: 'SELECT COUNT(*) as count FROM sessions' },
            { key: 'active_sessions', sql: "SELECT COUNT(*) as count FROM sessions WHERE expires_at > datetime('now')" },
            { key: 'verified_sessions', sql: 'SELECT COUNT(*) as count FROM sessions WHERE is_verified = TRUE' },
            { key: 'total_conversations', sql: 'SELECT COUNT(*) as count FROM conversations' },
            { key: 'cached_patients', sql: 'SELECT COUNT(*) as count FROM patients' },
            { key: 'pending_reminders', sql: 'SELECT COUNT(*) as count FROM reminders WHERE sent = FALSE' }
        ];

        for (const query of queries) {
            const result = await this.get(query.sql);
            stats[query.key] = result.count;
        }

        return stats;
    }

    async close() {
        return new Promise((resolve) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err) console.error('Error closing database:', err);
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    // Transaction support
    async transaction(callback) {
        await this.run('BEGIN TRANSACTION');
        try {
            const result = await callback(this);
            await this.run('COMMIT');
            return result;
        } catch (error) {
            await this.run('ROLLBACK');
            throw error;
        }
    }
}

module.exports = DatabaseManager;
