const mongoose = require('mongoose');
const config = require('./env');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(config.mongo.uri);
    logger.info(`قاعدة البيانات متصلة: ${conn.connection.host}`);
  } catch (error) {
    logger.error(`خطأ في الاتصال بقاعدة البيانات: ${error.message}`);
    process.exit(1);
  }

  mongoose.connection.on('error', (err) => {
    logger.error(`خطأ في اتصال قاعدة البيانات: ${err.message}`);
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('تم قطع الاتصال بقاعدة البيانات');
  });
};

module.exports = connectDB;
