/**
 * P0 Regression Tests — Public Booking Upload Ownership
 */

const mongoose = require('mongoose');
const { BOOKING_STATUSES } = require('../../src/modules/bookings/booking.model');

// ── Module-scope mutable stores (cleared in beforeEach) ──
const mockPendingUploadStore = new Map();
let mockUploadTokenCounter = 0;

// `_assertRequestedScheduleAllowed` rejects any date outside
// [today, today + bookingHorizonDays], so a literal date here would silently turn
// every test in this file red once it drifted into the past.
const { FUTURE_DATE } = require('../helpers/dates');

// ── Module-scope mockChainable helper (prefixed with mock per Jest rules) ──
function mockChainable(resolvedValue) {
  return {
    lean: jest.fn().mockResolvedValue(resolvedValue),
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
  };
}

// ── All mocks at module scope (no jest.mock inside beforeEach) ──

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../src/utils/fileUploads', () => ({
  validateImageUpload: jest.fn().mockReturnValue({
    kind: 'image', mimeType: 'image/png', originalName: 'test.png', size: 1024,
  }),
}));

const mockDeletedKeys = [];
jest.mock('../../src/services/storage/storage.service', () => ({
  uploadFile: jest.fn().mockResolvedValue({
    url: 'https://r2.example.com/bookings/type/photo/12345678-abcdef01.png',
    storageKey: 'bookings/type/photo/12345678-abcdef01.png',
    provider: 'r2', mimeType: 'image/png', size: 1024, originalName: 'test.png',
  }),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  deleteFiles: jest.fn().mockImplementation(async (keys) => { mockDeletedKeys.push(...keys); }),
  buildPublicUrl: jest.fn((key) => `https://r2.example.com/${key}`),
}));

jest.mock('../../src/config/env', () => ({
  env: 'test', isProduction: false, isDevelopmentLike: true,
  jwt: { accessSecret: 'test', refreshSecret: 'test', accessExpiresIn: '15m' },
  redis: { enabled: false },
  r2: { enabled: false, required: false },
  upload: { maxFileSize: 5 * 1024 * 1024 },
  cors: { allowedOrigins: [] },
  docs: { enabled: false }, http: { trustProxy: false },
  mail: { enabled: false }, push: { enabled: false },
  rateLimit: { windowMs: 900000, max: 1000 },
  cache: { userTTL: 3600, permissionsTTL: 1800 },
  aidReminders: { pollIntervalMs: 3600000 },
  meetingReminders: { pollIntervalMs: 60000 },
  backup: { enabled: false },
}));

