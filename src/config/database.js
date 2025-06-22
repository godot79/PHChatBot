const path = require('path');

/**
 * Database Configuration
 * Environment-specific database settings
 */

const databaseConfig = {
    development: {
        filename: path.join(__dirname, '../../data/chatbot.db'),
        options: {
            mode: require('sqlite3').OPEN_READWRITE | require('sqlite3').OPEN_CREATE,
            verbose: process.env.NODE_ENV === 'development'
        },
        pool: {
            min: 1,
            max: 5,
            idle: 10000
        },
        migrations: {
            directory: path.join(__dirname, '../database/schemas'),
            tableName: 'schema_migrations'
        },
        backup: {
            enabled: true,
            directory: path.join(__dirname, '../../data/backups'),
            retention: 7 // days
        }
    },

    test: {
        filename: ':memory:', // In-memory database for testing
        options: {
            mode: require('sqlite3').OPEN_READWRITE | require('sqlite3').OPEN_CREATE,
            verbose: false
        },
        pool: {
            min: 1,
            max: 1,
            idle: 1000
        },
        migrations: {
            directory: path.join(__dirname, '../database/schemas'),
            tableName: 'schema_migrations'
        },
        backup: {
            enabled: false
        }
    },

    production: {
        filename: process.env.DATABASE_PATH || path.join(__dirname, '../../data/chatbot.db'),
        options: {
            mode: require('sqlite3').OPEN_READWRITE | require('sqlite3').OPEN_CREATE,
            verbose: false
        },
        pool: {
            min: 2,
            max: 10,
            idle: 30000
        },
        migrations: {
            directory: path.join(__dirname, '../database/schemas'),
            tableName: 'schema_migrations'
        },
        backup: {
            enabled: true,
            directory: process.env.BACKUP_PATH || path.join(__dirname, '../../data/backups'),
            retention: parseInt(process.env.BACKUP_RETENTION_DAYS) || 30,
            schedule: '0 2 * * *' // Daily at 2 AM
        }
    }
};

/**
 * Get configuration for current environment
 */
function getDatabaseConfig() {
    const env = process.env.NODE_ENV || 'development';
    const config = databaseConfig[env];
    
    if (!config) {
        throw new Error(`Database configuration not found for environment: ${env}`);
    }

    return {
        ...config,
        environment: env
    };
}

/**
 * Database constants
 */
const DATABASE_CONSTANTS = {
    SESSION_TIMEOUT_MINUTES: 30,
    MAX_VERIFICATION_ATTEMPTS: 3,
    MAX_CONNECTION_RETRIES: 5,
    CONNECTION_RETRY_DELAY: 1000,
    TRANSACTION_TIMEOUT: 30000,
    QUERY_TIMEOUT: 10000,
    
    // Table names
    TABLES: {
        SESSIONS: 'sessions',
        CONVERSATIONS: 'conversations',
        PATIENTS: 'patients',
        APPOINTMENTS: 'appointments',
        REMINDERS: 'reminders',
        PRACTITIONERS: 'practitioners',
        APPOINTMENT_TYPES: 'appointment_types',
        BUSINESSES: 'businesses',
        AUDIT_LOG: 'audit_log',
        CHATBOT_SETTINGS: 'chatbot_settings',
        SCHEMA_MIGRATIONS: 'schema_migrations'
    },

    // User states
    USER_STATES: {
        INITIAL: 'initial',
        VERIFYING: 'verifying',
        VERIFIED: 'verified',
        BOOKING: 'booking',
        CANCELLING: 'cancelling',
        RESCHEDULING: 'rescheduling',
        INFORMATION: 'information'
    },

    // Verification statuses
    VERIFICATION_STATUS: {
        UNVERIFIED: 'unverified',
        PENDING: 'pending',
        VERIFIED: 'verified',
        FAILED: 'failed',
        EXPIRED: 'expired'
    },

    // Message directions
    MESSAGE_DIRECTIONS: {
        INBOUND: 'inbound',
        OUTBOUND: 'outbound'
    },

    // Reminder types
    REMINDER_TYPES: {
        TWENTY_FOUR_HOUR: '24h',
        TWO_HOUR: '2h',
        CUSTOM: 'custom'
    },

    // Reminder statuses
    REMINDER_STATUSES: {
        PENDING: 'pending',
        SENT: 'sent',
        FAILED: 'failed',
        CANCELLED: 'cancelled'
    }
};

/**
 * Validate database configuration
 */
function validateDatabaseConfig(config) {
    const requiredFields = ['filename', 'options', 'migrations'];
    
    for (const field of requiredFields) {
        if (!config[field]) {
            throw new Error(`Missing required database configuration field: ${field}`);
        }
    }

    // Validate migrations directory
    if (!config.migrations.directory) {
        throw new Error('Migrations directory not specified in database configuration');
    }

    // Validate backup configuration for production
    if (config.environment === 'production' && config.backup.enabled) {
        if (!config.backup.directory) {
            throw new Error('Backup directory required when backups are enabled');
        }
    }

    return true;
}

/**
 * Get database file path
 */
function getDatabasePath(env = null) {
    const environment = env || process.env.NODE_ENV || 'development';
    const config = databaseConfig[environment];
    
    if (!config) {
        throw new Error(`Database configuration not found for environment: ${environment}`);
    }

    return config.filename;
}

/**
 * Check if database file exists
 */
function databaseExists(env = null) {
    const fs = require('fs');
    const dbPath = getDatabasePath(env);
    
    // In-memory databases always "exist"
    if (dbPath === ':memory:') {
        return true;
    }

    return fs.existsSync(dbPath);
}

module.exports = {
    getDatabaseConfig,
    validateDatabaseConfig,
    getDatabasePath,
    databaseExists,
    DATABASE_CONSTANTS,
    databaseConfig
};
