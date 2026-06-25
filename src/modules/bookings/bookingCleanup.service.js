/**
 * Scheduled cleanup and reconciliation jobs for the bookings module.
 *
 * - cleanupExpiredPendingUploads(): delete abandoned public-upload storage
 *   objects, then remove the DB records.  Runs every 15 minutes.
 *
 * - reconcileSlotCounters(): rebuild slot-capacity counters from the
 *   Booking collection so any drift is automatically repaired.  Runs
 *   every 6 hours.
 *
 * Follows the same pattern used by aidReminder, meetingReminder, and
 * backup services: config.env guard, setInterval, start/stop, overlap
 * prevention, error-logging without crashing.
 */

const config = require('../../config/env');
const logger = require('../../utils/logger');

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;       // 15 minutes
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours

class BookingCleanupService {
  constructor() {
    this.cleanupHandle = null;
    this.reconcileHandle = null;
    this.cleanupRunning = false;
    this.reconcileRunning = false;
  }

  // ── Cleanup: expired pending uploads ──

  async runCleanup() {
    if (this.cleanupRunning) return; // overlap prevention
    this.cleanupRunning = true;

    try {
      // Lazy-require to avoid circular dependency at module load time
      const bookingsService = require('./bookings.service');
      const count = await bookingsService.cleanupExpiredPendingUploads();
      if (count > 0) {
        logger.info(`BookingCleanup: removed ${count} expired pending upload(s)`);
      }
    } catch (err) {
      logger.error(`BookingCleanup: cleanupExpiredPendingUploads failed: ${err.message}`);
    } finally {
      this.cleanupRunning = false;
    }
  }

  // ── Reconciliation: slot counters ──

  async runReconciliation() {
    if (this.reconcileRunning) return;
    this.reconcileRunning = true;

    try {
      const bookingsService = require('./bookings.service');
      const count = await bookingsService.reconcileSlotCounters();
      if (count > 0) {
        logger.info(`BookingCleanup: reconciled ${count} slot counter(s)`);
      }
    } catch (err) {
      logger.error(`BookingCleanup: reconcileSlotCounters failed: ${err.message}`);
    } finally {
      this.reconcileRunning = false;
    }
  }

  // ── Lifecycle ──

  start() {
    if (config.env === 'test') return;

    // Cleanup
    if (!this.cleanupHandle) {
      // Run once at startup, then on interval
      this.runCleanup();
      this.cleanupHandle = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);
      logger.info('BookingCleanup: pending-upload cleanup scheduled every 15 min');
    }

    // Reconciliation
    if (!this.reconcileHandle) {
      // Run once at startup, then on interval
      this.runReconciliation();
      this.reconcileHandle = setInterval(() => this.runReconciliation(), RECONCILE_INTERVAL_MS);
      logger.info('BookingCleanup: slot-counter reconciliation scheduled every 6 hours');
    }
  }

  stop() {
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }
    if (this.reconcileHandle) {
      clearInterval(this.reconcileHandle);
      this.reconcileHandle = null;
    }
    logger.info('BookingCleanup: all jobs stopped');
  }
}

module.exports = new BookingCleanupService();
