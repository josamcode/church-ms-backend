const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const cron = require('node-cron');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const BackupJob = require('./backupJob.model');
const backupNotificationService = require('./backupNotification.service');
const googleDriveService = require('./googleDrive.service');

const BACKUP_JOB_NAME = 'mongo-drive-backup';

class BackupService {
  constructor() {
    this.cronTask = null;
  }

  async _ensureStateDocument() {
    try {
      await BackupJob.updateOne(
        { jobName: BACKUP_JOB_NAME },
        { $setOnInsert: { jobName: BACKUP_JOB_NAME } },
        { upsert: true }
      );
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }
    }
  }

  async _getState() {
    await this._ensureStateDocument();
    return BackupJob.findOne({ jobName: BACKUP_JOB_NAME });
  }

  _isDue(lastSuccessAt) {
    if (!lastSuccessAt) return true;
    return Date.now() - new Date(lastSuccessAt).getTime() >= config.backup.intervalMs;
  }

  _nextEligibleAt(lastSuccessAt) {
    if (!lastSuccessAt) return null;
    return new Date(new Date(lastSuccessAt).getTime() + config.backup.intervalMs);
  }

  async _acquireLock(trigger) {
    await this._ensureStateDocument();

    const now = new Date();
    const runId = randomUUID();
    const lockExpiresAt = new Date(now.getTime() + config.backup.lockTimeoutMs);

    const state = await BackupJob.findOneAndUpdate(
      {
        jobName: BACKUP_JOB_NAME,
        $or: [
          { running: { $ne: true } },
          { lockExpiresAt: null },
          { lockExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          running: true,
          currentRunId: runId,
          lockAcquiredAt: now,
          lockExpiresAt,
          lastRunStartedAt: now,
          lastStatus: 'running',
          lastTrigger: trigger,
          lastError: '',
        },
      },
      { new: true }
    );

    if (!state) {
      return null;
    }

    return { state, runId };
  }

  async _releaseLock(runId, updates = {}) {
    await BackupJob.updateOne(
      {
        jobName: BACKUP_JOB_NAME,
        currentRunId: runId,
      },
      {
        $set: {
          running: false,
          currentRunId: '',
          lockAcquiredAt: null,
          lockExpiresAt: null,
          ...updates,
        },
      }
    );
  }

  async _markRunSuccess({ runId, trigger, fileName, sizeBytes, upload }) {
    const completedAt = new Date();

    await this._releaseLock(runId, {
      lastRunCompletedAt: completedAt,
      lastSuccessAt: completedAt,
      lastStatus: 'success',
      lastTrigger: trigger,
      lastError: '',
      lastBackupFilename: fileName,
      lastBackupSizeBytes: sizeBytes,
      lastUploadedFileId: upload.id,
      lastUploadedFileLink: upload.webViewLink,
      lastCleanupError: '',
    });
  }

  async _markRunFailure({ runId, trigger, errorMessage, fileName }) {
    const completedAt = new Date();

    await this._releaseLock(runId, {
      lastRunCompletedAt: completedAt,
      lastFailureAt: completedAt,
      lastStatus: 'failed',
      lastTrigger: trigger,
      lastError: errorMessage,
      lastBackupFilename: fileName || '',
    });
  }

  async _markCleanupResult({ cleanupError }) {
    await BackupJob.updateOne(
      { jobName: BACKUP_JOB_NAME },
      {
        $set: {
          lastCleanupAt: new Date(),
          lastCleanupError: cleanupError || '',
        },
      }
    );
  }

  _buildFileName(date) {
    const timestamp = date.toISOString().replace(/:/g, '-').replace(/\./g, '-');
    return `${config.backup.filePrefix}-${timestamp}.archive.gz`;
  }

  _truncate(value, maxLength = 4000) {
    const normalized = String(value || '').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength)}...`;
  }

  _sanitizeText(value) {
    let sanitized = String(value || '').trim();

    if (config.mongo.uri) {
      sanitized = sanitized.split(config.mongo.uri).join('[REDACTED_MONGO_URI]');
    }

    return this._truncate(sanitized || 'Unknown error');
  }

  _sanitizeError(error, stage = 'unknown') {
    const baseError = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
    const sanitizedError = new Error(this._sanitizeText(baseError.message));

    sanitizedError.stage = baseError.stage || stage;
    if (baseError.stack) {
      sanitizedError.stack = this._sanitizeText(baseError.stack);
    }

    return sanitizedError;
  }

  _withStage(error, stage) {
    const baseError = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
    baseError.stage = baseError.stage || stage;
    return baseError;
  }

  async _sendSuccessNotification({
    runId,
    trigger,
    fileName,
    sizeBytes,
    driveFileId,
    driveLink,
    cleanupWarning = '',
  }) {
    if (!backupNotificationService.isEnabled()) {
      return;
    }

    try {
      await backupNotificationService.sendSuccess({
        runId,
        trigger,
        fileName,
        sizeBytes,
        driveFileId,
        driveLink,
        completedAt: new Date(),
        cleanupWarning,
      });

      logger.info('MongoDB backup success email notification sent', {
        runId,
        trigger,
        recipients: config.backup.notifications.recipients,
      });
    } catch (error) {
      logger.error('MongoDB backup success email notification failed', {
        runId,
        trigger,
        reason: this._sanitizeText(error.message),
      });
    }
  }

  async _sendFailureNotification({
    runId,
    trigger,
    stage,
    reason,
    fileName = '',
    localFilePath = '',
  }) {
    if (!backupNotificationService.isEnabled()) {
      return;
    }

    try {
      await backupNotificationService.sendFailure({
        runId,
        trigger,
        stage,
        reason,
        fileName,
        localFilePath,
        occurredAt: new Date(),
      });

      logger.info('MongoDB backup failure email notification sent', {
        runId,
        trigger,
        recipients: config.backup.notifications.recipients,
      });
    } catch (error) {
      logger.error('MongoDB backup failure email notification failed', {
        runId,
        trigger,
        reason: this._sanitizeText(error.message),
      });
    }
  }

  async _ensureTempDir() {
    await fs.mkdir(config.backup.tempDir, { recursive: true });
  }

  async _createArchive(archivePath) {
    return new Promise((resolve, reject) => {
      const args = ['--uri', config.mongo.uri, `--archive=${archivePath}`, '--gzip'];
      const childProcess = spawn(config.backup.mongodumpPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      childProcess.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      childProcess.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      childProcess.on('error', (error) => {
        if (error?.code === 'ENOENT') {
          reject(
            new Error(
              `mongodump was not found. Install MongoDB Database Tools or set BACKUP_MONGODUMP_PATH.`
            )
          );
          return;
        }

        reject(error);
      });

      childProcess.on('close', (code) => {
        if (code === 0) {
          resolve({
            stdout: this._truncate(stdout),
            stderr: this._truncate(stderr),
          });
          return;
        }

        reject(
          new Error(
            this._truncate(stderr || stdout || `mongodump exited with code ${code || 'unknown'}.`)
          )
        );
      });
    });
  }

  async _deleteLocalFile(filePath) {
    try {
      await fs.unlink(filePath);
      return { deleted: true };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { deleted: true };
      }

      throw error;
    }
  }

  async _cleanupExpiredLocalBackups({ runId, skipFilePath = '' } = {}) {
    if (config.backup.localRetentionMs < 0) {
      return;
    }

    let entries = [];
    try {
      entries = await fs.readdir(config.backup.tempDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }

      throw error;
    }

    const threshold = Date.now() - config.backup.localRetentionMs;
    let deletedCount = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const filePath = path.join(config.backup.tempDir, entry.name);
      if (skipFilePath && path.resolve(filePath) === path.resolve(skipFilePath)) {
        continue;
      }

      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          continue;
        }

        throw error;
      }

      if (stats.mtimeMs > threshold) {
        continue;
      }

      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          continue;
        }

        throw error;
      }

      deletedCount += 1;
    }

    if (deletedCount > 0) {
      logger.info('MongoDB backup retention cleanup completed successfully', {
        runId,
        deletedCount,
        tempDir: config.backup.tempDir,
        retentionDays: config.backup.localRetentionDays,
      });
    }
  }

  async runBackup({ trigger = 'manual', force = false } = {}) {
    if (!config.backup.enabled) {
      throw new Error(
        'MongoDB backups are disabled. Set BACKUP_ENABLED=true after configuring the backup environment variables.'
      );
    }

    const state = await this._getState();
    const lastSuccessAt = state?.lastSuccessAt || null;

    if (!force && !this._isDue(lastSuccessAt)) {
      const nextEligibleAt = this._nextEligibleAt(lastSuccessAt);
      logger.info('MongoDB backup skipped because it is not due yet', {
        trigger,
        lastSuccessAt: lastSuccessAt?.toISOString?.() || null,
        nextEligibleAt: nextEligibleAt?.toISOString?.() || null,
      });

      return {
        status: 'skipped',
        reason: 'not-due',
        lastSuccessAt,
        nextEligibleAt,
      };
    }

    const lock = await this._acquireLock(trigger);
    if (!lock) {
      logger.warn('MongoDB backup skipped because another backup is already running', {
        trigger,
      });

      return {
        status: 'skipped',
        reason: 'already-running',
      };
    }

    const { state: lockedState, runId } = lock;
    let localFilePath = '';
    let fileName = '';
    let cleanupWarning = '';

    try {
      if (!force && !this._isDue(lockedState.lastSuccessAt)) {
        await this._releaseLock(runId, {
          lastStatus: lockedState.lastSuccessAt ? 'success' : 'idle',
          lastRunCompletedAt: new Date(),
        });

        return {
          status: 'skipped',
          reason: 'not-due-after-lock',
          lastSuccessAt: lockedState.lastSuccessAt || null,
          nextEligibleAt: this._nextEligibleAt(lockedState.lastSuccessAt),
        };
      }

      await this._ensureTempDir();
      await this._cleanupExpiredLocalBackups({ runId });

      const startedAt = new Date();
      fileName = this._buildFileName(startedAt);
      localFilePath = path.join(config.backup.tempDir, fileName);

      logger.info('MongoDB backup started', {
        runId,
        trigger,
        fileName,
        tempDir: config.backup.tempDir,
      });

      try {
        await this._createArchive(localFilePath);
      } catch (error) {
        throw this._withStage(error, 'dump');
      }

      let fileStats;
      try {
        fileStats = await fs.stat(localFilePath);
      } catch (error) {
        throw this._withStage(error, 'dump');
      }
      logger.info('MongoDB backup created successfully', {
        runId,
        trigger,
        fileName,
        sizeBytes: fileStats.size,
      });

      let upload;
      try {
        upload = await googleDriveService.uploadBackup({
          fileName,
          filePath: localFilePath,
        });
      } catch (error) {
        throw this._withStage(error, 'upload');
      }

      logger.info('MongoDB backup upload completed successfully', {
        runId,
        trigger,
        fileName,
        driveFileId: upload.id,
        driveLink: upload.webViewLink,
        driveFolderId: config.backup.googleDrive.folderId,
      });

      await this._markRunSuccess({
        runId,
        trigger,
        fileName,
        sizeBytes: fileStats.size,
        upload,
      });

      try {
        await this._deleteLocalFile(localFilePath);
        await this._markCleanupResult({ cleanupError: '' });

        logger.info('MongoDB backup local cleanup completed successfully', {
          runId,
          trigger,
          fileName,
          filePath: localFilePath,
        });
      } catch (error) {
        const cleanupError = this._sanitizeError(error, 'cleanup');
        cleanupWarning = cleanupError.message;
        await this._markCleanupResult({ cleanupError: cleanupError.message });

        logger.error('MongoDB backup local cleanup failed', {
          runId,
          trigger,
          fileName,
          reason: cleanupError.message,
          filePath: localFilePath,
        });
      }

      try {
        await this._cleanupExpiredLocalBackups({
          runId,
          skipFilePath: localFilePath,
        });
      } catch (error) {
        logger.error('MongoDB backup retention cleanup failed after success', {
          runId,
          trigger,
          reason: this._sanitizeText(error.message),
        });
      }

      await this._sendSuccessNotification({
        runId,
        trigger,
        fileName,
        sizeBytes: fileStats.size,
        driveFileId: upload.id,
        driveLink: upload.webViewLink,
        cleanupWarning,
      });

      return {
        status: 'success',
        runId,
        fileName,
        driveFileId: upload.id,
        driveLink: upload.webViewLink,
        sizeBytes: fileStats.size,
      };
    } catch (error) {
      const sanitizedError = this._sanitizeError(error, error?.stage || 'unknown');

      await this._markRunFailure({
        runId,
        trigger,
        errorMessage: sanitizedError.message,
        fileName,
      });

      logger.error('MongoDB backup failed', {
        runId,
        trigger,
        stage: sanitizedError.stage,
        reason: sanitizedError.message,
        fileName: fileName || null,
        preservedLocalFile: Boolean(localFilePath),
      });

      if (localFilePath) {
        logger.warn('MongoDB backup local file kept for investigation after failure', {
          runId,
          trigger,
          filePath: localFilePath,
        });
      }

      try {
        await this._cleanupExpiredLocalBackups({
          runId,
          skipFilePath: localFilePath,
        });
      } catch (cleanupError) {
        logger.error('MongoDB backup retention cleanup failed after backup error', {
          runId,
          trigger,
          reason: this._sanitizeText(cleanupError.message),
        });
      }

      await this._sendFailureNotification({
        runId,
        trigger,
        stage: sanitizedError.stage,
        reason: sanitizedError.message,
        fileName,
        localFilePath,
      });

      throw sanitizedError;
    }
  }

  async runScheduledCheck(trigger = 'scheduled') {
    try {
      return await this.runBackup({ trigger, force: false });
    } catch (error) {
      const sanitizedError = this._sanitizeError(error, error?.stage || 'unknown');

      logger.error('Scheduled MongoDB backup run failed', {
        trigger,
        stage: sanitizedError.stage,
        reason: sanitizedError.message,
      });

      return {
        status: 'failed',
        reason: sanitizedError.message,
      };
    }
  }

  async runManualBackup(trigger = 'manual-script') {
    return this.runBackup({ trigger, force: true });
  }

  start() {
    if (config.env === 'test' || !config.backup.enabled || !config.backup.schedulerEnabled) {
      return;
    }

    if (this.cronTask) {
      return;
    }

    logger.info('MongoDB backup scheduler started', {
      cron: config.backup.cron,
      timezone: config.backup.timezone,
      intervalDays: config.backup.intervalDays,
      tempDir: config.backup.tempDir,
    });

    this.cronTask = cron.schedule(
      config.backup.cron,
      () => {
        this.runScheduledCheck('scheduled-cron');
      },
      {
        timezone: config.backup.timezone,
      }
    );

    this.runScheduledCheck('startup-check');
  }

  stop() {
    if (!this.cronTask) {
      return;
    }

    this.cronTask.stop();
    if (typeof this.cronTask.destroy === 'function') {
      this.cronTask.destroy();
    }

    this.cronTask = null;
    logger.info('MongoDB backup scheduler stopped');
  }
}

module.exports = new BackupService();
