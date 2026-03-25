const http = require('http');
const config = require('./config/env');
const connectDB = require('./config/db');
const redisClient = require('./config/redis');
const logger = require('./utils/logger');
const aidReminderService = require('./modules/aids/aidReminder.service');
const meetingReminderService = require('./modules/meetings/meetingReminder.service');
const backupService = require('./modules/backups/backup.service');
const { initializeChatSocketServer } = require('./modules/chats/socket/chat.socket');

const startServer = async () => {
  try {
    await connectDB();
    await redisClient.ensureRedisReady();
    const app = require('./app');

    const httpServer = http.createServer(app);
    initializeChatSocketServer(httpServer);

    const server = httpServer.listen(config.port, '0.0.0.0', () => {
      logger.info(`Server listening on port ${config.port} in ${config.env}`);
      if (config.docs.enabled) {
        logger.info(`API docs available at http://localhost:${config.port}/api/docs`);
      }
    });
    aidReminderService.start();
    meetingReminderService.start();
    backupService.start();

    const gracefulShutdown = (signal) => {
      logger.info(`Received ${signal}. Shutting down server...`);
      aidReminderService.stop();
      meetingReminderService.stop();
      backupService.stop();
      server.close(() => {
        logger.info('Server closed successfully');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (err) => {
      logger.error(`Unhandled Rejection: ${err.message}`);
      logger.error(err.stack);
      gracefulShutdown('unhandledRejection');
    });

    process.on('uncaughtException', (err) => {
      logger.error(`Uncaught Exception: ${err.message}`);
      logger.error(err.stack);
      gracefulShutdown('uncaughtException');
    });
  } catch (error) {
    logger.error(`Server startup failed: ${error.message}`);
    process.exit(1);
  }
};

startServer();
