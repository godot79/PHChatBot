#!/usr/bin/env node

/**
 * Database Setup Script
 * Initializes the database, runs migrations, and seeds initial data
 */

const fs = require('fs').promises;
const path = require('path');
const { getDatabaseConfig, databaseExists, DATABASE_CONSTANTS } = require('../src/config/database');
const DatabaseManager = require('../src/core/DatabaseManager');
const MigrationManager = require('../src/database/migrations');
const Logger = require('../src/core/Logger');

class DatabaseSetup {
    constructor() {
        this.logger = new Logger('DatabaseSetup');
        this.config = getDatabaseConfig();
    }

    /**
     * Create data directory if it doesn't exist
     */
    async createDataDirectory() {
        try {
            const dataDir = path.dirname(this.config.filename);
            
            if (this.config.filename !== ':memory:') {
                await fs.mkdir(dataDir, { recursive: true });
                this.logger.info(`Data directory created: ${dataDir}`);
            }
        } catch (error) {
            this.logger.error('Failed to create data directory:', error);
            throw error;
        }
    }

    /**
     * Create backup directory if enabled
     */
    async createBackupDirectory() {
        try {
            if (this.config.backup && this.config.backup.enabled) {
                await fs.mkdir(this.config.backup.directory, { recursive: true });
                this.logger.info(`Backup directory created: ${this.config.backup.directory}`);
            }
        } catch (error) {
            this.logger.error('Failed to create backup directory:', error);
            throw error;
        }
    }

    /**
     * Initialize database connection
     */
    async initializeDatabase() {
        try {
            this.logger.info('Initializing database connection...');
            
            this.dbManager = new DatabaseManager();
            await this.dbManager.initialize();
            
            this.logger.info('Database connection established');
            return this.dbManager;
        } catch (error) {
            this.logger.error('Failed to initialize database:', error);
            throw error;
        }
    }

    /**
     * Run database migrations
     */
    async runMigrations() {
        try {
            this.logger.info('Starting database migrations...');
            
            const migrationManager = new MigrationManager(this.dbManager.db);
            const result = await migrationManager.runMigrations();
            
            this.logger.info(`Migrations completed: ${result.applied}/${result.total} applied`);
            return result;
        } catch (error) {
            this.logger.error('Migration failed:', error);
            throw error;
        }
    }

    /**
     * Seed initial data
     */
    async seedInitialData() {
        try {
            this.logger.info('Seeding initial data...');

            // Check if data already exists
            const existingSettings = await this.dbManager.db.get(
                `SELECT COUNT(*) as count FROM ${DATABASE_CONSTANTS.TABLES.CHATBOT_SETTINGS}`
            );

            if (existingSettings.count > 0) {
                this.logger.info('Initial data already exists, skipping seed');
                return;
            }

            // Seed default chatbot settings (these are already in migration 010)
            this.logger.info('Default settings seeded via migrations');

            // Seed test data if in development environment
            if (this.config.environment === 'development') {
                await this.seedDevelopmentData();
            }

            this.logger.info('Initial data seeding completed');
        } catch (error) {
            this.logger.error('Failed to seed initial data:', error);
            throw error;
        }
    }

