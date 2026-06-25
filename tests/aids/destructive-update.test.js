/**
 * P0 Regression Tests — Destructive Aid Group Update
 *
 * - aid_update_failure_preserves_original_group
 */

describe('Aid Group Update — create-first ordering', () => {
  let aidService;
  let mockAidModel;
  let mockReminderService;

  beforeAll(() => {
    jest.mock('../../src/utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
  });

  beforeEach(() => {
    jest.resetModules();

    // Mock Aid model
    mockAidModel = {
      insertMany: jest.fn(),
      deleteMany: jest.fn(),
      find: jest.fn().mockReturnThis(),
      findOne: jest.fn().mockReturnThis(),
      aggregate: jest.fn().mockReturnThis(),
      exec: jest.fn(),
      exists: jest.fn(),
      distinct: jest.fn(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn(),
    };

    jest.mock('../../src/modules/aids/aid.model', () => mockAidModel);

    // Mock aidReminderService
    mockReminderService = {
      syncDueReminderForGroup: jest.fn().mockResolvedValue(undefined),
      deleteRemindersForGroup: jest.fn().mockResolvedValue(undefined),
    };

    jest.mock('../../src/modules/aids/aidReminder.service', () => mockReminderService);

    jest.mock('../../src/utils/ApiError', () => {
      const actual = jest.requireActual('../../src/utils/ApiError');
      return actual;
    });

    aidService = require('../../src/modules/aids/aid.service');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('aid_update_failure_preserves_original_group', () => {
    it('should insert new records BEFORE deleting originals', async () => {
      const insertedDocs = [{ _id: 'id1' }, { _id: 'id2' }];
      mockAidModel.insertMany.mockResolvedValue(insertedDocs);
      mockAidModel.deleteMany.mockResolvedValue({ deletedCount: 2 });

      const originalGroup = {
        date: '2026-01-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid',
      };
      const updatedData = {
        date: '2026-02-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid v2',
      };
      const houseNames = ['House A', 'House B'];

      await aidService.updateFullAidGroup(
        originalGroup, updatedData, houseNames, 'user123'
      );

      // Verify insertMany was called BEFORE deleteMany
      const insertCallOrder = mockAidModel.insertMany.mock.invocationCallOrder[0];
      const deleteCallOrder = mockAidModel.deleteMany.mock.invocationCallOrder[0];

      expect(insertCallOrder).toBeLessThan(deleteCallOrder);
    });

    it('should NOT delete original records when insertion fails', async () => {
      const insertError = new Error('Insert failed');
      mockAidModel.insertMany.mockRejectedValue(insertError);

      const originalGroup = {
        date: '2026-01-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid',
      };
      const updatedData = {
        date: '2026-02-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid v2',
      };
      const houseNames = ['House A', 'House B'];

      await expect(
        aidService.updateFullAidGroup(
          originalGroup, updatedData, houseNames, 'user123'
        )
      ).rejects.toThrow('Insert failed');

      // deleteMany must NEVER have been called
      expect(mockAidModel.deleteMany).not.toHaveBeenCalled();
      expect(mockReminderService.deleteRemindersForGroup).not.toHaveBeenCalled();
    });

    it('should clean up new records if deletion fails (compensating action)', async () => {
      const insertedDocs = [{ _id: 'id1' }, { _id: 'id2' }];
      mockAidModel.insertMany.mockResolvedValue(insertedDocs);
      mockAidModel.deleteMany.mockRejectedValue(new Error('Deletion failed'));

      const originalGroup = {
        date: '2026-01-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid',
      };
      const updatedData = {
        date: '2026-02-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid v2',
      };
      const houseNames = ['House A', 'House B'];

      await expect(
        aidService.updateFullAidGroup(
          originalGroup, updatedData, houseNames, 'user123'
        )
      ).rejects.toThrow('Deletion failed');

      // Should clean up the newly inserted records
      expect(mockAidModel.deleteMany).toHaveBeenCalledTimes(2);
      // First call: try to delete originals
      // Second call: cleanup inserted records
      const cleanupCallArgs = mockAidModel.deleteMany.mock.calls[1][0];
      expect(cleanupCallArgs).toHaveProperty('_id');
      expect(cleanupCallArgs._id.$in).toEqual(['id1', 'id2']);
    });

    it('should complete successfully when both insert and delete succeed', async () => {
      const insertedDocs = [{ _id: 'id1' }, { _id: 'id2' }];
      mockAidModel.insertMany.mockResolvedValue(insertedDocs);
      mockAidModel.deleteMany.mockResolvedValue({ deletedCount: 2 });

      const originalGroup = {
        date: '2026-01-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid',
      };
      const updatedData = {
        date: '2026-02-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid v2',
      };
      const houseNames = ['House A', 'House B'];

      const result = await aidService.updateFullAidGroup(
        originalGroup, updatedData, houseNames, 'user123'
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      // Reminder sync should be called
      expect(mockReminderService.syncDueReminderForGroup).toHaveBeenCalled();
    });

    it('should handle empty houseNames gracefully', async () => {
      const originalGroup = {
        date: '2026-01-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid',
      };
      const updatedData = {
        date: '2026-02-15',
        category: 'Food',
        occurrence: 'monthly',
        description: 'Monthly food aid v2',
      };
      const houseNames = [];

      const result = await aidService.updateFullAidGroup(
        originalGroup, updatedData, houseNames, 'user123'
      );

      expect(result).toEqual([]);
      expect(mockAidModel.insertMany).not.toHaveBeenCalled();
      expect(mockAidModel.deleteMany).not.toHaveBeenCalled();
    });
  });
});
