// src/core/DatabaseManager.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;
const Logger = require('./Logger');

class DatabaseManager {
    constructor() {
        this.db = null;
        this.dbPath = path.join(__dirname, '../../data/chatbot.db');
        this.logger = new Logger();
        this.isInitialized = false;
        this.connectionPool = [];
        this.maxConnections = 10;
    }

    /**
     * Initialize database connection and ensure tables exist
     */
    async initialize() {
        try {
            // Ensure data directory exists
            const dataDir = path.dirname(this.dbPath);
            await fs.mkdir(dataDir, { recursive: true });

            // Create database connection
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    this.logger.error('Failed to connect to database:', err);
                    throw err;
                }
                this.logger.info('Connected to SQLite database');
            });

            // Configure database settings
            await this.configurePragmas();
            
            // Ensure all tables exist
            await this.ensureTablesExist();
            
            this.isInitialized = true;
            this.logger.info('Database manager initialized successfully');
        } catch (error) {
            this.logger.error('Database initialization failed:', error);
            throw error;
        }
    }

    /**
     * Configure SQLite pragmas for performance and reliability
     */
    async configurePragmas() {
        const pragmas = [
            'PRAGMA foreign_keys = ON',
            'PRAGMA journal_mode = WAL',
            'PRAGMA synchronous = NORMAL',
            'PRAGMA cache_size = -64000',
            'PRAGMA temp_store = MEMORY',
            'PRAGMA mmap_size = 268435456'
        ];

        for (const pragma of pragmas) {
            await this.run(pragma);
        }
    }

    /**
     * Ensure all required tables exist
     */
    async ensureTablesExist() {
        const tables = [
            {
                name: 'sessions',
                sql: `
                    CREATE TABLE IF NOT EXISTS sessions (
                        id TEXT PRIMARY KEY,
                        phone_number TEXT NOT NULL,
                        patient_id INTEGER,
                        verification_status TEXT DEFAULT 'pending',
                        conversation_state TEXT DEFAULT 'initial',
                        context TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        expires_at DATETIME,
                        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'conversations',
                sql: `
                    CREATE TABLE IF NOT EXISTS conversations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        session_id TEXT NOT NULL,
                        message_id TEXT,
                        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
                        message_type TEXT DEFAULT 'text',
                        content TEXT NOT NULL,
                        metadata TEXT,
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                    )
                `
            },
            {
                name: 'patients',
                sql: `
                    CREATE TABLE IF NOT EXISTS patients (
                        id INTEGER PRIMARY KEY,
                        cliniko_id INTEGER UNIQUE NOT NULL,
                        phone_number TEXT,
                        first_name TEXT,
                        last_name TEXT,
                        email TEXT,
                        date_of_birth DATE,
                        cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        last_sync DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'reminders',
                sql: `
                    CREATE TABLE IF NOT EXISTS reminders (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        appointment_id INTEGER NOT NULL,
                        patient_id INTEGER NOT NULL,
                        phone_number TEXT NOT NULL,
                        reminder_type TEXT NOT NULL,
                        scheduled_time DATETIME NOT NULL,
                        sent_at DATETIME,
                        status TEXT DEFAULT 'pending',
                        message_content TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (patient_id) REFERENCES patients(id)
                    )
                `
            }
        ];

        for (const table of tables) {
            await this.run(table.sql);
            this.logger.debug(`Ensured table exists: ${table.name}`);
        }

        // Create indexes for performance
        await this.createIndexes();
    }

    /**
     * Create database indexes for performance
     */
    async createIndexes() {
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone_number)',
            'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)',
            'CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id)',
            'CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_patients_cliniko ON patients(cliniko_id)',
            'CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone_number)',
            'CREATE INDEX IF NOT EXISTS idx_reminders_scheduled ON reminders(scheduled_time)',
            'CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status)'
        ];

        for (const index of indexes) {
            await this.run(index);
        }
    }

    /**
     * Execute SQL query with parameters (wrapper for db.run)
     */
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });
        });
    }

    /**
     * Get single row (wrapper for db.get)
     */
    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    /**
     * Get multiple rows (wrapper for db.all)
     */
    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    /**
     * Execute multiple queries in a transaction
     */
    async transaction(queries) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run("BEGIN TRANSACTION");
                
                const results = [];
                let hasError = false;

                const executeQueries = async () => {
                    try {
                        for (const query of queries) {
                            const result = await this.run(query.sql, query.params || []);
                            results.push(result);
                        }
                        
                        this.db.run("COMMIT", (err) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(results);
                            }
                        });
                    } catch (error) {
                        hasError = true;
                        this.db.run("ROLLBACK", () => {
                            reject(error);
                        });
                    }
                };

                executeQueries();
            });
        });
    }

    /**
     * Session Management Methods
     */

    async createSession(phoneNumber, patientId = null, expiresInMinutes = 30) {
        const sessionId = this.generateSessionId();
        const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

        const sql = `
            INSERT INTO sessions (id, phone_number, patient_id, expires_at)
            VALUES (?, ?, ?, ?)
        `;

        await this.run(sql, [sessionId, phoneNumber, patientId, expiresAt.toISOString()]);
        this.logger.info(`Created session ${sessionId} for ${phoneNumber}`);
        
        return sessionId;
    }

    async getSession(sessionId) {
        const sql = `
            SELECT * FROM sessions 
            WHERE id = ? AND expires_at > datetime('now')
        `;
        return await this.get(sql, [sessionId]);
    }

    async getSessionByPhone(phoneNumber) {
        const sql = `
            SELECT * FROM sessions 
            WHERE phone_number = ? AND expires_at > datetime('now')
            ORDER BY created_at DESC 
            LIMIT 1
        `;
        return await this.get(sql, [phoneNumber]);
    }

    async updateSession(sessionId, updates) {
        const updateFields = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            updateFields.push(`${key} = ?`);
            values.push(value);
        }

        updateFields.push('updated_at = datetime("now")');
        updateFields.push('last_activity = datetime("now")');
        
        values.push(sessionId);

        const sql = `
            UPDATE sessions 
            SET ${updateFields.join(', ')}
            WHERE id = ?
        `;

        return await this.run(sql, values);
    }

    async deleteSession(sessionId) {
        const sql = 'DELETE FROM sessions WHERE id = ?';
        return await this.run(sql, [sessionId]);
    }

    async cleanupExpiredSessions() {
        const sql = 'DELETE FROM sessions WHERE expires_at <= datetime("now")';
        const result = await this.run(sql);
        
        if (result.changes > 0) {
            this.logger.info(`Cleaned up ${result.changes} expired sessions`);
        }
        
        return result.changes;
    }

    /**
     * Conversation Management
     */

    async logMessage(sessionId, direction, content, messageType = 'text', metadata = null) {
        const sql = `
            INSERT INTO conversations (session_id, direction, message_type, content, metadata)
            VALUES (?, ?, ?, ?, ?)
        `;

        const metadataJson = metadata ? JSON.stringify(metadata) : null;
        return await this.run(sql, [sessionId, direction, messageType, content, metadataJson]);
    }

    async getConversationHistory(sessionId, limit = 50) {
        const sql = `
            SELECT * FROM conversations
            WHERE session_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `;
        return await this.all(sql, [sessionId, limit]);
    }

    /**
     * Patient Cache Management
     */

    async cachePatient(patientData) {
        const sql = `
            INSERT OR REPLACE INTO patients 
            (cliniko_id, phone_number, first_name, last_name, email, date_of_birth, last_sync)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `;

        return await this.run(sql, [
            patientData.cliniko_id,
            patientData.phone_number,
            patientData.first_name,
            patientData.last_name,
            patientData.email,
            patientData.date_of_birth
        ]);
    }

    async getCachedPatient(clinikoId) {
        const sql = 'SELECT * FROM patients WHERE cliniko_id = ?';
        return await this.get(sql, [clinikoId]);
    }

    async getCachedPatientByPhone(phoneNumber) {
        const sql = 'SELECT * FROM patients WHERE phone_number = ?';
        return await this.get(sql, [phoneNumber]);
    }

    /**
     * Reminder Management
     */

    async scheduleReminder(appointmentId, patientId, phoneNumber, reminderType, scheduledTime, messageContent) {
        const sql = `
            INSERT INTO reminders 
            (appointment_id, patient_id, phone_number, reminder_type, scheduled_time, message_content)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        return await this.run(sql, [
            appointmentId, patientId, phoneNumber, reminderType, 
            scheduledTime, messageContent
        ]);
    }

    async getPendingReminders() {
        const sql = `
            SELECT * FROM reminders
            WHERE status = 'pending' AND scheduled_time <= datetime('now')
            ORDER BY scheduled_time ASC
        `;
        return await this.all(sql);
    }

    async markReminderSent(reminderId) {
        const sql = `
            UPDATE reminders 
            SET status = 'sent', sent_at = datetime('now')
            WHERE id = ?
        `;
        return await this.run(sql, [reminderId]);
    }

    /**
     * Utility Methods
     */

    generateSessionId() {
        return 'sess_' + Math.random().toString(36).substr(2, 16) + Date.now().toString(36);
    }

    async getStats() {
        const stats = {};
        
        // Session stats
        const sessionStats = await this.get(`
            SELECT 
                COUNT(*) as total_sessions,
                COUNT(CASE WHEN expires_at > datetime('now') THEN 1 END) as active_sessions,
                COUNT(CASE WHEN verification_status = 'verified' THEN 1 END) as verified_sessions
            FROM sessions
        `);
        
        // Conversation stats
        const conversationStats = await this.get(`
            SELECT 
                COUNT(*) as total_messages,
                COUNT(CASE WHEN direction = 'inbound' THEN 1 END) as inbound_messages,
                COUNT(CASE WHEN direction = 'outbound' THEN 1 END) as outbound_messages
            FROM conversations
            WHERE timestamp >= datetime('now', '-24 hours')
        `);

        return {
            sessions: sessionStats,
            conversations: conversationStats,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Close database connection
     */
    async close() {
        return new Promise((resolve) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err) {
                        this.logger.error('Error closing database:', err);
                    } else {
                        this.logger.info('Database connection closed');
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Health check
     */
    async healthCheck() {
        try {
            await this.get('SELECT 1 as health');
            return { status: 'healthy', timestamp: new Date().toISOString() };
        } catch (error) {
            this.logger.error('Database health check failed:', error);
            return { status: 'unhealthy', error: error.message, timestamp: new Date().toISOString() };
        }
    }
}

module.exports = DatabaseManager;
