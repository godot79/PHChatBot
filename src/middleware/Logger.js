const fs = require('fs').promises;
const path = require('path');

class Logger {
    constructor(options = {}) {
        this.logLevel = options.logLevel || 'info';
        this.logDir = options.logDir || './logs';
        this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
        this.maxFiles = options.maxFiles || 5;
        this.enableConsole = options.enableConsole !== false;
        this.enableFile = options.enableFile !== false;
        
        this.levels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3,
            trace: 4
        };

        this.initialized = false;
        this.init();
    }

    async init() {
        if (this.enableFile) {
            try {
                await fs.mkdir(this.logDir, { recursive: true });
                this.initialized = true;
            } catch (error) {
                console.error('Failed to initialize logger:', error);
                this.enableFile = false;
            }
        }
        this.initialized = true;
    }

    shouldLog(level) {
        return this.levels[level] <= this.levels[this.logLevel];
    }

    formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const formattedMeta = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
        
        return {
            timestamp,
            level: level.toUpperCase(),
            message,
            meta,
            formatted: `[${timestamp}] ${level.toUpperCase()}: ${message} ${formattedMeta}`.trim()
        };
    }

    async writeToFile(logEntry, filename) {
        if (!this.enableFile || !this.initialized) return;

        try {
            const filepath = path.join(this.logDir, filename);
            
            // Check file size and rotate if necessary
            try {
                const stats = await fs.stat(filepath);
                if (stats.size > this.maxFileSize) {
                    await this.rotateLogFile(filename);
                }
            } catch (error) {
                // File doesn't exist, which is fine
            }

            const logLine = logEntry.formatted + '\n';
            await fs.appendFile(filepath, logLine);
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    async rotateLogFile(filename) {
        const filepath = path.join(this.logDir, filename);
        const nameWithoutExt = path.parse(filename).name;
        const ext = path.parse(filename).ext;

        try {
            // Rotate existing files
            for (let i = this.maxFiles - 1; i >= 1; i--) {
                const oldFile = path.join(this.logDir, `${nameWithoutExt}.${i}${ext}`);
                const newFile = path.join(this.logDir, `${nameWithoutExt}.${i + 1}${ext}`);
                
                try {
                    await fs.access(oldFile);
                    if (i === this.maxFiles - 1) {
                        // Delete the oldest file
                        await fs.unlink(oldFile);
                    } else {
                        // Move file to next number
                        await fs.rename(oldFile, newFile);
                    }
                } catch (error) {
                    // File doesn't exist, continue
                }
            }

            // Move current file to .1
            const rotatedFile = path.join(this.logDir, `${nameWithoutExt}.1${ext}`);
            await fs.rename(filepath, rotatedFile);
        } catch (error) {
            console.error('Failed to rotate log file:', error);
        }
    }

    async log(level, message, meta = {}) {
        if (!this.shouldLog(level)) return;

        const logEntry = this.formatMessage(level, message, meta);

        // Console output
        if (this.enableConsole) {
            const consoleMethod = level === 'error' ? 'error' : 
                                 level === 'warn' ? 'warn' : 'log';
            console[consoleMethod](logEntry.formatted);
        }

        // File output
        if (this.enableFile) {
            const filename = this.getLogFilename(level);
            await this.writeToFile(logEntry, filename);
        }

        return logEntry;
    }

    getLogFilename(level) {
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        
        if (level === 'error') {
            return `error-${date}.log`;
        } else if (level === 'warn') {
            return `warn-${date}.log`;
        } else {
            return `app-${date}.log`;
        }
    }

    // Convenience methods
    async error(message, meta = {}) {
        return await this.log('error', message, meta);
    }

    async warn(message, meta = {}) {
        return await this.log('warn', message, meta);
    }

    async info(message, meta = {}) {
        return await this.log('info', message, meta);
    }

    async debug(message, meta = {}) {
        return await this.log('debug', message, meta);
    }

    async trace(message, meta = {}) {
        return await this.log('trace', message, meta);
    }

    // Specialized logging methods for chatbot
    async logIncomingMessage(phoneNumber, message, messageId = null) {
        return await this.info('Incoming WhatsApp message', {
            phoneNumber,
            messageId,
            messagePreview: message.substring(0, 100),
            timestamp: new Date().toISOString()
        });
    }

    async logOutgoingMessage(phoneNumber, message, messageId = null) {
        return await this.info('Outgoing WhatsApp message', {
            phoneNumber,
            messageId,
            messagePreview: message.substring(0, 100),
            timestamp: new Date().toISOString()
        });
    }

    async logApiCall(apiName, method, endpoint, duration, statusCode, error = null) {
        const level = error ? 'error' : (statusCode >= 400 ? 'warn' : 'info');
        
        return await this.log(level, `${apiName} API call`, {
            method,
            endpoint,
            duration: `${duration}ms`,
            statusCode,
            error: error ? error.message : null,
            timestamp: new Date().toISOString()
        });
    }

    async logUserAction(phoneNumber, action, details = {}) {
        return await this.info('User action', {
            phoneNumber,
            action,
            ...details,
            timestamp: new Date().toISOString()
        });
    }

    async logAppointmentAction(phoneNumber, action, appointmentId, details = {}) {
        return await this.info('Appointment action', {
            phoneNumber,
            action,
            appointmentId,
            ...details,
            timestamp: new Date().toISOString()
        });
    }

    async logVerificationAttempt(phoneNumber, success, attempts, details = {}) {
        const level = success ? 'info' : 'warn';
        
        return await this.log(level, 'Patient verification attempt', {
            phoneNumber,
            success,
            attempts,
            ...details,
            timestamp: new Date().toISOString()
        });
    }

    async logSecurityEvent(eventType, details = {}) {
        return await this.warn('Security event', {
            eventType,
            ...details,
            timestamp: new Date().toISOString()
        });
    }

    async logPerformanceMetric(metric, value, unit = 'ms') {
        return await this.debug('Performance metric', {
            metric,
            value,
            unit,
            timestamp: new Date().toISOString()
        });
    }

    // Batch logging for high-frequency events
/*
    constructor(options = {}) {
        this.logLevel = options.logLevel || 'info';
        this.logDir = options.logDir || './logs';
        this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
        this.maxFiles = options.maxFiles || 5;
        this.enableConsole = options.enableConsole !== false;
        this.enableFile = options.enableFile !== false;
        this.batchSize = options.batchSize || 100;
        this.batchTimeout = options.batchTimeout || 5000; // 5 seconds
        
        this.levels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3,
            trace: 4
        };

        this.initialized = false;
        this.logQueue = [];
        this.batchTimer = null;
        
        this.init();
    }
*/

    async flushLogs() {
        if (this.logQueue.length === 0) return;

        const logsToFlush = [...this.logQueue];
        this.logQueue = [];

        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        // Group logs by filename
        const logsByFile = {};
        
        for (const logEntry of logsToFlush) {
            const filename = this.getLogFilename(logEntry.level);
            if (!logsByFile[filename]) {
                logsByFile[filename] = [];
            }
            logsByFile[filename].push(logEntry);
        }

        // Write to files
        for (const [filename, logs] of Object.entries(logsByFile)) {
            try {
                const logLines = logs.map(log => log.formatted + '\n').join('');
                const filepath = path.join(this.logDir, filename);
                
                // Check file size before writing
                try {
                    const stats = await fs.stat(filepath);
                    if (stats.size > this.maxFileSize) {
                        await this.rotateLogFile(filename);
                    }
                } catch (error) {
                    // File doesn't exist, which is fine
                }

                await fs.appendFile(filepath, logLines);
            } catch (error) {
                console.error(`Failed to flush logs to ${filename}:`, error);
            }
        }
    }

    async logBatch(level, message, meta = {}) {
        if (!this.shouldLog(level)) return;

        const logEntry = this.formatMessage(level, message, meta);
        logEntry.level = level; // Store original level for filename determination

        // Console output (immediate)
        if (this.enableConsole) {
            const consoleMethod = level === 'error' ? 'error' : 
                                 level === 'warn' ? 'warn' : 'log';
            console[consoleMethod](logEntry.formatted);
        }

        // Add to batch queue for file output
        if (this.enableFile) {
            this.logQueue.push(logEntry);

            // Flush if batch is full
            if (this.logQueue.length >= this.batchSize) {
                await this.flushLogs();
            } else if (!this.batchTimer) {
                // Set timer to flush logs
                this.batchTimer = setTimeout(() => {
                    this.flushLogs().catch(console.error);
                }, this.batchTimeout);
            }
        }

        return logEntry;
    }

    // Search logs (for debugging and analytics)
    async searchLogs(criteria = {}) {
        const { 
            level, 
            startDate, 
            endDate, 
            phoneNumber, 
            message, 
            limit = 100 
        } = criteria;

        const results = [];
        const logFiles = await this.getLogFiles();

        for (const file of logFiles) {
            try {
                const content = await fs.readFile(path.join(this.logDir, file), 'utf8');
                const lines = content.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        // Parse log line
                        const match = line.match(/\[(.*?)\] (.*?): (.*)/);
                        if (!match) continue;

                        const [, timestamp, logLevel, rest] = match;
                        const logDate = new Date(timestamp);

                        // Apply filters
                        if (level && logLevel.toLowerCase() !== level.toLowerCase()) continue;
                        if (startDate && logDate < new Date(startDate)) continue;
                        if (endDate && logDate > new Date(endDate)) continue;
                        if (phoneNumber && !line.includes(phoneNumber)) continue;
                        if (message && !rest.toLowerCase().includes(message.toLowerCase())) continue;

                        results.push({
                            timestamp: logDate,
                            level: logLevel.toLowerCase(),
                            message: rest,
                            file,
                            line
                        });

                        if (results.length >= limit) break;
                    } catch (parseError) {
                        // Skip malformed lines
                        continue;
                    }
                }

                if (results.length >= limit) break;
            } catch (error) {
                console.error(`Error reading log file ${file}:`, error);
            }
        }

        return results.sort((a, b) => b.timestamp - a.timestamp);
    }

    async getLogFiles() {
        try {
            const files = await fs.readdir(this.logDir);
            return files.filter(file => file.endsWith('.log'));
        } catch (error) {
            return [];
        }
    }

    async getLogStats() {
        const files = await this.getLogFiles();
        const stats = {
            totalFiles: files.length,
            totalSize: 0,
            fileDetails: []
        };

        for (const file of files) {
            try {
                const filepath = path.join(this.logDir, file);
                const stat = await fs.stat(filepath);
                
                stats.totalSize += stat.size;
                stats.fileDetails.push({
                    name: file,
                    size: stat.size,
                    modified: stat.mtime,
                    created: stat.birthtime
                });
            } catch (error) {
                console.error(`Error getting stats for ${file}:`, error);
            }
        }

        return stats;
    }

    // Cleanup old log files
    async cleanup(daysToKeep = 30) {
        const files = await this.getLogFiles();
        const cutoffDate = new Date(Date.now() - (daysToKeep * 24 * 60 * 60 * 1000));
        
        let deletedCount = 0;
        let deletedSize = 0;

        for (const file of files) {
            try {
                const filepath = path.join(this.logDir, file);
                const stat = await fs.stat(filepath);
                
                if (stat.mtime < cutoffDate) {
                    deletedSize += stat.size;
                    await fs.unlink(filepath);
                    deletedCount++;
                }
            } catch (error) {
                console.error(`Error cleaning up ${file}:`, error);
            }
        }

        return { deletedCount, deletedSize };
    }

    // Graceful shutdown
    async shutdown() {
        await this.flushLogs();
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
        }
    }
}

module.exports = Logger;