// BookingPendingUpload mock — module scope with mutable store
jest.mock('../../src/modules/bookings/bookingPendingUpload.model', () => {
  let pidCounter = 0;
  function newPid() { return 'pu-' + (++pidCounter); }
  const MockPendingUpload = function (data) {
    this._id = data._id || newPid();
    this.uploadToken = data.uploadToken || ('token-' + (++mockUploadTokenCounter));
    this.bookingTypeId = data.bookingTypeId;
    this.fieldKey = data.fieldKey;
    this.storageKey = data.storageKey;
    this.url = data.url;
    this.mimeType = data.mimeType || 'image/png';
    this.size = data.size || 1024;
    this.originalName = data.originalName || 'test.png';
    this.expiresAt = data.expiresAt || new Date(Date.now() + 30 * 60 * 1000);
    this.consumedAt = data.consumedAt || null;
    this.bookingId = data.bookingId || null;
    this.createdAt = data.createdAt || new Date();
    this.isExpired = function () { return new Date() > this.expiresAt; };
    this.isConsumed = function () { return this.consumedAt !== null; };
    this.markConsumed = function (bId) { this.consumedAt = new Date(); this.bookingId = bId; };
    mockPendingUploadStore.set(this.uploadToken, this);
    if (this.storageKey) mockPendingUploadStore.set('key:' + this.storageKey, this);
  };
  MockPendingUpload.create = jest.fn().mockImplementation(async (data) => new MockPendingUpload(data));
  MockPendingUpload.findOne = jest.fn().mockImplementation((query) => {
    let result = null;
    if (query.uploadToken) result = mockPendingUploadStore.get(query.uploadToken) || null;
    else if (query.storageKey) result = mockPendingUploadStore.get('key:' + query.storageKey) || null;
    return {
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(result),
      then: (resolve) => resolve(result),
    };
  });
  // Atomic claim: findOneAndUpdate with conditions
  MockPendingUpload.findOneAndUpdate = jest.fn().mockImplementation((query, update, opts) => {
    let doc = null;
    if (query.uploadToken) doc = mockPendingUploadStore.get(query.uploadToken) || null;
    else if (query.storageKey) doc = mockPendingUploadStore.get('key:' + query.storageKey) || null;
    if (!doc) return null;
    // Check all conditions
    if (query.consumedAt !== undefined && doc.consumedAt !== null) return null;
    if (query.expiresAt && query.expiresAt.$gt && !(doc.expiresAt > query.expiresAt.$gt)) return null;
    if (query.bookingTypeId && String(doc.bookingTypeId) !== String(query.bookingTypeId)) return null;
    if (query.fieldKey && doc.fieldKey !== query.fieldKey) return null;
    // Apply the update
    if (update.$set) {
      if (update.$set.consumedAt !== undefined) doc.consumedAt = update.$set.consumedAt;
      if (update.$set.bookingId !== undefined) doc.bookingId = update.$set.bookingId;
    }
    return doc;
  });
  MockPendingUpload.find = jest.fn().mockReturnValue({
    lean: jest.fn().mockImplementation(async () => {
      const results = [];
      for (const [k, doc] of mockPendingUploadStore) {
        if (k.startsWith('key:')) continue;
        if (doc && doc.expiresAt <= new Date() && doc.consumedAt === null) results.push(doc);
      }
      return results;
    }),
  });
  MockPendingUpload.updateMany = jest.fn().mockImplementation(async (query, update) => {
    // Apply updates to matching store docs so _releaseClaimedUploads works
    if (query._id && query._id.$in) {
      for (const id of query._id.$in) {
        for (const [, doc] of mockPendingUploadStore) {
          if (doc._id === id) {
            if (update.$set) {
              if (update.$set.consumedAt !== undefined) doc.consumedAt = update.$set.consumedAt;
              if (update.$set.bookingId !== undefined) doc.bookingId = update.$set.bookingId;
            }
            break;
          }
        }
      }
    }
    return { modifiedCount: 1 };
  });
  MockPendingUpload.deleteMany = jest.fn().mockResolvedValue({ deletedCount: 1 });
  MockPendingUpload.DEFAULT_UPLOAD_EXPIRY_MINUTES = 30;
  return MockPendingUpload;
});

// Booking model mock
jest.mock('../../src/modules/bookings/booking.model', () => {
  const actual = jest.requireActual('../../src/modules/bookings/booking.model');
  let bidCounter = 0;
  function newBid() { return 'bk-' + (++bidCounter); }
  const MockBooking = function (data) {
    this._id = data._id || newBid();
    this.bookingTypeId = data.bookingTypeId;
    this.scheduledDate = data.scheduledDate;
    this.scheduledTime = data.scheduledTime;
    this.status = data.status || actual.BOOKING_STATUSES.PENDING;
    this.adminNotes = data.adminNotes || '';
    this.save = jest.fn().mockResolvedValue(this);
    this.toObject = jest.fn().mockReturnValue({ ...data, _id: this._id });
  };
  MockBooking.findById = jest.fn();
  MockBooking.findOne = jest.fn().mockReturnValue(mockChainable(null));
  MockBooking.find = jest.fn().mockReturnValue(mockChainable([]));
  MockBooking.countDocuments = jest.fn().mockResolvedValue(0);
  MockBooking.aggregate = jest.fn().mockReturnValue(mockChainable([]));
  MockBooking.create = jest.fn().mockImplementation(async (data) => new MockBooking(data));
  MockBooking.BOOKING_STATUSES = actual.BOOKING_STATUSES;
  MockBooking.BOOKING_STATUS_VALUES = actual.BOOKING_STATUS_VALUES;
  return MockBooking;
});

