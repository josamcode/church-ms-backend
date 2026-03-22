const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const backupService = require('../src/modules/backups/backup.service');
const logger = require('../src/utils/logger');

const runBackup = async () => {
  try {
    await connectDB();
    const result = await backupService.runManualBackup('manual-script');

    logger.info('Manual MongoDB backup run finished', result);
    process.exitCode = result.status === 'success' ? 0 : 1;
  } catch (error) {
    logger.error(`Manual MongoDB backup run failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    backupService.stop();

    try {
      await mongoose.connection.close();
    } catch (error) {
      logger.warn(`MongoDB connection close after backup script failed: ${error.message}`);
    }
  }
};

runBackup();
