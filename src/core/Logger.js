// src/core/Logger.js
const winston = require('winston');
const path = require('path');
const fs = require('fs');

class Logger {
    constructor(options = {}) {
        this.logLevel = options.logLevel || process.env.LOG_LEVEL || 'info';
        this.logDir = options.logDir || path.join(__dirname, '../../logs');
        this.serviceName = options.serviceName || 'whatsapp-chatbot';
        
        // Ensure log directory exists
        this.ensureLogDirectory();
        
        // Create Winston logger instance
        this.logger = this.createLogger();
        
        // Track log statistics
        this.stats = {
            error: 0,
            warn: 0,
            info: 0,
            debug: 0,
            total: 0
        };
    }

    /**
     * Ensure log directory exists
     */
    ensureLogDirectory() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    /**
     * Create Winston logger with multiple transports
     */
    createLogger() {
        // Custom format for logs
        const customFormat = winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
            winston.format.errors({ stack: true }),
            winston.format.json(),
            winston.format.printf(info => {
                const { timestamp, level, message, service, sessionId, userId, ...meta } = info;
                
                let logEntry = {
                    timestamp,
                    level: level.toUpperCase(),
                    service: service || this.serviceName,
                    message
                };

                // Add context if available
                if (sessionId) logEntry.sessionId = sessionId;
                if (userId) logEntry.userId = userId;
                
                // Add metadata if present
                if (Object.keys(meta).length > 0) {
                    logEntry.meta = meta;
                }

                return JSON.stringify(logEntry);
            })
        );

        // Console format for development
        const consoleFormat = winston.format.combine(
            winston.format.timestamp({ format: 'HH:mm:ss' }),
            winston.format.colorize(),
            winston.format.printf(info => {
                const { timestamp, level, message, sessionId, userId } = info;
                let logLine = `${timestamp} [${level}]`;
                
                if (sessionId) logLine += ` [${sessionId}]`;
                if (userId) logLine += ` [${userId}]`;
                
                logLine += `: ${message}`;
                
                return logLine;
            })
        );

        // Create transports
        const transports = [
            // Console output (development)
            new winston.transports.Console({
                format: consoleFormat,
                level: this.logLevel,
                silent: process.env.NODE_ENV === 'test'
            }),

            // Application logs (all levels)
            new winston.transports.File({
                filename: path.join(this.logDir, 'app.log'),
                format: customFormat,
                level: 'debug',
                maxsize: 10 * 1024 * 1024, // 10MB
                maxFiles: 5,
                tailable: true
            }),

            // Error logs (error level only)
            new winston.transports.File({
                filename: path.join(this.logDir, 'error.log'),
                format: customFormat,
                level: 'error',
                maxsize: 10 * 1024 * 1024, // 10MB
                maxFiles: 5,
                tailable: true
            }),

            // Webhook specific logs
            new winston.transports.File({
                filename: path.join(this.logDir, 'webhook.log'),
                format: customFormat,
                level: 'info',
                maxsize: 5 * 1024 * 1024, // 5MB
                maxFiles: 3,
                tailable: true
            })
        ];

        // Add daily rotate file transport for production
        if (process.env.NODE_ENV === 'production') {
            const DailyRotateFile = require('winston-daily-rotate-file');
            
            transports.push(
                new DailyRotateFile({
                    filename: path.join(this.logDir, 'app-%DATE%.log'),
                    datePattern: 'YYYY-MM-DD',
                    format: customFormat,
                    maxSize: '20m',
                    maxFiles: '14d',
                    level: 'info'
                })
            );
        }