// BookingType mock — returns a type whose _id matches the requested ID
let mockCustomTypeDoc = null;
jest.mock('../../src/modules/bookings/bookingType.model', () => {
  let tidCounter = 0;
  function newTid() { return 'bt-' + (++tidCounter); }
  function makeTypeDoc(overrides = {}) {
    return {
      _id: overrides._id || newTid(),
      name: overrides.name || 'Test Type',
      isActive: overrides.isActive !== undefined ? overrides.isActive : true,
      availabilityMode: overrides.availabilityMode || 'ALWAYS',
      capacity: overrides.capacity || 5,
      bookingHorizonDays: overrides.bookingHorizonDays || 45,
      availabilityConfig: overrides.availabilityConfig || { timezone: 'Africa/Cairo' },
      dynamicFields: overrides.dynamicFields || [
        { key: 'photo', label: 'Photo', type: 'image', required: false },
        { key: 'notes_field', label: 'Notes', type: 'text', required: false },
      ],
    };
  }
  const mod = {
    findById: jest.fn().mockImplementation((id) => {
      if (mockCustomTypeDoc) return mockChainable(mockCustomTypeDoc);
      const typeId = id && id._id ? id._id : id;
      return mockChainable(makeTypeDoc({ _id: typeId }));
    }),
    findOne: jest.fn(),
    find: jest.fn().mockReturnValue(mockChainable([])),
  };
  mod.AVAILABILITY_MODES = {
    ALWAYS: 'ALWAYS', NONE: 'NONE', DATE_RANGE: 'DATE_RANGE',
    DATE_TIME_RANGE: 'DATE_TIME_RANGE', SPECIFIC_DAYS: 'SPECIFIC_DAYS',
    SPECIFIC_DAYS_TIME: 'SPECIFIC_DAYS_TIME', SPECIFIC_DATES: 'SPECIFIC_DATES',
    SPECIFIC_DATES_TIME: 'SPECIFIC_DATES_TIME', DATE_TIME: 'DATE_TIME',
  };
  mod.FIELD_TYPES = {
    TEXT: 'text', TEXTAREA: 'textarea', NUMBER: 'number', EMAIL: 'email',
    PHONE: 'phone', IMAGE: 'image', DATE: 'date', CHECKBOX: 'checkbox', SELECT: 'select',
  };
  return mod;
});

// BookingSlotCounter mock
jest.mock('../../src/modules/bookings/bookingSlotCounter.model', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue({ used: 1, capacity: 5 }),
  updateOne: jest.fn().mockResolvedValue({}),
  deleteOne: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockReturnValue(mockChainable([])),
}));

// ═══════════════════════════════════════════════

