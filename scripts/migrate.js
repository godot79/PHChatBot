#!/usr/bin/env node

/**
 * Database Migration Runner
 * Standalone script for running database migrations
 */

const { getDatabaseConfig } = require('../src/config/database');
const DatabaseManager = require('../src/core/DatabaseManager');
const MigrationManager = require('../src/database/migrations');
const Logger = require('../src/core/Logger');

class MigrationRunner {
    constructor() {
        this.logger = new Logger('MigrationRunner');
        this.config = getDatabaseConfig();
    }

    /**
     * Initialize database connection
     */
    async initialize() {
        try {
            this.dbManager = new DatabaseManager();
            await this.dbManager.initialize();
            this.migrationManager = new MigrationManager(this.dbManager.db);
            
            this.logger.info('Migration runner initialized');
        } catch (error) {
            this.logger.error('Failed to initialize migration runner:', error);
            throw error;
        }
    }

    /**
     * Run pending migrations
     */
    async migrate() {
        try {
            this.logger.info('Running migrations...');
            
            const result = await this.migrationManager.runMigrations();
            
            if (result.applied === 0) {
                this.logger.info('No pending migrations found');
            } else {
                this.logger.info(`Successfully applied ${result.applied} migration(s)`);
            }

            return result;
        } catch (error) {
            this.logger.error('Migration failed:', error);
            throw error;
        }
    }

    /**
     * Show migration status
     */
    async status() {
        try {
            const status = await this.migrationManager.getMigrationStatus();
            
            console.log('\n📊 Migration Status:');
            console.log(`Current Version: ${status.currentVersion}`);
            console.log(`Total Migrations: ${status.totalMigrations}`);
            console.log(`Applied: ${status.appliedMigrations}`);
            console.log(`Pending: ${status.pendingMigrations}`);
            
            if (status.migrations.length > 0) {
                console.log('\n📋 Migrations:');
                status.migrations.forEach(migration => {
                    const status = migration.applied ? '✅' : '⏳';
                    const appliedText = migration.applied 
                        ? `(${new Date(migration.appliedAt).toLocaleDateString()})`
                        : '(pending)';
                    
                    console.log(`${status} ${migration.version}_${migration.name} ${appliedText}`);
                });
            }

            return status;
        } catch (error) {
            this.logger.error('Failed to get migration status:', error);
            throw error;
        }
    }

    /**
     * Rollback to specific version
     */
    async rollback(targetVersion) {
        try {
            this.logger.warn(`Rolling back to version ${targetVersion}...`);
            
            const result = await this.migrationManager.rollbackToVersion(targetVersion);
            
            if (result.rolledBack === 0) {
                this.logger.info('No migrations to rollback');
            } else {
                this.logger.warn(`Rolled back ${result.rolledBack} migration(s)`);
                this.logger.warn('Note: This is a destructive operation. You may need to recreate data.');
            }

            return result;
        } catch (error) {
            this.logger.error('Rollback failed:', error);
            throw error;
        }
    }

    /**
     * Create new migration file
     */
    async create(name) {
        try {
            if (!name) {
                throw new Error('Migration name is required');
            }

            const migration = await this.migrationManager.createMigration(name);
            
            console.log('\n✅ Migration created successfully!');
            console.log(`📄 File: ${migration.filename}`);
            console.log(`📍 Path: ${migration.filepath}`);
            console.log(`🔢 Version: ${migration.version}`);
            console.log('\nEdit the file to add your migration SQL, then run:');
            console.log('npm run migrate');

            return migration;
        } catch (error) {
            this.logger.error('Failed to create migration:', error);
            throw error;
        }
    }

