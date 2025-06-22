const DatabaseManager = require('./DatabaseManager');
const fs = require('fs').promises;
const path = require('path');

class DatabaseSetup {
    constructor(dbPath = './data/chatbot.db') {
        this.dbPath = dbPath;
        this.migrationDir = './migrations';
    }

    async setup() {
        try {
            console.log('Setting up database...');
            
            // Initialize database
            const db = new DatabaseManager(this.dbPath);
            await db.initialize();
            
            // Run migrations
            await this.runMigrations(db);
            
            // Seed initial data if needed
            await this.seedInitialData(db);
            
            console.log('Database setup completed successfully');
            await db.close();
            
        } catch (error) {
            console.error('Database setup failed:', error);
            throw error;
        }
    }

    async runMigrations(db) {
        console.log('Running database migrations...');
        
        // Create migrations table if it doesn't exist
        await db.run(`
            CREATE TABLE IF NOT EXISTS migrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Get list of migration files
        const migrationFiles = await this.getMigrationFiles();
        
        // Get executed migrations
        const executedMigrations = await db.all('SELECT version FROM migrations ORDER BY version');
        const executedVersions = new Set(executedMigrations.map(m => m.version));

        // Execute pending migrations
        for (const migrationFile of migrationFiles) {
            const version = this.extractVersionFromFilename(migrationFile);
            
            if (!executedVersions.has(version)) {
                console.log(`Executing migration: ${migrationFile}`);
                await this.executeMigration(db, migrationFile, version);
            }
        }
    }

    async getMigrationFiles() {
        try {
            const files = await fs.readdir(this.migrationDir);
            return files
                .filter(file => file.endsWith('.js'))
                .sort(); // Execute in alphabetical order
        } catch (error) {
            console.log('No migrations directory found, skipping migrations');
            return [];
        }
    }

    extractVersionFromFilename(filename) {
        // Extract version from filename like "001_create_sessions.js"
        const match = filename.match(/^(\d+)_/);
        return match ? match[1] : filename;
    }

    async executeMigration(db, migrationFile, version) {
        try {
            const migrationPath = path.join(this.migrationDir, migrationFile);
            const migration = require(path.resolve(migrationPath));
            
            // Execute migration in a transaction
            await db.transaction(async (db) => {
                if (typeof migration.up === 'function') {
                    await migration.up(db);
                } else {
                    throw new Error(`Migration ${migrationFile} does not export an 'up' function`);
                }
                
                // Record migration as executed
                await db.run(
                    'INSERT INTO migrations (version, name) VALUES (?, ?)',
                    [version, migrationFile]
                );
            });
            
            console.log(`Migration ${migrationFile} executed successfully`);
        } catch (error) {
            console.error(`Failed to execute migration ${migrationFile}:`, error);
            throw error;
        }
    }

    async seedInitialData(db) {
        console.log('Seeding initial data...');
        
        // Check if data already exists
        const sessionCount = await db.get('SELECT COUNT(*) as count FROM sessions');
        if (sessionCount.count > 0) {
            console.log('Data already exists, skipping seed');
            return;
        }

        // Seed clinic information
        const clinicData = [
            {
                info_type: 'location',
                key_name: 'main_clinic',
                content: JSON.stringify({
                    name: 'Main Clinic',
                    address: '123 Health Street, Medical District, City',
                    phone: '+61-XXX-XXX-XXX',
                    hours: {
                        monday: '9:00 AM - 5:00 PM',
                        tuesday: '9:00 AM - 5:00 PM',
                        wednesday: '9:00 AM - 5:00 PM',
                        thursday: '9:00 AM - 5:00 PM',
                        friday: '9:00 AM - 4:00 PM',
                        saturday: '9:00 AM - 2:00 PM',
                        sunday: 'Closed'
                    }
                })
            },
            {
                info_type: 'rates',
                key_name: 'consultation',
                content: JSON.stringify({
                    initial_consultation: '$150',
                    follow_up: '$100',
                    specialist_consultation: '$200',
                    telehealth: '$80'
                })
            },
            {
                info_type: 'services',
                key_name: 'available_services',
                content: JSON.stringify([
                    'General Consultation',
                    'Specialist Consultation',
                    'Telehealth Consultation',
                    'Health Checks',
                    'Vaccinations',
                    'Minor Procedures',
                    'Chronic Disease Management'
                ])
            }
        ];

        for (const data of clinicData) {
            await db.setCacheInfo(data.info_type, data.key_name, data.content);
        }

        console.log('Initial data seeded successfully');
    }

    async resetDatabase() {
        console.log('Resetting database...');
        
        try {
            // Delete the database file
            await fs.unlink(this.dbPath);
            console.log('Database file deleted');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('Error deleting database file:', error);
            }
        }
        
        // Recreate the database
        await this.setup();
    }

    async backupDatabase(backupPath) {
        try {
            const data = await fs.readFile(this.dbPath);
            await fs.writeFile(backupPath, data);
            console.log(`Database backed up to: ${backupPath}`);
        } catch (error) {
            console.error('Database backup failed:', error);
            throw error;
        }
    }

    async restoreDatabase(backupPath) {
        try {
            const data = await fs.readFile(backupPath);
            await fs.writeFile(this.dbPath, data);
            console.log(`Database restored from: ${backupPath}`);
        } catch (error) {
            console.error('Database restore failed:', error);
            throw error;
        }
    }

    async validateDatabase() {
        console.log('Validating database structure...');
        
        const db = new DatabaseManager(this.dbPath);
        await db.initialize();
        
        try {
            // Check if all required tables exist
            const requiredTables = ['sessions', 'conversations', 'patients', 'reminders', 'clinic_info'];
            
            for (const table of requiredTables) {
                const result = await db.get(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                    [table]
                );
                
                if (!result) {
                    throw new Error(`Required table '${table}' not found`);
                }
                console.log(`✓ Table '${table}' exists`);
            }

            // Check if indexes exist
            const requiredIndexes = [
                'idx_sessions_phone',
                'idx_conversations_session',
                'idx_patients_phone',
                'idx_reminders_scheduled'
            ];

            for (const index of requiredIndexes) {
                const result = await db.get(
                    "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
                    [index]
                );
                
                if (!result) {
                    console.warn(`⚠ Index '${index}' not found`);
                } else {
                    console.log(`✓ Index '${index}' exists`);
                }
            }

            // Test basic operations
            await this.testBasicOperations(db);
            
            console.log('Database validation completed successfully');
            
        } finally {
            await db.close();
        }
    }

    async testBasicOperations(db) {
        console.log('Testing basic database operations...');
        
        // Test session creation
        const testPhone = '+61999999999';
        const testSessionId = 'test-session-' + Date.now();
        
        await db.createSession(testPhone, testSessionId, 60);
        const session = await db.getSession(testPhone);
        
        if (!session || session.session_id !== testSessionId) {
            throw new Error('Session creation/retrieval failed');
        }
        console.log('✓ Session operations working');
        
        // Test conversation logging
        await db.logMessage(testSessionId, testPhone, 'incoming', 'Test message', 'test-msg-id');
        const conversations = await db.getConversationHistory(testPhone, 1);
        
        if (!conversations || conversations.length === 0) {
            throw new Error('Conversation logging failed');
        }
        console.log('✓ Conversation logging working');
        
        // Test patient caching
        await db.cachePatient({
            cliniko_id: 'test-patient-123',
            phone_number: testPhone,
            email: 'test@example.com',
            first_name: 'Test',
            last_name: 'Patient',
            date_of_birth: '1990-01-01'
        });
        
        const patient = await db.getPatientByPhone(testPhone);
        if (!patient || patient.cliniko_id !== 'test-patient-123') {
            throw new Error('Patient caching failed');
        }
        console.log('✓ Patient caching working');
        
        // Clean up test data
        await db.deleteSession(testPhone);
        await db.run('DELETE FROM conversations WHERE phone_number = ?', [testPhone]);
        await db.run('DELETE FROM patients WHERE phone_number = ?', [testPhone]);
        
        console.log('✓ Test cleanup completed');
    }

    async getStats() {
        const db = new DatabaseManager(this.dbPath);
        await db.initialize();
        
        try {
            const stats = await db.getStats();
            
            // Add database file size
            try {
                const stat = await fs.stat(this.dbPath);
                stats.database_size_bytes = stat.size;
                stats.database_size_mb = (stat.size / (1024 * 1024)).toFixed(2);
            } catch (error) {
                stats.database_size_bytes = 0;
                stats.database_size_mb = '0.00';
            }
            
            return stats;
        } finally {
            await db.close();
        }
    }
}

// CLI interface
if (require.main === module) {
    const setup = new DatabaseSetup();
    const command = process.argv[2];
    
    async function runCommand() {
        try {
            switch (command) {
                case 'setup':
                    await setup.setup();
                    break;
                    
                case 'reset':
                    await setup.resetDatabase();
                    break;
                    
                case 'validate':
                    await setup.validateDatabase();
                    break;
                    
                case 'backup':
                    const backupPath = process.argv[3] || `./backup-${Date.now()}.db`;
                    await setup.backupDatabase(backupPath);
                    break;
                    
                case 'restore':
                    const restorePath = process.argv[3];
                    if (!restorePath) {
                        throw new Error('Restore path is required');
                    }
                    await setup.restoreDatabase(restorePath);
                    break;
                    
                case 'stats':
                    const stats = await setup.getStats();
                    console.log('Database Statistics:');
                    console.log(JSON.stringify(stats, null, 2));
                    break;
                    
                default:
                    console.log(`
Usage: node sqlite-setup.js <command> [options]

Commands:
  setup              Initialize database and run migrations
  reset              Reset database (delete and recreate)
  validate           Validate database structure and test operations
  backup <path>      Backup database to specified path
  restore <path>     Restore database from backup
  stats              Show database statistics

Examples:
  node sqlite-setup.js setup
  node sqlite-setup.js backup ./backup.db
  node sqlite-setup.js restore ./backup.db
                    `);
            }
        } catch (error) {
            console.error('Command failed:', error.message);
            process.exit(1);
        }
    }
    
    runCommand();
}

module.exports = DatabaseSetup;
