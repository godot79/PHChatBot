/**
 * webhook.js
 * WhatsApp Webhook Route Handler
 * Handles incoming WhatsApp messages and webhook verification
 */

const express = require('express');
const { ChatbotEngine } = require('../ChatbotEngine');
const { SecurityMiddleware } = require('../middleware/SecurityMiddleware');
const { ValidationMiddleware } = require('../middleware/ValidationMiddleware');
const { Logger } = require('../Logger');

class WebhookHandler {
    constructor(config = {}) {
        this.logger = new Logger('WebhookHandler');
        this.router = express.Router();
        this.config = {
            verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
            processTimeout: config.processTimeout || 15000, // 15 seconds
            ...config
        };

        // Initialize dependencies
        this.chatbotEngine = new ChatbotEngine();
        this.security = new SecurityMiddleware();
        this.validation = new ValidationMiddleware();

        // Initialize routes
        this.initializeRoutes();
        
        this.logger.info('WebhookHandler initialized');
    }

    /**
     * Initialize webhook routes with security and validation
     */
    initializeRoutes() {
        // Webhook verification endpoint (GET)
        this.router.get('/', 
            this.security.getRateLimiter('webhook'),
            this.handleWebhookVerification.bind(this)
        );

        // Webhook message endpoint (POST)
        this.router.post('/', 
            ...this.security.getWebhookMiddleware(),
            this.validation.validateWebhookPayload.bind(this.validation),
            this.handleIncomingMessage.bind(this)
        );

        // Health check endpoint
        this.router.get('/health', 
            this.security.getRateLimiter('default'),
            this.handleHealthCheck.bind(this)
        );
    }

    /**
     * Handle webhook verification challenge from WhatsApp
     */
    async handleWebhookVerification(req, res) {
        try {
            const mode = req.query['hub.mode'];
            const token = req.query['hub.verify_token'];
            const challenge = req.query['hub.challenge'];

            this.logger.info('Webhook verification request received', {
                mode,
                token: token ? `${token.substring(0, 8)}...` : 'missing'
            });

            // Verify the mode and token
            if (mode === 'subscribe' && token === this.config.verifyToken) {
                this.logger.info('Webhook verification successful');
                
                // Respond with the challenge token from the request
                res.status(200).send(challenge);
            } else {
                this.logger.warn('Webhook verification failed', {
                    mode,
                    tokenMatch: token === this.config.verifyToken,
                    expectedToken: this.config.verifyToken ? 'configured' : 'missing'
                });
                
                res.status(403).json({
                    error: 'Verification failed',
                    code: 'WEBHOOK_VERIFICATION_FAILED'
                });
            }

        } catch (error) {
            this.logger.error('Webhook verification error', error);
            res.status(500).json({
                error: 'Verification error',
                code: 'WEBHOOK_VERIFICATION_ERROR'
            });
        }
    }