    /**
     * Verify migration integrity
     */
    async verify() {
        try {
            this.logger.info('Verifying migration integrity...');
            
            const availableMigrations = await this.migrationManager.getAvailableMigrations();
            const appliedMigrations = await this.migrationManager.getAppliedMigrations();

            const appliedMap = new Map();
            appliedMigrations.forEach(migration => {
                appliedMap.set(migration.version, migration);
            });

            let verified = 0;
            let errors = [];

            for (const migration of availableMigrations) {
                const appliedMigration = appliedMap.get(migration.version);
                if (appliedMigration) {
                    try {
                        await this.migrationManager.verifyMigrationIntegrity(migration, appliedMigration);
                        verified++;
                    } catch (error) {
                        errors.push({
                            migration: `${migration.version}_${migration.name}`,
                            error: error.message
                        });
                    }
                }
            }

            if (errors.length === 0) {
                console.log(`\n✅ All ${verified} applied migration(s) verified successfully`);
            } else {
                console.log(`\n⚠️  Verification completed with ${errors.length} error(s):`);
                errors.forEach(error => {
                    console.log(`❌ ${error.migration}: ${error.error}`);
                });
            }

            return { verified, errors };
        } catch (error) {
            this.logger.error('Migration verification failed:', error);
            throw error;
        }
    }

    /**
     * Reset database (drops all tables and re-runs migrations)
     */
    async reset(confirm = false) {
        try {
            if (!confirm) {
                throw new Error('Reset operation requires confirmation. Use --confirm flag.');
            }

            this.logger.warn('Resetting database - this will DROP ALL TABLES!');
            
            // Get all table names
            const tables = await this.dbManager.db.all(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name NOT LIKE 'sqlite_%'
            `);

            // Drop all tables
            await this.dbManager.db.run('BEGIN TRANSACTION');
            
            try {
                for (const table of tables) {
                    await this.dbManager.db.run(`DROP TABLE IF EXISTS ${table.name}`);
                    this.logger.info(`Dropped table: ${table.name}`);
                }
                
                await this.dbManager.db.run('COMMIT');
                this.logger.info('All tables dropped');
                
                // Re-run migrations
                const result = await this.migrate();
                
                console.log('\n✅ Database reset completed successfully!');
                console.log(`📊 Applied ${result.applied} migration(s)`);
                
                return result;
                
            } catch (error) {
                await this.dbManager.db.run('ROLLBACK');
                throw error;
            }

        } catch (error) {
            this.logger.error('Database reset failed:', error);
            throw error;
        }
    }

    /**
     * Cleanup and close connections
     */
    async close() {
        if (this.dbManager) {
            await this.dbManager.close();
        }
    }
}

/**
 * CLI execution
 */
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    
    const runner = new MigrationRunner();
    
    try {
        await runner.initialize();
        
        switch (command) {
            case 'status':
                await runner.status();
                break;
                
            case 'up':
            case 'migrate':
            case undefined: // Default action
                await runner.migrate();
                break;
                
            case 'rollback':
                const targetVersion = parseInt(args[1]);
                if (isNaN(targetVersion)) {
                    throw new Error('Rollback requires a target version number');
                }
                await runner.rollback(targetVersion);
                break;
                
            case 'create':
                const migrationName = args[1];
                await runner.create(migrationName);
                break;
                
            case 'verify':
                await runner.verify();
                break;
                
            case 'reset':
                const confirm = args.includes('--confirm');
                await runner.reset(confirm);
                break;
                
            default:
                console.log(`
Usage: node scripts/migrate.js [command] [options]

Commands:
  migrate, up     Run pending migrations (default)
  status          Show migration status
  rollback <ver>  Rollback to specific version
  create <name>   Create new migration file
  verify          Verify migration integrity
  reset --confirm Reset database (destructive)

Examples:
  node scripts/migrate.js
  node scripts/migrate.js status
  node scripts/migrate.js create add_user_preferences
  node scripts/migrate.js rollback 5
  node scripts/migrate.js reset --confirm
                `);
                process.exit(1);
        }
        
        process.exit(0);
        
    } catch (error) {
        console.error(`\n❌ ${error.message}`);
        process.exit(1);
    } finally {
        await runner.close();
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = MigrationRunner;
