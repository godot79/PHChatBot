const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const Logger = require('./Logger');

class DatabaseManager {
  constructor() {
    this.logger = new Logger('DatabaseManager');
    this.db = new sqlite3.Database(path.resolve(__dirname, '../../database.sqlite'), (err) => {
      if (err) {
        this.logger.error('❌ Failed to connect to database:', err);
      } else {
        this.logger.info('Connected to SQLite database');
      }
    });
    this.isInitialized = false;
  }

  async testConnection() {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT 1', (err) => {
        if (err) {
          reject(new Error('Database connection failed: ' + err.message));
        } else {
          resolve(true);
        }
      });
    });
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          phone_number TEXT NOT NULL,
          patient_id TEXT,
          verification_status TEXT DEFAULT 'pending',
          conversation_state TEXT DEFAULT 'INTRO',
          context TEXT DEFAULT '{}',
          data TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME,
          verified BOOLEAN DEFAULT 0
        )`);

        this.db.run(`CREATE TABLE IF NOT EXISTS chat_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          message TEXT,
          response TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(session_id) REFERENCES sessions(id)
        )`);

        this.db.run(`CREATE TABLE IF NOT EXISTS verification_codes (
          id TEXT PRIMARY KEY,
          phone_number TEXT,
          code TEXT,
          patient_id TEXT,
          attempts INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME
        )`);

        // Create indexes for better performance
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone_number)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_chat_history_session ON chat_history(session_id)`);

        this.db.run(`CREATE INDEX IF NOT EXISTS idx_verification_codes_phone ON verification_codes(phone_number)`);

        this.db.run(`CREATE TABLE IF NOT EXISTS patient_state (
          phone_number TEXT PRIMARY KEY,
          region TEXT,
          appt_preference TEXT,
          physio_preference TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
          if (err) {
            this.logger.error('❌ Failed to initialize schema:', err);
            reject(err);
          } else {
            this.isInitialized = true;
            this.logger.info('Database manager initialized successfully');
            resolve();
          }
        });
      });
    });
  }

  // Create a new session
  async createSession(phoneNumber, patientId = null, durationMinutes = 30) {
    return new Promise((resolve, reject) => {
      const sessionId = this.generateSessionId();
      const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
      
      const stmt = this.db.prepare(`
        INSERT INTO sessions (id, phone_number, patient_id, expires_at)
        VALUES (?, ?, ?, ?)
      `);

      stmt.run([sessionId, phoneNumber, patientId, expiresAt], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(sessionId);
        }
      });
      stmt.finalize();
    });
  }

  // Get session by ID
  async getSession(sessionId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM sessions WHERE id = ?`,
        [sessionId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row || null);
          }
        }
      );
    });
  }

  // Get session by phone number
  async getSessionByPhone(phoneNumber) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM sessions WHERE phone_number = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`,
        [phoneNumber],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row || null);
          }
        }
      );
    });
  }

  // Update session
  async updateSession(sessionId, updates) {
    this.logger.info(`📥 updateSession called for ${sessionId} with`, updates);
    return new Promise((resolve, reject) => {
      const allowedFields = [
        'patient_id', 'verification_status', 'conversation_state', 
        'context', 'last_activity', 'expires_at', 'verified', 'data'
      ];

      const fields = [];
      const values = [];

      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }

      if (fields.length === 0) {
        reject(new Error('No valid fields to update'));
        return;
      }

      // Always update last_activity
      if (!updates.last_activity) {
        fields.push('last_activity = ?');
        values.push(new Date().toISOString());
      }

      values.push(sessionId);

      const sql = `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`;
      
      this.db.run(sql, values, function(err) {
        if (err) {
          console.error('❌ updateSession failed:', err, sql, values); // temp log to terminal
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  // Delete session
  async deleteSession(sessionId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `DELETE FROM sessions WHERE id = ?`,
        [sessionId],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes);
          }
        }
      );
    });
  }

  // Clean up expired sessions
  async cleanupExpiredSessions() {
    return new Promise((resolve, reject) => {
      this.db.run(
        `DELETE FROM sessions WHERE expires_at <= datetime('now')`,
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes);
          }
        }
      );
    });
  }

  // Add chat history
  async addChatHistory(sessionId, message, response) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO chat_history (session_id, message, response)
        VALUES (?, ?, ?)
      `);

      stmt.run([sessionId, message, response], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
      stmt.finalize();
    });
  }

  // Get chat history for a session
  async getChatHistory(sessionId, limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM chat_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`,
        [sessionId, limit],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  }

  // Get database stats
  async getStats() {
    return new Promise((resolve, reject) => {
      const stats = {};
      
      this.db.get('SELECT COUNT(*) as total FROM sessions', (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        stats.total_sessions = row.total;
        
        this.db.get('SELECT COUNT(*) as active FROM sessions WHERE expires_at > datetime("now")', (err, row) => {
          if (err) {
            reject(err);
            return;
          }
          stats.active_sessions = row.active;
          
          this.db.get('SELECT COUNT(*) as verified FROM sessions WHERE verified = 1', (err, row) => {
            if (err) {
              reject(err);
              return;
            }
            stats.verified_sessions = row.verified;
            resolve(stats);
          });
        });
      });
    });
  }

  // Generate unique session ID
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Execute raw SQL (for advanced operations)
  async query(sql, params = []) {
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

  async getPatientState(phone) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM patient_state WHERE phone_number = ?`,
        [phone],
        (err, row) => err ? reject(err) : resolve(row || null)
      );
    });
  }

  async upsertPatientState(phone, updates) {
    const { region, appt_preference, physio_preference } = updates;
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO patient_state (phone_number, region, appt_preference, physio_preference, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(phone_number) DO UPDATE SET
           region = COALESCE(?, region),
           appt_preference = COALESCE(?, appt_preference),
           physio_preference = COALESCE(?, physio_preference),
           updated_at = CURRENT_TIMESTAMP`,
        [phone, region ?? null, appt_preference ?? null, physio_preference ?? null,
         region ?? null, appt_preference ?? null, physio_preference ?? null],
        (err) => err ? reject(err) : resolve()
      );
    });
  }

  // Get database connection
  getDB() {
    return this.db;
  }

  // Close database connection
  async close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}

module.exports = DatabaseManager;