    /**
     * Seed development test data
     */
    async seedDevelopmentData() {
        try {
            this.logger.info('Seeding development test data...');

            // Seed test patient
            const testPatient = {
                cliniko_id: 999999,
                first_name: 'Test',
                last_name: 'Patient',
                email: 'test.patient@example.com',
                phone_number: '+1234567890',
                mobile_number: '+1234567890',
                date_of_birth: '1990-01-01',
                gender: 'Other'
            };

            await this.dbManager.db.run(`
                INSERT OR IGNORE INTO ${DATABASE_CONSTANTS.TABLES.PATIENTS} 
                (cliniko_id, first_name, last_name, email, phone_number, mobile_number, date_of_birth, gender)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                testPatient.cliniko_id,
                testPatient.first_name,
                testPatient.last_name,
                testPatient.email,
                testPatient.phone_number,
                testPatient.mobile_number,
                testPatient.date_of_birth,
                testPatient.gender
            ]);

            // Seed test practitioner
            await this.dbManager.db.run(`
                INSERT OR IGNORE INTO ${DATABASE_CONSTANTS.TABLES.PRACTITIONERS}
                (cliniko_id, first_name, last_name, title, email, specialization, active)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                999999,
                'Dr. Test',
                'Practitioner',
                'Doctor',
                'test.doctor@example.com',
                'General Practice',
                1
            ]);

            // Seed test appointment type
            await this.dbManager.db.run(`
                INSERT OR IGNORE INTO ${DATABASE_CONSTANTS.TABLES.APPOINTMENT_TYPES}
                (cliniko_id, name, description, duration_minutes, bookable_online, active)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                999999,
                'General Consultation',
                'Standard consultation appointment',
                30,
                1,
                1
            ]);

            // Seed test business
            await this.dbManager.db.run(`
                INSERT OR IGNORE INTO ${DATABASE_CONSTANTS.TABLES.BUSINESSES}
                (cliniko_id, name, address_line_1, city, state, post_code, phone_number, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                999999,
                'Test Clinic',
                '123 Test Street',
                'Test City',
                'Test State',
                '12345',
                '+1234567890',
                1
            ]);

            this.logger.info('Development test data seeded');
        } catch (error) {
            this.logger.error('Failed to seed development data:', error);
            throw error;
        }
    }

    /**
     * Verify database setup
     */
    async verifySetup() {
        try {
            this.logger.info('Verifying database setup...');

            // Check all required tables exist
            const tables = Object.values(DATABASE_CONSTANTS.TABLES);
            
            for (const tableName of tables) {
                const result = await this.dbManager.db.get(`
                    SELECT name FROM sqlite_master 
                    WHERE type='table' AND name=?
                `, [tableName]);

                if (!result) {
                    throw new Error(`Required table missing: ${tableName}`);
                }
            }

            // Check migration status
            const migrationManager = new MigrationManager(this.dbManager.db);
            const status = await migrationManager.getMigrationStatus();
            
            this.logger.info(`Database verification completed:`);
            this.logger.info(`- Tables: ${tables.length} found`);
            this.logger.info(`- Migrations: ${status.appliedMigrations}/${status.totalMigrations} applied`);
            this.logger.info(`- Current version: ${status.currentVersion}`);

            return {
                tables: tables.length,
                migrations: status
            };
        } catch (error) {
            this.logger.error('Database verification failed:', error);
            throw error;
        }
    }

    /**
     * Create database backup
     */
    async createBackup(label = 'setup') {
        try {
            if (!this.config.backup || !this.config.backup.enabled) {
                this.logger.info('Backups not enabled, skipping backup creation');
                return;
            }

            if (this.config.filename === ':memory:') {
                this.logger.info('Cannot backup in-memory database');
                return;
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFilename = `chatbot_${label}_${timestamp}.db`;
            const backupPath = path.join(this.config.backup.directory, backupFilename);

            await fs.copyFile(this.config.filename, backupPath);
            this.logger.info(`Database backup created: ${backupPath}`);

            return backupPath;
        } catch (error) {
            this.logger.error('Failed to create backup:', error);
            throw error;
        }
    }

    /**
     * Clean up old backups
     */
    async cleanupOldBackups() {
        try {
            if (!this.config.backup || !this.config.backup.enabled) {
                return;
            }

            const backupDir = this.config.backup.directory;
            const retentionDays = this.config.backup.retention || 7;
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

            const files = await fs.readdir(backupDir);
            const backupFiles = files.filter(file => file.startsWith('chatbot_') && file.endsWith('.db'));

            let deletedCount = 0;
            for (const file of backupFiles) {
                const filePath = path.join(backupDir, file);
                const stats = await fs.stat(filePath);
                
                if (stats.mtime < cutoffDate) {
                    await fs.unlink(filePath);
                    deletedCount++;
                }
            }

            if (deletedCount > 0) {
                this.logger.info(`Cleaned up ${deletedCount} old backup(s)`);
            }
        } catch (error) {
            this.logger.error('Failed to cleanup old backups:', error);
            // Don't throw - this is not critical
        }
    }

    /**
     * Run complete database setup
     */
    async setup(options = {}) {
        const startTime = Date.now();
        
        try {
            this.logger.info('Starting database setup...');

            // Create directories
            await this.createDataDirectory();
            await this.createBackupDirectory();

            // Initialize database
            await this.initializeDatabase();

            // Run migrations
            const migrationResult = await this.runMigrations();

            // Seed initial data
            if (!options.skipSeed) {
                await this.seedInitialData();
            }

            // Create backup
            if (options.createBackup) {
                await this.createBackup();
            }

            // Cleanup old backups
            await this.cleanupOldBackups();

            // Verify setup
            const verification = await this.verifySetup();

            const duration = Date.now() - startTime;
            this.logger.info(`Database setup completed successfully in ${duration}ms`);

            return {
                success: true,
                duration,
                migrations: migrationResult,
                verification
            };

        } catch (error) {
            this.logger.error('Database setup failed:', error);
            throw error;
        } finally {
            if (this.dbManager) {
                await this.dbManager.close();
            }
        }
    }
}

/**
 * CLI execution
 */
async function main() {
    const args = process.argv.slice(2);
    const options = {
        skipSeed: args.includes('--skip-seed'),
        createBackup: args.includes('--backup'),
        force: args.includes('--force')
    };

    try {
        // Check if database already exists
        if (databaseExists() && !options.force) {
            console.log('Database already exists. Use --force to recreate or run migrations separately.');
            process.exit(1);
        }

        const setup = new DatabaseSetup();
        const result = await setup.setup(options);

        console.log('\n✅ Database setup completed successfully!');
        console.log(`📊 ${result.migrations.applied} migration(s) applied`);
        console.log(`🔍 ${result.verification.tables} table(s) verified`);
        console.log(`⏱️  Completed in ${result.duration}ms`);

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Database setup failed:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = DatabaseSetup;
