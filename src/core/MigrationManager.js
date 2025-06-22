const fs = require('fs').promises;
const path = require('path');
const Logger = require('../core/Logger');

/**
 * Database Migration System
 * Handles database schema versioning and migrations
 */
class MigrationManager {
    constructor(db) {
        this.db = db;
        this.logger = new Logger('MigrationManager');
        this.migrationsPath = path.join(__dirname, 'schemas');
        this.migrationTable = 'schema_migrations';
    }

    /**
     * Initialize migration tracking table
     */
    async initializeMigrationTable() {
        try {
            const createMigrationTableSQL = `
                CREATE TABLE IF NOT EXISTS ${this.migrationTable} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    version INTEGER UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    checksum TEXT NOT NULL
                )
            `;

            await this.db.run(createMigrationTableSQL);
            this.logger.info('Migration table initialized');
        } catch (error) {
            this.logger.error('Failed to initialize migration table:', error);
            throw error;
        }
    }

    /**
     * Get all available migration files
     */
    async getAvailableMigrations() {
        try {
            const files = await fs.readdir(this.migrationsPath);
            const migrationFiles = files
                .filter(file => file.endsWith('.sql'))
                .sort()
                .map(file => {
                    const match = file.match(/^(\d+)_(.+)\.sql$/);
                    if (!match) {
                        throw new Error(`Invalid migration filename: ${file}`);
                    }
                    return {
                        version: parseInt(match[1]),
                        name: match[2],
                        filename: file,
                        filepath: path.join(this.migrationsPath, file)
                    };
                });

            return migrationFiles;
        } catch (error) {
            this.logger.error('Failed to get available migrations:', error);
            throw error;
        }
    }

    /**
     * Get applied migrations from database
     */
    async getAppliedMigrations() {
        try {
            const sql = `SELECT version, name, applied_at, checksum FROM ${this.migrationTable} ORDER BY version`;
            const rows = await this.db.all(sql);
            return rows || [];
        } catch (error) {
            this.logger.error('Failed to get applied migrations:', error);
            throw error;
        }
    }

