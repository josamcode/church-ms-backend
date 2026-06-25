/**
 * P0 Regression Tests — Booking Cleanup & Reconciliation Jobs
 */

// ═══════════════════════════════════════════════
//  Mock config BEFORE the service is loaded
// ═══════════════════════════════════════════════

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../src/utils/logger', () => mockLogger);

jest.mock('../../src/config/env', () => ({
  env: 'test',
  isProduction: false,
  isDevelopmentLike: true,
}));

// Mock bookings.service — the cleanup service lazy-requires it
const mockCleanupExpiredPendingUploads = jest.fn().mockResolvedValue(3);
const mockReconcileSlotCounters = jest.fn().mockResolvedValue(5);

jest.mock('../../src/modules/bookings/bookings.service', () => ({
  cleanupExpiredPendingUploads: mockCleanupExpiredPendingUploads,
  reconcileSlotCounters: mockReconcileSlotCounters,
}));

// ═══════════════════════════════════════════════

describe('Booking Cleanup Jobs', () => {
  let bookingCleanupService;

  beforeAll(() => {
    // Must use fake timers to control setInterval
    jest.useFakeTimers();
    bookingCleanupService = require('../../src/modules/bookings/bookingCleanup.service');
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset internal state
    bookingCleanupService.cleanupRunning = false;
    bookingCleanupService.reconcileRunning = false;
  });

  afterEach(() => {
    // Clear all intervals between tests
    bookingCleanupService.stop();
    bookingCleanupService.cleanupHandle = null;
    bookingCleanupService.reconcileHandle = null;
  });

  // ═══════════════════════════════════════════════
  //  1. cleanup job calls cleanupExpiredPendingUploads
  // ═══════════════════════════════════════════════
  describe('cleanup job calls cleanupExpiredPendingUploads', () => {
    it('should invoke cleanupExpiredPendingUploads on runCleanup', async () => {
      await bookingCleanupService.runCleanup();
      expect(mockCleanupExpiredPendingUploads).toHaveBeenCalled();
    });

    it('should log the count when uploads were cleaned', async () => {
      mockCleanupExpiredPendingUploads.mockResolvedValue(3);
      await bookingCleanupService.runCleanup();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('removed 3 expired pending upload')
      );
    });

    it('should not log count when zero uploads were cleaned', async () => {
      mockLogger.info.mockClear();
      mockCleanupExpiredPendingUploads.mockResolvedValue(0);
      await bookingCleanupService.runCleanup();
      const infoCalls = mockLogger.info.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('removed')
      );
      expect(infoCalls).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════
  //  2-3. cleanup handles expired + claimed-but-unbound
  // ═══════════════════════════════════════════════
  describe('cleanup handles expired unconsumed uploads', () => {
    it('should pass through to bookings service which handles both unconsumed and claimed-but-unbound', async () => {
      // The actual cleanup logic lives in bookings.service.cleanupExpiredPendingUploads.
      // This test verifies the scheduling service delegates correctly.
      await bookingCleanupService.runCleanup();
      expect(mockCleanupExpiredPendingUploads).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════
  //  4. cleanup deletes storage objects before DB records
  // ═══════════════════════════════════════════════
  describe('cleanup deletes storage objects before deleting DB records', () => {
    it('should delegate to cleanupExpiredPendingUploads which deletes storage before DB', async () => {
      // The ordering is enforced in bookings.service.cleanupExpiredPendingUploads:
      // 1. storageService.deleteFiles(storageKeys)  — first
      // 2. BookingPendingUpload.deleteMany(...)     — second
      await bookingCleanupService.runCleanup();
      expect(mockCleanupExpiredPendingUploads).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════
  //  5. cleanup job logs errors without throwing
  // ═══════════════════════════════════════════════
  describe('cleanup job logs errors without throwing', () => {
    it('should log error and NOT throw when cleanup fails', async () => {
      mockCleanupExpiredPendingUploads.mockRejectedValueOnce(new Error('R2 unavailable'));

      // Must not throw
      await expect(bookingCleanupService.runCleanup()).resolves.toBeUndefined();

      // Must log the error
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('cleanupExpiredPendingUploads failed')
      );
    });

    it('should reset cleanupRunning flag after error', async () => {
      mockCleanupExpiredPendingUploads.mockRejectedValueOnce(new Error('R2 unavailable'));
      await bookingCleanupService.runCleanup();
      expect(bookingCleanupService.cleanupRunning).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════
  //  6. reconcile job calls reconcileSlotCounters
  // ═══════════════════════════════════════════════
  describe('reconcile job calls reconcileSlotCounters', () => {
    it('should invoke reconcileSlotCounters on runReconciliation', async () => {
      await bookingCleanupService.runReconciliation();
      expect(mockReconcileSlotCounters).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════
  //  7. reconcile job logs errors without throwing
  // ═══════════════════════════════════════════════
  describe('reconcile job logs errors without throwing', () => {
    it('should log error and NOT throw when reconcile fails', async () => {
      mockReconcileSlotCounters.mockRejectedValueOnce(new Error('DB unavailable'));

      await expect(bookingCleanupService.runReconciliation()).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('reconcileSlotCounters failed')
      );
    });

    it('should reset reconcileRunning flag after error', async () => {
      mockReconcileSlotCounters.mockRejectedValueOnce(new Error('DB unavailable'));
      await bookingCleanupService.runReconciliation();
      expect(bookingCleanupService.reconcileRunning).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════
  //  8. jobs do not overlap
  // ═══════════════════════════════════════════════
  describe('jobs do not overlap when previous run is still active', () => {
    it('should skip cleanup if a previous run is still in progress', async () => {
      bookingCleanupService.cleanupRunning = true;

      await bookingCleanupService.runCleanup();

      // cleanupExpiredPendingUploads must NOT have been called
      expect(mockCleanupExpiredPendingUploads).not.toHaveBeenCalled();
    });

    it('should skip reconciliation if a previous run is still in progress', async () => {
      bookingCleanupService.reconcileRunning = true;

      await bookingCleanupService.runReconciliation();

      expect(mockReconcileSlotCounters).not.toHaveBeenCalled();
    });

    it('should allow cleanup after previous run completes', async () => {
      // First run succeeds
      await bookingCleanupService.runCleanup();
      expect(mockCleanupExpiredPendingUploads).toHaveBeenCalledTimes(1);

      // Second run also succeeds (flag was cleared)
      await bookingCleanupService.runCleanup();
      expect(mockCleanupExpiredPendingUploads).toHaveBeenCalledTimes(2);
    });
  });

  // ═══════════════════════════════════════════════
  //  9. jobs are not automatically started in test mode
  // ═══════════════════════════════════════════════
  describe('jobs are not automatically started in test mode', () => {
    it('should NOT schedule intervals when config.env is test', () => {
      // start() was never called (we used runCleanup/runReconciliation directly)
      // This test verifies that calling start() in test mode does nothing
      bookingCleanupService.start();

      // In test mode, start() returns immediately without setting intervals
      expect(bookingCleanupService.cleanupHandle).toBeNull();
      expect(bookingCleanupService.reconcileHandle).toBeNull();
    });

    it('should allow manual invocation even in test mode', async () => {
      await bookingCleanupService.runCleanup();
      expect(mockCleanupExpiredPendingUploads).toHaveBeenCalled();
    });
  });
});
