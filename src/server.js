const app = require('./app');
const config = require('./config/env');
const connectDB = require('./config/db');
const logger = require('./utils/logger');

const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();

    const server = app.listen(config.port, '0.0.0.0', () => {
      logger.info(`الخادم يعمل على المنفذ ${config.port} في بيئة ${config.env}`);
      logger.info(`التوثيق متاح على http://localhost:${config.port}/api/docs`);
    });

    // Graceful shutdown
    const gracefulShutdown = (signal) => {
      logger.info(`استلام إشارة ${signal}. إيقاف الخادم...`);
      server.close(() => {
        logger.info('تم إغلاق الخادم بنجاح');
        process.exit(0);
      });

      // Force shutdown after 10s
      setTimeout(() => {
        logger.error('لم يتم إغلاق الخادم بشكل طبيعي، إغلاق قسري');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (err) => {
      logger.error(`خطأ غير معالج (Unhandled Rejection): ${err.message}`);
      logger.error(err.stack);
      gracefulShutdown('unhandledRejection');
    });

    process.on('uncaughtException', (err) => {
      logger.error(`خطأ غير ملتقط (Uncaught Exception): ${err.message}`);
      logger.error(err.stack);
      gracefulShutdown('uncaughtException');
    });
  } catch (error) {
    logger.error(`فشل تشغيل الخادم: ${error.message}`);
    process.exit(1);
  }
};

startServer();