    /**
     * Calculate checksum for migration content
     */
    calculateChecksum(content) {
        const crypto = require('crypto');
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Read migration file content
     */
    async readMigrationFile(filepath) {
        try {
            const content = await fs.readFile(filepath, 'utf8');
            return content.trim();
        } catch (error) {
            this.logger.error(`Failed to read migration file: ${filepath}`, error);
            throw error;
        }
    }

    /**
     * Execute a single migration
     */
    async executeMigration(migration) {
        try {
            const content = await this.readMigrationFile(migration.filepath);
            const checksum = this.calculateChecksum(content);

            // Start transaction
            await this.db.run('BEGIN TRANSACTION');

            try {
                // Execute migration SQL
                await this.db.exec(content);

                // Record migration as applied
                const insertSQL = `
                    INSERT INTO ${this.migrationTable} (version, name, checksum)
                    VALUES (?, ?, ?)
                `;
                await this.db.run(insertSQL, [migration.version, migration.name, checksum]);

                // Commit transaction
                await this.db.run('COMMIT');

                this.logger.info(`Migration applied: ${migration.version}_${migration.name}`);
                return true;
            } catch (error) {
                // Rollback on error
                await this.db.run('ROLLBACK');
                throw error;
            }
        } catch (error) {
            this.logger.error(`Failed to execute migration ${migration.version}_${migration.name}:`, error);
            throw error;
        }
    }

    /**
     * Verify migration integrity
     */
    async verifyMigrationIntegrity(migration, appliedMigration) {
        try {
            const content = await this.readMigrationFile(migration.filepath);
            const currentChecksum = this.calculateChecksum(content);

            if (currentChecksum !== appliedMigration.checksum) {
                throw new Error(
                    `Migration integrity check failed for ${migration.version}_${migration.name}. ` +
                    `File has been modified since it was applied.`
                );
            }

            return true;
        } catch (error) {
            this.logger.error('Migration integrity verification failed:', error);
            throw error;
        }
    }

    /**
     * Run pending migrations
     */
    async runMigrations() {
        try {
            this.logger.info('Starting database migrations...');

            // Initialize migration table
            await this.initializeMigrationTable();

            // Get available and applied migrations
            const availableMigrations = await this.getAvailableMigrations();
            const appliedMigrations = await this.getAppliedMigrations();

            // Create lookup map for applied migrations
            const appliedMap = new Map();
            appliedMigrations.forEach(migration => {
                appliedMap.set(migration.version, migration);
            });

            // Verify integrity of applied migrations
            for (const migration of availableMigrations) {
                const appliedMigration = appliedMap.get(migration.version);
                if (appliedMigration) {
                    await this.verifyMigrationIntegrity(migration, appliedMigration);
                }
            }

            // Find pending migrations
            const pendingMigrations = availableMigrations.filter(
                migration => !appliedMap.has(migration.version)
            );

            if (pendingMigrations.length === 0) {
                this.logger.info('No pending migrations found');
                return { applied: 0, total: availableMigrations.length };
            }

            // Execute pending migrations
            let appliedCount = 0;
            for (const migration of pendingMigrations) {
                await this.executeMigration(migration);
                appliedCount++;
            }

            this.logger.info(`Database migrations completed. Applied ${appliedCount} migration(s)`);
            return { applied: appliedCount, total: availableMigrations.length };

        } catch (error) {
            this.logger.error('Migration process failed:', error);
            throw error;
        }
    }

    /**
     * Get current database version
     */
    async getCurrentVersion() {
        try {
            const sql = `SELECT MAX(version) as current_version FROM ${this.migrationTable}`;
            const row = await this.db.get(sql);
            return row?.current_version || 0;
        } catch (error) {
            this.logger.error('Failed to get current database version:', error);
            return 0;
        }
    }

    /**
     * Get migration status
     */
    async getMigrationStatus() {
        try {
            const availableMigrations = await this.getAvailableMigrations();
            const appliedMigrations = await this.getAppliedMigrations();
            const currentVersion = await this.getCurrentVersion();

            const appliedMap = new Map();
            appliedMigrations.forEach(migration => {
                appliedMap.set(migration.version, migration);
            });

            const status = availableMigrations.map(migration => ({
                version: migration.version,
                name: migration.name,
                applied: appliedMap.has(migration.version),
                appliedAt: appliedMap.get(migration.version)?.applied_at || null
            }));

            return {
                currentVersion,
                totalMigrations: availableMigrations.length,
                appliedMigrations: appliedMigrations.length,
                pendingMigrations: availableMigrations.length - appliedMigrations.length,
                migrations: status
            };
        } catch (error) {
            this.logger.error('Failed to get migration status:', error);
            throw error;
        }
    }

    /**
     * Rollback to specific version (destructive operation)
     */
    async rollbackToVersion(targetVersion) {
        try {
            this.logger.warn(`Rolling back database to version ${targetVersion}`);

            const appliedMigrations = await this.getAppliedMigrations();
            const migrationsToRollback = appliedMigrations
                .filter(migration => migration.version > targetVersion)
                .sort((a, b) => b.version - a.version); // Rollback in reverse order

            if (migrationsToRollback.length === 0) {
                this.logger.info('No migrations to rollback');
                return { rolledBack: 0 };
            }

            // Start transaction
            await this.db.run('BEGIN TRANSACTION');

            try {
                // For SQLite, we need to drop and recreate tables
                // This is a destructive operation
                for (const migration of migrationsToRollback) {
                    // Remove migration record
                    const deleteSQL = `DELETE FROM ${this.migrationTable} WHERE version = ?`;
                    await this.db.run(deleteSQL, [migration.version]);
                    
                    this.logger.info(`Rolled back migration: ${migration.version}_${migration.name}`);
                }

                await this.db.run('COMMIT');

                this.logger.warn(`Rollback completed. ${migrationsToRollback.length} migration(s) rolled back`);
                this.logger.warn('Note: You may need to recreate tables manually or re-run migrations');

                return { rolledBack: migrationsToRollback.length };

            } catch (error) {
                await this.db.run('ROLLBACK');
                throw error;
            }

        } catch (error) {
            this.logger.error('Rollback failed:', error);
            throw error;
        }
    }

    /**
     * Create new migration file template
     */
    async createMigration(name) {
        try {
            const availableMigrations = await this.getAvailableMigrations();
            const nextVersion = availableMigrations.length > 0 
                ? Math.max(...availableMigrations.map(m => m.version)) + 1 
                : 1;

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `${nextVersion.toString().padStart(3, '0')}_${name.replace(/\s+/g, '_').toLowerCase()}.sql`;
            const filepath = path.join(this.migrationsPath, filename);

            const template = `-- Migration: ${name}
-- Version: ${nextVersion}
-- Created: ${new Date().toISOString()}

-- Add your migration SQL here
-- Example:
-- CREATE TABLE example_table (
--     id INTEGER PRIMARY KEY AUTOINCREMENT,
--     name TEXT NOT NULL,
--     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
-- );

-- Remember to:
-- 1. Keep migrations idempotent when possible
-- 2. Use IF NOT EXISTS for CREATE statements
-- 3. Test migrations thoroughly before applying
`;

            await fs.writeFile(filepath, template);
            this.logger.info(`Created migration file: ${filename}`);

            return {
                version: nextVersion,
                name,
                filename,
                filepath
            };

        } catch (error) {
            this.logger.error('Failed to create migration:', error);
            throw error;
        }
    }
}

module.exports = MigrationManager;