        return winston.createLogger({
            level: this.logLevel,
            format: customFormat,
            defaultMeta: { service: this.serviceName },
            transports,
            exitOnError: false
        });
    }

    /**
     * Log error message
     */
    error(message, meta = {}) {
        this.stats.error++;
        this.stats.total++;
        
        if (meta instanceof Error) {
            this.logger.error(message, {
                error: meta.message,
                stack: meta.stack,
                ...this.extractContext()
            });
        } else {
            this.logger.error(message, { ...meta, ...this.extractContext() });
        }
    }

    /**
     * Log warning message
     */
    warn(message, meta = {}) {
        this.stats.warn++;
        this.stats.total++;
        this.logger.warn(message, { ...meta, ...this.extractContext() });
    }

    /**
     * Log info message
     */
    info(message, meta = {}) {
        this.stats.info++;
        this.stats.total++;
        this.logger.info(message, { ...meta, ...this.extractContext() });
    }

    /**
     * Log debug message
     */
    debug(message, meta = {}) {
        this.stats.debug++;
        this.stats.total++;
        this.logger.debug(message, { ...meta, ...this.extractContext() });
    }

    /**
     * Log webhook activity
     */
    webhook(message, meta = {}) {
        this.logger.info(`[WEBHOOK] ${message}`, {
            ...meta,
            webhook: true,
            ...this.extractContext()
        });
    }

    /**
     * Log API activity
     */
    api(method, endpoint, status, duration, meta = {}) {
        const message = `${method} ${endpoint} ${status} ${duration}ms`;
        
        const logMeta = {
            ...meta,
            api: true,
            method,
            endpoint,
            status,
            duration,
            ...this.extractContext()
        };

        if (status >= 400) {
            this.error(message, logMeta);
        } else {
            this.info(message, logMeta);
        }
    }

    /**
     * Log database operations
     */
    database(operation, table, duration, meta = {}) {
        const message = `DB ${operation} ${table} ${duration}ms`;
        
        this.debug(message, {
            ...meta,
            database: true,
            operation,
            table,
            duration,
            ...this.extractContext()
        });
    }

    /**
     * Log user activity
     */
    userActivity(userId, action, meta = {}) {
        this.info(`User ${action}`, {
            ...meta,
            userId,
            action,
            userActivity: true,
            ...this.extractContext()
        });
    }

    /**
     * Log session activity
     */
    sessionActivity(sessionId, action, meta = {}) {
        this.info(`Session ${action}`, {
            ...meta,
            sessionId,
            action,
            sessionActivity: true,
            ...this.extractContext()
        });
    }

    /**
     * Log a structured analytics event as raw JSON on stdout.
     * Bypasses consoleFormat (which only prints message/timestamp/level/
     * sessionId/userId, dropping other fields) so Cloud Run's captured
     * stdout — the only durable copy of these events — carries the full
     * payload, parseable by Cloud Logging as jsonPayload.
     */
    analyticsEvent(payload = {}) {
        this.stats.info++;
        this.stats.total++;
        console.log(JSON.stringify({ marker: 'ANALYTICS_EVENT', ...payload }));
    }

    /**
     * Log conversation activity
     */
    conversation(sessionId, direction, messageType, meta = {}) {
        this.info(`Message ${direction}`, {
            ...meta,
            sessionId,
            direction,
            messageType,
            conversation: true,
            ...this.extractContext()
        });
    }

    /**
     * Log performance metrics
     */
    performance(operation, duration, meta = {}) {
        const level = duration > 5000 ? 'warn' : 'info';
        const message = `Performance: ${operation} took ${duration}ms`;
        
        this.logger.log(level, message, {
            ...meta,
            performance: true,
            operation,
            duration,
            ...this.extractContext()
        });
    }

    /**
     * Log security events
     */
    security(event, severity = 'info', meta = {}) {
        const message = `Security: ${event}`;
        
        this.logger.log(severity, message, {
            ...meta,
            security: true,
            event,
            severity,
            ...this.extractContext()
        });
    }

    /**
     * Log system health metrics
     */
    health(component, status, meta = {}) {
        const level = status === 'healthy' ? 'info' : 'warn';
        const message = `Health: ${component} is ${status}`;
        
        this.logger.log(level, message, {
            ...meta,
            health: true,
            component,
            status,
            ...this.extractContext()
        });
    }

    /**
     * Create child logger with persistent context
     */
    child(context = {}) {
        return {
            error: (message, meta = {}) => this.error(message, { ...context, ...meta }),
            warn: (message, meta = {}) => this.warn(message, { ...context, ...meta }),
            info: (message, meta = {}) => this.info(message, { ...context, ...meta }),
            debug: (message, meta = {}) => this.debug(message, { ...context, ...meta }),
            webhook: (message, meta = {}) => this.webhook(message, { ...context, ...meta }),
            api: (method, endpoint, status, duration, meta = {}) => 
                this.api(method, endpoint, status, duration, { ...context, ...meta }),
            database: (operation, table, duration, meta = {}) => 
                this.database(operation, table, duration, { ...context, ...meta }),
            userActivity: (userId, action, meta = {}) => 
                this.userActivity(userId, action, { ...context, ...meta }),
            sessionActivity: (sessionId, action, meta = {}) => 
                this.sessionActivity(sessionId, action, { ...context, ...meta }),
            conversation: (sessionId, direction, messageType, meta = {}) => 
                this.conversation(sessionId, direction, messageType, { ...context, ...meta }),
            performance: (operation, duration, meta = {}) => 
                this.performance(operation, duration, { ...context, ...meta }),
            security: (event, severity, meta = {}) => 
                this.security(event, severity, { ...context, ...meta }),
            health: (component, status, meta = {}) => 
                this.health(component, status, { ...context, ...meta })
        };
    }

    /**
     * Extract context from current execution
     */
    extractContext() {
        const context = {};
        
        // Add process information
        context.pid = process.pid;
        context.memory = process.memoryUsage();
        
        // Add request context if available (Express middleware would set this)
        if (global.currentRequest) {
            const req = global.currentRequest;
            context.requestId = req.id;
            context.userAgent = req.get('User-Agent');
            context.ip = req.ip;
        }

        return context;
    }

    /**
     * Get log statistics
     */
    getStats() {
        return {
            ...this.stats,
            logLevel: this.logLevel,
            logDir: this.logDir,
            uptime: process.uptime()
        };
    }

    /**
     * Query logs (simple file-based query)
     */
    async queryLogs(options = {}) {
        const {
            level = null,
            service = null,
            sessionId = null,
            since = null,
            limit = 100,
            logFile = 'app.log'
        } = options;

        try {
            const logPath = path.join(this.logDir, logFile);
            if (!fs.existsSync(logPath)) {
                return [];
            }

            const content = fs.readFileSync(logPath, 'utf8');
            const lines = content.split('\n').filter(line => line.trim());
            
            let logs = lines
                .map(line => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                })
                .filter(log => log !== null);

            // Apply filters
            if (level) {
                logs = logs.filter(log => log.level === level.toUpperCase());
            }
            
            if (service) {
                logs = logs.filter(log => log.service === service);
            }
            
            if (sessionId) {
                logs = logs.filter(log => log.sessionId === sessionId);
            }
            
            if (since) {
                const sinceDate = new Date(since);
                logs = logs.filter(log => new Date(log.timestamp) >= sinceDate);
            }

            // Sort by timestamp (newest first) and limit
            return logs
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                .slice(0, limit);

        } catch (error) {
            this.error('Failed to query logs:', error);
            return [];
        }
    }

    /**
     * Rotate logs manually
     */
    async rotateLogs() {
        try {
            // Close current log files
            this.logger.close();
            
            // Recreate logger (will create new files)
            this.logger = this.createLogger();
            
            this.info('Log rotation completed');
            return true;
        } catch (error) {
            console.error('Failed to rotate logs:', error);
            return false;
        }
    }

    /**
     * Set log level dynamically
     */
    setLogLevel(level) {
        this.logLevel = level;
        this.logger.level = level;
        this.info(`Log level changed to ${level}`);
    }

    /**
     * Cleanup old log files
     */
    async cleanupLogs(daysToKeep = 30) {
        try {
            const files = fs.readdirSync(this.logDir);
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

            let deletedCount = 0;
            
            for (const file of files) {
                const filePath = path.join(this.logDir, file);
                const stats = fs.statSync(filePath);
                
                if (stats.mtime < cutoffDate) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            }

            this.info(`Cleaned up ${deletedCount} old log files`);
            return deletedCount;
        } catch (error) {
            this.error('Failed to cleanup logs:', error);
            throw error;
        }
    }

    /**
     * Get log file sizes
     */
    getLogFileSizes() {
        try {
            const files = fs.readdirSync(this.logDir);
            const sizes = {};
            
            for (const file of files) {
                const filePath = path.join(this.logDir, file);
                const stats = fs.statSync(filePath);
                sizes[file] = {
                    size: stats.size,
                    sizeFormatted: this.formatBytes(stats.size),
                    modified: stats.mtime
                };
            }
            
            return sizes;
        } catch (error) {
            this.error('Failed to get log file sizes:', error);
            return {};
        }
    }

    /**
     * Format bytes to human readable string
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Close logger and cleanup
     */
    close() {
        if (this.logger) {
            this.logger.close();
        }
        this.info('Logger closed');
    }
}

module.exports = Logger;