describe('Public Booking Upload Ownership', () => {
  let bookingsService;
  let BookingTypeMod;
  let BookingModel;
  let PendingUploadMod;

  beforeAll(() => {
    bookingsService = require('../../src/modules/bookings/bookings.service');
    BookingTypeMod = require('../../src/modules/bookings/bookingType.model');
    BookingModel = require('../../src/modules/bookings/booking.model');
    PendingUploadMod = require('../../src/modules/bookings/bookingPendingUpload.model');
  });

  beforeEach(() => {
    mockPendingUploadStore.clear();
    mockUploadTokenCounter = 0;
    mockCustomTypeDoc = null;
    mockDeletedKeys.length = 0;
    jest.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════
  //  1.
  // ═══════════════════════════════════════════════════════════════
  describe('public_booking_image_must_reference_owned_pending_upload', () => {
    it('should reject booking with an external URL that has no uploadToken or storageKey', async () => {
      await expect(
        bookingsService.createPublicBooking({
          bookingTypeId: new mongoose.Types.ObjectId(),
          requesterName: 'Test User', requesterPhone: '01000000000',
          scheduledDate: FUTURE_DATE, scheduledTime: '10:00',
          dynamicFields: [
            { key: 'photo', value: { url: 'https://evil.example.com/hacked.jpg' } },
          ],
        })
      ).rejects.toThrow('Only images uploaded through the booking form are accepted');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  2.
  // ═══════════════════════════════════════════════════════════════
  describe('public_booking_image_must_not_reference_unknown_storage_key', () => {
    it('should reject booking with a storageKey that has no matching pending upload', async () => {
      await expect(
        bookingsService.createPublicBooking({
          bookingTypeId: new mongoose.Types.ObjectId(),
          requesterName: 'Test User', requesterPhone: '01000000000',
          scheduledDate: FUTURE_DATE, scheduledTime: '10:00',
          dynamicFields: [
            { key: 'photo', value: { storageKey: 'bookings/unknown/photo/fake-key.png' } },
          ],
        })
      ).rejects.toThrow('Uploaded image was not found');
    });
  });

  // ═══════════════════════════════════════════════
  //  3.
  // ═══════════════════════════════════════════════
  describe('pending_upload_can_be_consumed_once', () => {
    it('should succeed on first use, then reject reuse', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const upload = await bookingsService.uploadImageToStorage(
        { buffer: Buffer.from('fake'), originalname: 'test.png', size: 1024, mimetype: 'image/png' },
        { bookingTypeId: typeId, fieldKey: 'photo' }
      );

      const payload = {
        bookingTypeId: typeId, requesterName: 'Test User', requesterPhone: '01000000000',
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00',
        dynamicFields: [{ key: 'photo', value: { uploadToken: upload.uploadToken } }],
      };

      // First booking succeeds — atomic claim marks upload consumed during _claimImageField
      await bookingsService.createPublicBooking(payload);

      // Verify the upload IS now consumed
      const doc = mockPendingUploadStore.get(upload.uploadToken);
      expect(doc.consumedAt).not.toBeNull();

      // Second attempt must fail — findOneAndUpdate returns null because consumedAt != null
      await expect(
        bookingsService.createPublicBooking(payload)
      ).rejects.toThrow('already been used');
    });
  });

  // ═══════════════════════════════════════════════
  //  4.
  // ═══════════════════════════════════════════════
  describe('pending_upload_must_match_booking_type', () => {
    it('should reject when upload was created for a different booking type', async () => {
      const typeA = new mongoose.Types.ObjectId();
      const typeB = new mongoose.Types.ObjectId();

      const upload = await bookingsService.uploadImageToStorage(
        { buffer: Buffer.from('fake'), originalname: 'test.png', size: 1024, mimetype: 'image/png' },
        { bookingTypeId: typeA, fieldKey: 'photo' }
      );

      await expect(
        bookingsService.createPublicBooking({
          bookingTypeId: typeB, requesterName: 'Test User', requesterPhone: '01000000000',
          scheduledDate: FUTURE_DATE, scheduledTime: '10:00',
          dynamicFields: [{ key: 'photo', value: { uploadToken: upload.uploadToken } }],
        })
      ).rejects.toThrow('does not belong to this booking type');
    });
  });

  // ═══════════════════════════════════════════
  //  5.
  // ═══════════════════════════════════════════
  describe('pending_upload_must_match_field_key', () => {
    it('should reject when upload was created for a different field key', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const upload = await bookingsService.uploadImageToStorage(
        { buffer: Buffer.from('fake'), originalname: 'test.png', size: 1024, mimetype: 'image/png' },
        { bookingTypeId: typeId, fieldKey: 'photo' }
      );

      // Override the type returned for this booking to include a second IMAGE field
      mockCustomTypeDoc = {
        _id: typeId, name: 'Test Type', isActive: true,
        availabilityMode: 'ALWAYS', capacity: 5, bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' },
        dynamicFields: [
          { key: 'photo', label: 'Photo', type: 'image', required: false },
          { key: 'signature', label: 'Signature', type: 'image', required: false },
        ],
      };

      await expect(
        bookingsService.createPublicBooking({
          bookingTypeId: typeId, requesterName: 'Test User', requesterPhone: '01000000000',
          scheduledDate: FUTURE_DATE, scheduledTime: '10:00',
          dynamicFields: [{ key: 'signature', value: { uploadToken: upload.uploadToken } }],
        })
      ).rejects.toThrow('Upload was created for field');
    });
  });

  // ═══════════════════════════════════════════
  //  6.
  // ═══════════════════════════════════════════
  describe('expired_pending_upload_is_rejected', () => {
    it('should reject booking when the upload has expired', async () => {
      const typeId = new mongoose.Types.ObjectId();

      // Create an expired upload manually in the store
      const expired = new (PendingUploadMod)({
        bookingTypeId: typeId, fieldKey: 'photo',
        storageKey: 'bookings/type/photo/expired.png',
        url: 'https://r2.example.com/bookings/type/photo/expired.png',
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(
        bookingsService.createPublicBooking({
          bookingTypeId: typeId, requesterName: 'Test User', requesterPhone: '01000000000',
          scheduledDate: FUTURE_DATE, scheduledTime: '10:00',
          dynamicFields: [{ key: 'photo', value: { uploadToken: expired.uploadToken } }],
        })
      ).rejects.toThrow('expired');
    });
  });

  // ═══════════════════════════════════════════════
  //  7.
  // ═══════════════════════════════════════════════
  describe('successful_booking_marks_upload_consumed', () => {
    it('should atomically claim then bind the upload to the created booking', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const upload = await bookingsService.uploadImageToStorage(
        { buffer: Buffer.from('fake'), originalname: 'test.png', size: 1024, mimetype: 'image/png' },
        { bookingTypeId: typeId, fieldKey: 'photo' }
      );

      await bookingsService.createPublicBooking({
        bookingTypeId: typeId, requesterName: 'Test User', requesterPhone: '01000000000',
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00',
        dynamicFields: [{ key: 'photo', value: { uploadToken: upload.uploadToken } }],
      });

      // Step 1: Atomic claim via findOneAndUpdate (consumedAt set, bookingId: null)
      expect(PendingUploadMod.findOneAndUpdate).toHaveBeenCalled();
      const claimCall = PendingUploadMod.findOneAndUpdate.mock.calls[0];
      expect(claimCall[0].consumedAt).toBe(null);           // condition
      expect(claimCall[0].uploadToken).toBe(upload.uploadToken);
      expect(claimCall[1].$set.consumedAt).toBeDefined();   // update

      // Step 2: BookingId binding via updateMany after successful save
      expect(PendingUploadMod.updateMany).toHaveBeenCalled();
      const bindCall = PendingUploadMod.updateMany.mock.calls[0];
      expect(bindCall[1].$set.bookingId).toBeDefined();     // real booking ID
    });
  });

  // ═══════════════════════════════════════════════
  //  8.
  // ═══════════════════════════════════════════════
  describe('failed_booking_creation_does_not_consume_upload', () => {
    it('should NOT consume the upload if booking creation fails', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const upload = await bookingsService.uploadImageToStorage(
        { buffer: Buffer.from('fake'), originalname: 'test.png', size: 1024, mimetype: 'image/png' },
        { bookingTypeId: typeId, fieldKey: 'photo' }
      );

      // Force Booking.create to fail on the NEXT call
      BookingModel.create.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        bookingsService.createPublicBooking({
          bookingTypeId: typeId, requesterName: 'Test User', requesterPhone: '01000000000',
          scheduledDate: FUTURE_DATE, scheduledTime: '10:00',
          dynamicFields: [{ key: 'photo', value: { uploadToken: upload.uploadToken } }],
        })
      ).rejects.toThrow('DB error');

      // Upload should remain unconsumed
      const doc = mockPendingUploadStore.get(upload.uploadToken);
      expect(doc.consumedAt).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════
  //  9.  concurrent_claims_only_one_succeeds
  // ═══════════════════════════════════════════════
  describe('concurrent_claims_only_one_succeeds', () => {
    it('should allow exactly one booking when two requests race for the same uploadToken', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const upload = await bookingsService.uploadImageToStorage(
        { buffer: Buffer.from('fake'), originalname: 'test.png', size: 1024, mimetype: 'image/png' },
        { bookingTypeId: typeId, fieldKey: 'photo' }
      );

      const payload = {
        bookingTypeId: typeId, requesterName: 'Test User', requesterPhone: '01000000000',
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00',
        dynamicFields: [{ key: 'photo', value: { uploadToken: upload.uploadToken } }],
      };

      // Launch two parallel createPublicBooking calls — no await between them
      const [r1, r2] = await Promise.allSettled([
        bookingsService.createPublicBooking({ ...payload, requesterName: 'User A' }),
        bookingsService.createPublicBooking({ ...payload, requesterName: 'User B' }),
      ]);

      // Exactly one must succeed, the other must fail
      const succeeded = [r1, r2].filter((r) => r.status === 'fulfilled').length;
      const failed = [r1, r2].filter((r) => r.status === 'rejected').length;

      expect(succeeded).toBe(1);
      expect(failed).toBe(1);

      // The rejected one should mention "already been used"
      const rejection = (r1.status === 'rejected' ? r1 : r2).reason;
      expect(rejection.message).toContain('already been used');
    });
  });

  // ═══════════════════════════════════════════════
  //  10.
  // ═══════════════════════════════════════════════
  describe('abandoned_pending_upload_cleanup_deletes_storage_object', () => {
    it('should call deleteFiles with expired unconsumed upload keys', async () => {
      // Create expired uploads
      new (PendingUploadMod)({
        bookingTypeId: new mongoose.Types.ObjectId(), fieldKey: 'photo',
        storageKey: 'bookings/old/photo/expired1.png',
        url: 'https://r2.example.com/bookings/old/photo/expired1.png',
        expiresAt: new Date(Date.now() - 5000),
      });
      new (PendingUploadMod)({
        bookingTypeId: new mongoose.Types.ObjectId(), fieldKey: 'photo',
        storageKey: 'bookings/old/photo/expired2.png',
        url: 'https://r2.example.com/bookings/old/photo/expired2.png',
        expiresAt: new Date(Date.now() - 3000),
      });

      await bookingsService.cleanupExpiredPendingUploads();

      const storage = require('../../src/services/storage/storage.service');
      expect(storage.deleteFiles).toHaveBeenCalled();
      const keysArg = storage.deleteFiles.mock.calls[0][0];
      expect(keysArg).toContain('bookings/old/photo/expired1.png');
      expect(keysArg).toContain('bookings/old/photo/expired2.png');
      expect(PendingUploadMod.deleteMany).toHaveBeenCalled();
    });

    it('should return 0 when there are no expired uploads', async () => {
      const count = await bookingsService.cleanupExpiredPendingUploads();
      expect(count).toBe(0);
    });
  });
});