    /**
     * Handle incoming WhatsApp messages
     */
    async handleIncomingMessage(req, res) {
        const startTime = Date.now();
        
        try {
            // Quick acknowledgment to WhatsApp (they expect 200 within 20 seconds)
            res.status(200).json({ status: 'received' });

            // Get validated messages from validation middleware
            const messages = req.validatedMessages || [];
            
            if (messages.length === 0) {
                this.logger.warn('No valid messages found in webhook payload');
                return;
            }

            this.logger.info(`Processing ${messages.length} messages`);

            // Process messages with timeout protection
            const processingPromise = this.processMessages(messages);
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Processing timeout')), 
                          this.config.processTimeout);
            });

            await Promise.race([processingPromise, timeoutPromise]);

            const processingTime = Date.now() - startTime;
            this.logger.info('Messages processed successfully', {
                messageCount: messages.length,
                processingTime
            });

        } catch (error) {
            const processingTime = Date.now() - startTime;
            
            if (error.message === 'Processing timeout') {
                this.logger.error('Message processing timeout', {
                    processingTime,
                    timeout: this.config.processTimeout
                });
            } else {
                this.logger.error('Message processing error', {
                    error: error.message,
                    stack: error.stack,
                    processingTime
                });
            }
            
            // Note: We already sent 200 response, so we can't change it
            // WhatsApp will retry if needed
        }
    }

    /**
     * Process multiple messages
     */
    async processMessages(messages) {
        const processingPromises = messages.map(message => 
            this.processIndividualMessage(message).catch(error => {
                this.logger.error('Individual message processing failed', {
                    messageId: message.id,
                    from: message.from,
                    error: error.message
                });
                // Continue processing other messages even if one fails
                return { success: false, messageId: message.id, error: error.message };
            })
        );

        const results = await Promise.all(processingPromises);
        
        // Log summary
        const successful = results.filter(r => r && r.success !== false).length;
        const failed = results.length - successful;
        
        this.logger.info('Batch processing completed', {
            total: results.length,
            successful,
            failed
        });

        return results;
    }

    /**
     * Process individual WhatsApp message
     */
    async processIndividualMessage(message) {
        try {
            this.logger.debug('Processing message', {
                id: message.id,
                from: message.from,
                type: message.type,
                timestamp: message.timestamp
            });

            // Extract message content based on type
            const messageContent = this.extractMessageContent(message);
            
            if (!messageContent) {
                this.logger.warn('Could not extract message content', {
                    messageId: message.id,
                    type: message.type
                });
                return { success: false, reason: 'No extractable content' };
            }

            // Additional validation for message content
            if (!this.validation.validateMessageContent(messageContent.text)) {
                this.logger.warn('Message content validation failed', {
                    messageId: message.id,
                    from: message.from
                });
                
                // Send warning to user
                await this.sendWarningMessage(message.from, 
                    'Your message could not be processed. Please ensure it follows our guidelines.');
                
                return { success: false, reason: 'Content validation failed' };
            }

            // Process through chatbot engine
            const response = await this.chatbotEngine.processMessage(
                message.from,
                messageContent.text,
                messageContent.type,
                {
                    messageId: message.id,
                    timestamp: message.timestamp,
                    context: messageContent.context
                }
            );

            this.logger.debug('Message processed successfully', {
                messageId: message.id,
                from: message.from,
                responseType: response?.type || 'none'
            });

            return { 
                success: true, 
                messageId: message.id,
                responseType: response?.type 
            };

        } catch (error) {
            this.logger.error('Individual message processing error', {
                messageId: message.id,
                from: message.from,
                error: error.message,
                stack: error.stack
            });

            // Try to send error message to user
            try {
                await this.sendErrorMessage(message.from);
            } catch (sendError) {
                this.logger.error('Failed to send error message to user', sendError);
            }

            throw error;
        }
    }

    /**
     * Extract content from different message types
     */
    extractMessageContent(message) {
        switch (message.type) {
            case 'text':
                if (!message.text || !message.text.body) {
                    return null;
                }
                return {
                    text: message.text.body.trim(),
                    type: 'text',
                    context: {}
                };

            case 'interactive':
                if (message.interactive.button_reply) {
                    return {
                        text: message.interactive.button_reply.title || 
                              message.interactive.button_reply.id,
                        type: 'button',
                        context: {
                            buttonId: message.interactive.button_reply.id,
                            payload: message.interactive.button_reply.payload
                        }
                    };
                } else if (message.interactive.list_reply) {
                    return {
                        text: message.interactive.list_reply.title || 
                              message.interactive.list_reply.id,
                        type: 'list_selection',
                        context: {
                            listId: message.interactive.list_reply.id,
                            description: message.interactive.list_reply.description
                        }
                    };
                }
                return null;

            case 'button':
                if (!message.button) {
                    return null;
                }
                return {
                    text: message.button.text || message.button.payload,
                    type: 'quick_reply',
                    context: {
                        payload: message.button.payload
                    }
                };

            case 'location':
                if (!message.location) {
                    return null;
                }
                return {
                    text: `Location: ${message.location.latitude}, ${message.location.longitude}`,
                    type: 'location',
                    context: {
                        latitude: message.location.latitude,
                        longitude: message.location.longitude,
                        name: message.location.name,
                        address: message.location.address
                    }
                };

            case 'image':
            case 'document':
            case 'audio':
            case 'video':
                return {
                    text: `[${message.type.toUpperCase()}]`,
                    type: 'media',
                    context: {
                        mediaType: message.type,
                        mediaId: message[message.type]?.id,
                        caption: message[message.type]?.caption
                    }
                };

            default:
                this.logger.warn('Unsupported message type', {
                    type: message.type,
                    messageId: message.id
                });
                return {
                    text: '[UNSUPPORTED MESSAGE TYPE]',
                    type: 'unsupported',
                    context: { originalType: message.type }
                };
        }
    }

    /**
     * Send warning message to user
     */
    async sendWarningMessage(phoneNumber, warningText) {
        try {
            // This would integrate with WhatsAppAPI when implemented
            this.logger.info('Warning message needed', {
                to: phoneNumber,
                warning: warningText
            });
            
            // For now, just log the warning
            // TODO: Implement actual message sending via WhatsAppAPI
            
        } catch (error) {
            this.logger.error('Failed to send warning message', error);
        }
    }

    /**
     * Send error message to user
     */
    async sendErrorMessage(phoneNumber) {
        try {
            const errorMessage = "I'm sorry, I encountered an error processing your message. Please try again in a few moments.";
            
            this.logger.info('Error message needed', {
                to: phoneNumber,
                message: errorMessage
            });
            
            // TODO: Implement actual message sending via WhatsAppAPI
            
        } catch (error) {
            this.logger.error('Failed to send error message', error);
        }
    }

    /**
     * Handle health check requests
     */
    async handleHealthCheck(req, res) {
        try {
            const health = {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                webhook: {
                    configured: !!this.config.verifyToken,
                    security: 'enabled',
                    validation: 'enabled'
                },
                chatbot: await this.chatbotEngine.getHealthStatus()
            };

            res.status(200).json(health);

        } catch (error) {
            this.logger.error('Health check failed', error);
            res.status(503).json({
                status: 'unhealthy',
                error: 'Health check failed',
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Get webhook statistics
     */
    async getStatistics() {
        try {
            // This would typically pull from a metrics store
            return {
                totalMessages: 0, // TODO: Implement metrics tracking
                messagesLastHour: 0,
                averageProcessingTime: 0,
                errorRate: 0,
                activeUsers: 0
            };
        } catch (error) {
            this.logger.error('Failed to get statistics', error);
            return null;
        }
    }

    /**
     * Get the Express router
     */
    getRouter() {
        return this.router;
    }

    /**
     * Shutdown handler
     */
    async shutdown() {
        try {
            this.logger.info('Shutting down webhook handler');
            
            // Stop processing new messages
            // Clean up resources
            
            this.logger.info('Webhook handler shutdown completed');
            
        } catch (error) {
            this.logger.error('Error during webhook handler shutdown', error);
        }
    }
}

module.exports = { WebhookHandler };
