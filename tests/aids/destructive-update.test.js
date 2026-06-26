/**
 * P0 Regression Tests - Destructive Aid Group Update
 */

describe('Aid Group Update - create-first ordering with id-scoped deletion', () => {
  let aidService;
  let mockAidModel;
  let mockReminderService;
  let aidStore;
  let nextId;
  let deleteFailureQueue;

  const originalGroup = {
    date: '2026-01-15',
    category: 'Food',
    occurrence: 'monthly',
    description: 'Monthly food aid',
  };

  const baseUpdatedData = {
    date: '2026-02-15',
    category: 'Food',
    occurrence: 'monthly',
    description: 'Monthly food aid v2',
  };

  const sameDimensionUpdatedData = {
    date: originalGroup.date,
    category: originalGroup.category,
    occurrence: originalGroup.occurrence,
    description: originalGroup.description,
    notes: 'Updated notes',
  };

  const makeAid = (overrides = {}) => ({
    _id: overrides._id || `aid-${nextId++}`,
    houseName: overrides.houseName || 'House A',
    category: overrides.category || originalGroup.category,
    occurrence: overrides.occurrence || originalGroup.occurrence,
    description: overrides.description || originalGroup.description,
    notes: overrides.notes || null,
    date: new Date(overrides.date || originalGroup.date),
    recordedBy: overrides.recordedBy || 'existing-user',
    recurrenceAnchorDate: new Date(overrides.recurrenceAnchorDate || overrides.date || originalGroup.date),
  });

  const sameDay = (left, right) => new Date(left).getTime() === new Date(right).getTime();

  const matchesOriginalGroup = (doc, query) => (
    sameDay(doc.date, query.date) &&
    doc.category === query.category &&
    doc.occurrence === query.occurrence &&
    doc.description === query.description
  );

  const findByIds = (ids) => aidStore.filter((doc) => ids.map(String).includes(String(doc._id)));

  beforeAll(() => {
    jest.mock('../../src/utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
  });

  beforeEach(() => {
    jest.resetModules();

    aidStore = [];
    nextId = 1;
    deleteFailureQueue = [];

    mockAidModel = {
      insertMany: jest.fn().mockImplementation(async (payloads) => {
        const inserted = payloads.map((payload) => makeAid({ ...payload, _id: `new-${nextId++}` }));
        aidStore.push(...inserted);
        return inserted;
      }),
      deleteMany: jest.fn().mockImplementation(async (query) => {
        const queuedFailure = deleteFailureQueue.shift();
        if (queuedFailure) throw queuedFailure;

        const ids = query?._id?.$in || [];
        const before = aidStore.length;
        aidStore = aidStore.filter((doc) => !ids.map(String).includes(String(doc._id)));
        return { deletedCount: before - aidStore.length };
      }),
      find: jest.fn().mockImplementation((query) => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(
          aidStore
            .filter((doc) => matchesOriginalGroup(doc, query))
            .map((doc) => ({ _id: doc._id }))
        ),
      })),
      findOne: jest.fn().mockReturnThis(),
      aggregate: jest.fn().mockReturnThis(),
      exec: jest.fn(),
      exists: jest.fn(),
      distinct: jest.fn(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn(),
    };

    jest.mock('../../src/modules/aids/aid.model', () => mockAidModel);

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

  it('aid_update_same_group_dimensions_does_not_delete_new_rows', async () => {
    const oldAid1 = makeAid({ _id: 'old-1', houseName: 'Old House A' });
    const oldAid2 = makeAid({ _id: 'old-2', houseName: 'Old House B' });
    aidStore.push(oldAid1, oldAid2);

    await aidService.updateFullAidGroup(
      originalGroup,
      sameDimensionUpdatedData,
      ['New House A', 'New House C'],
      'user123'
    );

    expect(findByIds(['old-1', 'old-2'])).toHaveLength(0);

    const newRows = aidStore.filter((doc) => String(doc._id).startsWith('new-'));
    expect(newRows).toHaveLength(2);
    expect(newRows.map((doc) => doc.houseName).sort()).toEqual(['New House A', 'New House C']);
    expect(newRows.every((doc) => matchesOriginalGroup(doc, {
      date: originalGroup.date,
      category: originalGroup.category,
      occurrence: originalGroup.occurrence,
      description: originalGroup.description,
    }))).toBe(true);

    expect(mockAidModel.deleteMany).toHaveBeenCalledWith({
      _id: { $in: ['old-1', 'old-2'] },
    });
    expect(mockAidModel.deleteMany).not.toHaveBeenCalledWith(expect.objectContaining({
      date: expect.any(Date),
      category: originalGroup.category,
      occurrence: originalGroup.occurrence,
      description: originalGroup.description,
    }));
  });

  it('aid_update_failure_preserves_original_group', async () => {
    const oldAid1 = makeAid({ _id: 'old-1', houseName: 'House A' });
    const oldAid2 = makeAid({ _id: 'old-2', houseName: 'House B' });
    aidStore.push(oldAid1, oldAid2);
    mockAidModel.insertMany.mockRejectedValueOnce(new Error('Insert failed'));

    await expect(
      aidService.updateFullAidGroup(
        originalGroup,
        baseUpdatedData,
        ['House A', 'House B'],
        'user123'
      )
    ).rejects.toThrow('Insert failed');

    expect(findByIds(['old-1', 'old-2'])).toHaveLength(2);
    expect(mockAidModel.deleteMany).not.toHaveBeenCalled();
    expect(mockReminderService.deleteRemindersForGroup).not.toHaveBeenCalled();
  });

  it('aid_update_delete_failure_cleans_up_inserted_rows', async () => {
    const oldAid1 = makeAid({ _id: 'old-1', houseName: 'House A' });
    const oldAid2 = makeAid({ _id: 'old-2', houseName: 'House B' });
    aidStore.push(oldAid1, oldAid2);
    deleteFailureQueue.push(new Error('Deletion failed'));

    await expect(
      aidService.updateFullAidGroup(
        originalGroup,
        baseUpdatedData,
        ['New House A', 'New House B'],
        'user123'
      )
    ).rejects.toThrow('Deletion failed');

    expect(findByIds(['old-1', 'old-2'])).toHaveLength(2);
    expect(aidStore.filter((doc) => String(doc._id).startsWith('new-'))).toHaveLength(0);
    expect(mockAidModel.deleteMany).toHaveBeenCalledTimes(2);
    expect(mockAidModel.deleteMany.mock.calls[0][0]).toEqual({
      _id: { $in: ['old-1', 'old-2'] },
    });
    const cleanupIds = mockAidModel.deleteMany.mock.calls[1][0]._id.$in;
    expect(cleanupIds).toHaveLength(2);
    expect(cleanupIds.every((id) => String(id).startsWith('new-'))).toBe(true);
  });

  it('should insert new records before deleting captured originals', async () => {
    aidStore.push(
      makeAid({ _id: 'old-1', houseName: 'House A' }),
      makeAid({ _id: 'old-2', houseName: 'House B' })
    );

    await aidService.updateFullAidGroup(
      originalGroup,
      baseUpdatedData,
      ['House A', 'House B'],
      'user123'
    );

    const insertCallOrder = mockAidModel.insertMany.mock.invocationCallOrder[0];
    const deleteCallOrder = mockAidModel.deleteMany.mock.invocationCallOrder[0];
    expect(insertCallOrder).toBeLessThan(deleteCallOrder);
    expect(mockReminderService.syncDueReminderForGroup).toHaveBeenCalled();
  });

  it('should handle empty houseNames gracefully', async () => {
    aidStore.push(makeAid({ _id: 'old-1', houseName: 'House A' }));

    const result = await aidService.updateFullAidGroup(
      originalGroup,
      baseUpdatedData,
      [],
      'user123'
    );

    expect(result).toEqual([]);
    expect(findByIds(['old-1'])).toHaveLength(1);
    expect(mockAidModel.insertMany).not.toHaveBeenCalled();
    expect(mockAidModel.deleteMany).not.toHaveBeenCalled();
  });
});
