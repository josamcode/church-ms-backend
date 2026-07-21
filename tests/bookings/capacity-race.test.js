/**
 * P0 Regression Tests — Booking Capacity Race (Atomic Counter)
 */

const mongoose = require('mongoose');
const { BOOKING_STATUSES } = require('../../src/modules/bookings/booking.model');
const { FUTURE_DATE } = require('../helpers/dates');

// ── Helpers to build chainable Mongoose query mocks ──

function chainable(resolvedValue) {
  return {
    lean: jest.fn().mockResolvedValue(resolvedValue),
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
  };
}

describe('Booking Capacity Race — Atomic Counter', () => {
  let bookingsService;
  let mockBookingModel;
  let mockBookingTypeModel;
  let mockCounterModel;
  let counterStore;
  let bookingStore;

  beforeAll(() => {
    jest.mock('../../src/utils/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
  });

  beforeEach(() => {
    jest.resetModules();
    counterStore = new Map();
    bookingStore = new Map();

    // ── Build mock Booking model ──
    mockBookingModel = function (data) {
      if (!(this instanceof mockBookingModel)) return new mockBookingModel(data);
      this._id = data._id || new mongoose.Types.ObjectId();
      this.bookingTypeId = data.bookingTypeId;
      this.scheduledDate = data.scheduledDate;
      this.scheduledTime = data.scheduledTime || null;
      this.status = data.status || BOOKING_STATUSES.PENDING;
      this.adminNotes = data.adminNotes || '';
      this.updatedBy = data.updatedBy || null;
      this.bookingTypeNameSnapshot = data.bookingTypeNameSnapshot || '';
      this.scheduledAt = data.scheduledAt || new Date();
      this.requester = data.requester || { name: '', phone: '', email: '' };
      this.notes = data.notes || '';
      this.additionalFields = data.additionalFields || [];
      this.source = data.source || 'public';
      this.createdAt = data.createdAt || new Date();
      this.updatedAt = data.updatedAt || new Date();
      this.save = jest.fn().mockResolvedValue(this);
      this.toObject = jest.fn().mockReturnValue({ ...data, _id: this._id });
      bookingStore.set(String(this._id), this);
    };
    mockBookingModel.findById = jest.fn();
    mockBookingModel.findOne = jest.fn();
    mockBookingModel.findOneAndUpdate = jest.fn().mockImplementation(async (query, update) => {
      const doc = bookingStore.get(String(query._id));
      if (!doc) return null;

      const queryTime = query.scheduledTime == null ? null : query.scheduledTime;
      const docTime = doc.scheduledTime == null ? null : doc.scheduledTime;
      const matches =
        String(doc._id) === String(query._id) &&
        String(doc.bookingTypeId) === String(query.bookingTypeId) &&
        doc.scheduledDate === query.scheduledDate &&
        docTime === queryTime &&
        doc.status === query.status;

      if (!matches) return null;

      if (update.$set) {
        Object.entries(update.$set).forEach(([key, value]) => {
          doc[key] = value;
        });
      }
      if (update.$unset) {
        Object.keys(update.$unset).forEach((key) => {
          doc[key] = undefined;
        });
      }
      doc.updatedAt = new Date();
      return doc;
    });
    mockBookingModel.find = jest.fn().mockReturnValue(chainable([]));
    mockBookingModel.create = jest.fn();
    mockBookingModel.countDocuments = jest.fn();
    mockBookingModel.aggregate = jest.fn().mockReturnValue(chainable([]));
    mockBookingModel.BOOKING_STATUSES = BOOKING_STATUSES;
    mockBookingModel.BOOKING_STATUS_VALUES = Object.values(BOOKING_STATUSES);

    jest.mock('../../src/modules/bookings/booking.model', () => mockBookingModel);

    // ── Build mock BookingType model ──
    mockBookingTypeModel = {
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn().mockReturnValue(chainable([])),
      create: jest.fn(),
    };
    mockBookingTypeModel.AVAILABILITY_MODES = {
      ALWAYS: 'ALWAYS', NONE: 'NONE', DATE_RANGE: 'DATE_RANGE',
      DATE_TIME_RANGE: 'DATE_TIME_RANGE', SPECIFIC_DAYS: 'SPECIFIC_DAYS',
      SPECIFIC_DAYS_TIME: 'SPECIFIC_DAYS_TIME', SPECIFIC_DATES: 'SPECIFIC_DATES',
      SPECIFIC_DATES_TIME: 'SPECIFIC_DATES_TIME', DATE_TIME: 'DATE_TIME',
    };
    mockBookingTypeModel.FIELD_TYPES = {
      TEXT: 'text', TEXTAREA: 'textarea', NUMBER: 'number', EMAIL: 'email',
      PHONE: 'phone', IMAGE: 'image', DATE: 'date', CHECKBOX: 'checkbox', SELECT: 'select',
    };

    jest.mock('../../src/modules/bookings/bookingType.model', () => mockBookingTypeModel);

    // ── Build mock BookingSlotCounter model ──
    function counterDocKey(doc) {
      return `${doc.bookingTypeId}||${doc.slotDate}||${doc.slotTime || ''}`;
    }

    mockCounterModel = {
      findOne: jest.fn().mockImplementation(async (query) => {
        const key = `${query.bookingTypeId}||${query.slotDate}||${query.slotTime ?? ''}`;
        return counterStore.get(key) || null;
      }),
      findOneAndUpdate: jest.fn().mockImplementation(async (query, update, opts) => {
        if (query._id) {
          for (const [k, doc] of counterStore) {
            if (String(doc._id) === String(query._id)) {
              if (query.$expr && !(doc.used < doc.capacity)) return null;
              if (query.used?.$gt != null && !(doc.used > query.used.$gt)) return null;
              doc.used += (update.$inc?.used || 0);
              if (update.$set?.capacity != null) doc.capacity = update.$set.capacity;
              if (doc.used < 0) doc.used = 0;
              return opts?.rawResult ? { value: { ...doc } } : { ...doc };
            }
          }
          return null;
        }
        const key = `${query.bookingTypeId}||${query.slotDate}||${query.slotTime ?? ''}`;
        if (opts?.upsert) {
          let doc = counterStore.get(key);
          if (!doc) {
            doc = {
              _id: new mongoose.Types.ObjectId(),
              bookingTypeId: query.bookingTypeId,
              slotDate: query.slotDate,
              slotTime: query.slotTime ?? '',
              used: update.$setOnInsert?.used ?? 0,
              capacity: update.$setOnInsert?.capacity ?? 1,
            };
            counterStore.set(key, doc);
          }
          if (opts.rawResult) return { value: { ...doc }, lastErrorObject: { upserted: true } };
          return { ...doc };
        }
        const doc = counterStore.get(key);
        if (!doc) return null;
        if (query.$expr && !(doc.used < doc.capacity)) return null;
        if (query.used?.$gt != null && !(doc.used > query.used.$gt)) return null;
        doc.used += (update.$inc?.used || 0);
        if (update.$set?.capacity != null) doc.capacity = update.$set.capacity;
        if (doc.used < 0) doc.used = 0;
        return { ...doc };
      }),
      updateOne: jest.fn().mockImplementation(async (query, update, opts) => {
        const key = `${query.bookingTypeId}||${query.slotDate}||${query.slotTime ?? ''}`;
        if (opts?.upsert) {
          if (!counterStore.has(key)) {
            counterStore.set(key, {
              _id: new mongoose.Types.ObjectId(),
              bookingTypeId: query.bookingTypeId,
              slotDate: query.slotDate,
              slotTime: query.slotTime ?? '',
              used: 0, capacity: 1,
            });
          }
          return { upsertedCount: 1 };
        }
        const doc = counterStore.get(key);
        if (!doc) return { modifiedCount: 0 };
        if (query.$expr && !(doc.used < doc.capacity)) return { modifiedCount: 0 };
        if (query.used?.$gt != null && !(doc.used > query.used.$gt)) return { modifiedCount: 0 };
        doc.used += (update.$inc?.used || 0);
        if (update.$set?.capacity != null) doc.capacity = update.$set.capacity;
        if (update.$set?.used != null) doc.used = update.$set.used;
        if (doc.used < 0) doc.used = 0;
        return { modifiedCount: 1 };
      }),
      deleteOne: jest.fn().mockImplementation(async (query) => {
        for (const [k, doc] of counterStore) {
          if (String(doc._id) === String(query._id)) { counterStore.delete(k); return { deletedCount: 1 }; }
        }
        return { deletedCount: 0 };
      }),
      find: jest.fn().mockReturnValue(chainable([])),
    };

    jest.mock('../../src/modules/bookings/bookingSlotCounter.model', () => mockCounterModel);

    jest.mock('../../src/utils/fileUploads', () => ({ validateImageUpload: jest.fn() }));
    jest.mock('../../src/services/storage/storage.service', () => ({
      uploadFile: jest.fn(), deleteFile: jest.fn(),
    }));

    bookingsService = require('../../src/modules/bookings/bookings.service');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════
  //  parallel_confirmations_cannot_exceed_capacity_with_atomic_counter
  // ═══════════════════════════════════════════════════════════════
  describe('parallel_confirmations_cannot_exceed_capacity_with_atomic_counter', () => {
    it('should only allow one confirmation when two bookings race for a capacity-1 slot', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const type = { _id: typeId, name: 'Test', isActive: true, capacity: 1,
        availabilityMode: 'ALWAYS', bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' }, dynamicFields: [] };

      const b1 = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.PENDING });
      const b2 = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.PENDING });

      mockBookingModel.findById
        .mockResolvedValueOnce(b1)
        .mockResolvedValueOnce(b2);
      mockBookingTypeModel.findById.mockReturnValue(chainable(type));

      // Also need getBookingById to work for the return value
      mockBookingModel.findOne.mockReturnValue(chainable({
        ...b1.toObject(), bookingTypeNameSnapshot: 'Test',
        requester: { name: '', phone: '', email: '' },
        additionalFields: [], adminNotes: '', source: 'public',
        createdAt: new Date(), updatedAt: new Date(),
      }));

      // First confirm → succeeds
      await bookingsService.updateBooking(b1._id.toString(),
        { status: BOOKING_STATUSES.CONFIRMED }, 'admin1');
      expect(b1.status).toBe(BOOKING_STATUSES.CONFIRMED);

      // Second confirm → fails (slot full)
      mockBookingModel.findOne.mockReturnValue(chainable({
        ...b2.toObject(), bookingTypeNameSnapshot: 'Test',
        requester: { name: '', phone: '', email: '' },
        additionalFields: [], adminNotes: '', source: 'public',
        createdAt: new Date(), updatedAt: new Date(),
      }));
      await expect(
        bookingsService.updateBooking(b2._id.toString(),
          { status: BOOKING_STATUSES.CONFIRMED }, 'admin2')
      ).rejects.toThrow('no longer available');
      expect(b2.status).toBe(BOOKING_STATUSES.PENDING);
    });

    it('should allow both confirmations when capacity is 2', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const type = { _id: typeId, name: 'Test', isActive: true, capacity: 2,
        availabilityMode: 'ALWAYS', bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' }, dynamicFields: [] };

      const b1 = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.PENDING });
      const b2 = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.PENDING });

      mockBookingModel.findById
        .mockResolvedValueOnce(b1)
        .mockResolvedValueOnce(b2);
      mockBookingTypeModel.findById.mockReturnValue(chainable(type));
      mockBookingModel.findOne.mockReturnValue(chainable({
        _id: b1._id, bookingTypeNameSnapshot: 'Test',
        requester: { name: '', phone: '', email: '' },
        additionalFields: [], adminNotes: '', source: 'public', status: BOOKING_STATUSES.CONFIRMED,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', scheduledAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(),
      }));

      await bookingsService.updateBooking(b1._id.toString(),
        { status: BOOKING_STATUSES.CONFIRMED }, 'admin1');
      await bookingsService.updateBooking(b2._id.toString(),
        { status: BOOKING_STATUSES.CONFIRMED }, 'admin2');

      expect(b1.status).toBe(BOOKING_STATUSES.CONFIRMED);
      expect(b2.status).toBe(BOOKING_STATUSES.CONFIRMED);
    });
  });

  // ═══════════════════════════════════════════
  //  capacity_claim_rejects_when_full
  // ═══════════════════════════════════════════
  describe('capacity_claim_rejects_when_full', () => {
    it('should reject confirmation when counter used equals capacity', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const type = { _id: typeId, name: 'Test', isActive: true, capacity: 1 };

      // Pre-populate the counter at capacity
      const key = `${typeId}||${FUTURE_DATE}||10:00`;
      counterStore.set(key, {
        _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        slotDate: FUTURE_DATE, slotTime: '10:00', used: 1, capacity: 1,
      });

      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.PENDING });

      mockBookingModel.findById.mockResolvedValue(b);
      mockBookingTypeModel.findById.mockReturnValue(chainable(type));

      await expect(
        bookingsService.updateBooking(b._id.toString(),
          { status: BOOKING_STATUSES.CONFIRMED }, 'admin1')
      ).rejects.toThrow('no longer available');
      expect(b.status).toBe(BOOKING_STATUSES.PENDING);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  capacity_released_when_confirmed_booking_is_cancelled_or_rejected
  // ═══════════════════════════════════════════════════════════════
  describe('capacity_released_when_confirmed_booking_is_cancelled_or_rejected', () => {
    it('should release capacity when a CONFIRMED booking is cancelled', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const slotDate = FUTURE_DATE, slotTime = '10:00';
      const key = `${typeId}||${slotDate}||${slotTime}`;
      counterStore.set(key, {
        _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        slotDate, slotTime, used: 1, capacity: 1,
      });

      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.CONFIRMED });

      mockBookingModel.findById.mockResolvedValue(b);
      mockBookingModel.findOne.mockReturnValue(chainable({
        ...b.toObject(), bookingTypeNameSnapshot: 'Test',
        requester: { name: '', phone: '', email: '' },
        additionalFields: [], adminNotes: '', source: 'public',
        createdAt: new Date(), updatedAt: new Date(),
      }));

      await bookingsService.updateBooking(b._id.toString(),
        { status: BOOKING_STATUSES.CANCELLED }, 'admin1');

      expect(b.status).toBe(BOOKING_STATUSES.CANCELLED);
      expect(counterStore.get(key).used).toBe(0);
    });

    it('should release capacity when a CONFIRMED booking is reverted to PENDING', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const slotDate = FUTURE_DATE, slotTime = '10:00';
      const key = `${typeId}||${slotDate}||${slotTime}`;
      counterStore.set(key, {
        _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        slotDate, slotTime, used: 1, capacity: 2,
      });

      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.CONFIRMED });

      mockBookingModel.findById.mockResolvedValue(b);
      mockBookingModel.findOne.mockReturnValue(chainable({
        ...b.toObject(), bookingTypeNameSnapshot: 'Test',
        requester: { name: '', phone: '', email: '' },
        additionalFields: [], adminNotes: '', source: 'public',
        createdAt: new Date(), updatedAt: new Date(),
      }));

      await bookingsService.updateBooking(b._id.toString(),
        { status: BOOKING_STATUSES.PENDING }, 'admin1');

      expect(b.status).toBe(BOOKING_STATUSES.PENDING);
      expect(counterStore.get(key).used).toBe(0);
    });

    it('should NOT release capacity when COMPLETED stays COMPLETED', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const key = `${typeId}||${FUTURE_DATE}||10:00`;
      counterStore.set(key, {
        _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        slotDate: FUTURE_DATE, slotTime: '10:00', used: 1, capacity: 2,
      });

      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.COMPLETED });

      mockBookingModel.findById.mockResolvedValue(b);
      mockBookingModel.findOne.mockReturnValue(chainable({
        ...b.toObject(), bookingTypeNameSnapshot: 'Test',
        requester: { name: '', phone: '', email: '' },
        additionalFields: [], adminNotes: '', source: 'public',
        createdAt: new Date(), updatedAt: new Date(),
      }));

      await bookingsService.updateBooking(b._id.toString(),
        { adminNotes: 'Done' }, 'admin1');

      expect(counterStore.get(key).used).toBe(1);
    });
  });

  // ═══════════════════════════════════════════
  //  capacity_transfers_when_confirmed_booking_moves_slot
  // ═══════════════════════════════════════════
  describe('same_booking_conditional_transition_protects_counter', () => {
    function setupGetBookingByIdResponse(booking) {
      mockBookingModel.findOne.mockReturnValue(chainable({
        ...booking.toObject(), bookingTypeNameSnapshot: 'Test',
        requester: { name: '', phone: '', email: '' },
        additionalFields: [], adminNotes: booking.adminNotes || '', source: 'public',
        createdAt: new Date(), updatedAt: new Date(),
      }));
    }

    it('parallel_confirms_same_pending_booking_claim_capacity_once', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const bookingId = new mongoose.Types.ObjectId();
      const type = { _id: typeId, name: 'Test', isActive: true, capacity: 5,
        availabilityMode: 'ALWAYS', bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' }, dynamicFields: [] };
      const slotDate = FUTURE_DATE, slotTime = '10:00';
      const key = `${typeId}||${slotDate}||${slotTime}`;

      const stored = new mockBookingModel({ _id: bookingId, bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.PENDING });
      const snapshotA = new mockBookingModel({ _id: bookingId, bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.PENDING });
      const snapshotB = new mockBookingModel({ _id: bookingId, bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.PENDING });
      bookingStore.set(String(bookingId), stored);

      mockBookingModel.findById
        .mockResolvedValueOnce(snapshotA)
        .mockResolvedValueOnce(snapshotB);
      mockBookingTypeModel.findById.mockReturnValue(chainable(type));
      setupGetBookingByIdResponse(stored);

      const results = await Promise.allSettled([
        bookingsService.updateBooking(String(bookingId), { status: BOOKING_STATUSES.CONFIRMED }, 'admin1'),
        bookingsService.updateBooking(String(bookingId), { status: BOOKING_STATUSES.CONFIRMED }, 'admin2'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected').reason.errorCode)
        .toBe('BOOKING_CONCURRENT_MODIFICATION');
      expect(stored.status).toBe(BOOKING_STATUSES.CONFIRMED);
      expect(counterStore.get(key).used).toBe(1);
    });

    it('parallel_cancels_same_confirmed_booking_release_capacity_once', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const bookingId = new mongoose.Types.ObjectId();
      const slotDate = FUTURE_DATE, slotTime = '10:00';
      const key = `${typeId}||${slotDate}||${slotTime}`;
      counterStore.set(key, {
        _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        slotDate, slotTime, used: 1, capacity: 5,
      });

      const stored = new mockBookingModel({ _id: bookingId, bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.CONFIRMED });
      const snapshotA = new mockBookingModel({ _id: bookingId, bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.CONFIRMED });
      const snapshotB = new mockBookingModel({ _id: bookingId, bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.CONFIRMED });
      bookingStore.set(String(bookingId), stored);

      mockBookingModel.findById
        .mockResolvedValueOnce(snapshotA)
        .mockResolvedValueOnce(snapshotB);
      setupGetBookingByIdResponse(stored);

      const results = await Promise.allSettled([
        bookingsService.updateBooking(String(bookingId), { status: BOOKING_STATUSES.CANCELLED }, 'admin1'),
        bookingsService.updateBooking(String(bookingId), { status: BOOKING_STATUSES.CANCELLED }, 'admin2'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected').reason.errorCode)
        .toBe('BOOKING_CONCURRENT_MODIFICATION');
      expect(stored.status).toBe(BOOKING_STATUSES.CANCELLED);
      expect(counterStore.get(key).used).toBe(0);
    });

    it('same-booking stale transition returns conflict', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const bookingId = new mongoose.Types.ObjectId();
      const type = { _id: typeId, name: 'Test', isActive: true, capacity: 2,
        availabilityMode: 'ALWAYS', bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' }, dynamicFields: [] };
      const slotDate = FUTURE_DATE, slotTime = '10:00';
      const stored = new mockBookingModel({ _id: bookingId, bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.CONFIRMED });
      const staleSnapshot = new mockBookingModel({ _id: bookingId, bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.PENDING });
      bookingStore.set(String(bookingId), stored);

      mockBookingModel.findById.mockResolvedValue(staleSnapshot);
      mockBookingTypeModel.findById.mockReturnValue(chainable(type));

      await expect(
        bookingsService.updateBooking(String(bookingId), { status: BOOKING_STATUSES.CONFIRMED }, 'admin1')
      ).rejects.toMatchObject({
        errorCode: 'BOOKING_CONCURRENT_MODIFICATION',
        statusCode: 409,
      });
    });
  });

  describe('capacity_transfers_when_confirmed_booking_moves_slot', () => {
    it('should not change capacity when re-confirming an already CONFIRMED booking', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const key = `${typeId}||${FUTURE_DATE}||10:00`;
      counterStore.set(key, {
        _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        slotDate: FUTURE_DATE, slotTime: '10:00', used: 1, capacity: 2,
      });

      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.CONFIRMED });

      mockBookingModel.findById.mockResolvedValue(b);
      mockBookingModel.findOne.mockReturnValue(chainable({
        ...b.toObject(), bookingTypeNameSnapshot: 'Test',
        requester: { name: '', phone: '', email: '' },
        additionalFields: [], adminNotes: '', source: 'public',
        createdAt: new Date(), updatedAt: new Date(),
      }));

      await bookingsService.updateBooking(b._id.toString(),
        { status: BOOKING_STATUSES.CONFIRMED }, 'admin1');

      // Counter unchanged — CONFIRMED → CONFIRMED is a no-op for capacity
      expect(counterStore.get(key).used).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════
  //  failed_update_does_not_leak_capacity_claim
  // ═══════════════════════════════════════════════
  describe('failed_update_does_not_leak_capacity_claim', () => {
    it('failed_conditional_update_releases_claim', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const type = { _id: typeId, name: 'Test', isActive: true, capacity: 2,
        availabilityMode: 'ALWAYS', bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' }, dynamicFields: [] };
      const slotDate = FUTURE_DATE, slotTime = '10:00';
      const key = `${typeId}||${slotDate}||${slotTime}`;

      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: slotDate, scheduledTime: slotTime, status: BOOKING_STATUSES.PENDING });

      mockBookingModel.findById.mockResolvedValue(b);
      mockBookingTypeModel.findById.mockReturnValue(chainable(type));
      mockBookingModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        bookingsService.updateBooking(b._id.toString(),
          { status: BOOKING_STATUSES.CONFIRMED }, 'admin1')
      ).rejects.toMatchObject({
        errorCode: 'BOOKING_CONCURRENT_MODIFICATION',
        statusCode: 409,
      });

      const counter = counterStore.get(key);
      expect(counter ? counter.used : 0).toBeLessThanOrEqual(0);
    });
  });

  // ═══════════════════════════════════════════
  //  existing safe-capacity flows still pass
  // ═══════════════════════════════════════════
  describe('existing safe-capacity flows still pass', () => {
    function setupGetBookingByIdResponse(status) {
      mockBookingModel.findOne.mockReturnValue(chainable({
        _id: new mongoose.Types.ObjectId(), bookingTypeNameSnapshot: 'Test',
        requester: { name: '', phone: '', email: '' },
        additionalFields: [], adminNotes: '', source: 'public', status,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', scheduledAt: new Date(),
        bookingTypeId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        createdAt: new Date(), updatedAt: new Date(),
      }));
    }

    it('should allow CANCELLED → CONFIRMED (re-claiming released capacity)', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const type = { _id: typeId, name: 'Test', isActive: true, capacity: 2,
        availabilityMode: 'ALWAYS', bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' }, dynamicFields: [] };
      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.CANCELLED });

      mockBookingModel.findById.mockResolvedValue(b);
      mockBookingTypeModel.findById.mockReturnValue(chainable(type));
      setupGetBookingByIdResponse(BOOKING_STATUSES.CONFIRMED);

      await bookingsService.updateBooking(b._id.toString(),
        { status: BOOKING_STATUSES.CONFIRMED }, 'admin1');
      expect(b.status).toBe(BOOKING_STATUSES.CONFIRMED);
    });

    it('should allow PENDING → CANCELLED with no capacity effect', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const key = `${typeId}||${FUTURE_DATE}||10:00`;
      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.PENDING });

      mockBookingModel.findById.mockResolvedValue(b);
      setupGetBookingByIdResponse(BOOKING_STATUSES.CANCELLED);

      await bookingsService.updateBooking(b._id.toString(),
        { status: BOOKING_STATUSES.CANCELLED }, 'admin1');
      expect(b.status).toBe(BOOKING_STATUSES.CANCELLED);
      // No counter created because neither from nor to status consumes capacity
      expect(counterStore.size).toBe(0);
    });

    it('should allow adminNotes update with no capacity effect', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const key = `${typeId}||${FUTURE_DATE}||10:00`;
      counterStore.set(key, {
        _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        slotDate: FUTURE_DATE, slotTime: '10:00', used: 1, capacity: 2,
      });
      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.CONFIRMED });

      mockBookingModel.findById.mockResolvedValue(b);
      setupGetBookingByIdResponse(BOOKING_STATUSES.CONFIRMED);

      await bookingsService.updateBooking(b._id.toString(),
        { adminNotes: 'Customer called' }, 'admin1');
      expect(b.adminNotes).toBe('Customer called');
      expect(b.status).toBe(BOOKING_STATUSES.CONFIRMED);
      expect(counterStore.get(key).used).toBe(1);
    });

    it('should allow COMPLETED → COMPLETED with no capacity change', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.COMPLETED });

      mockBookingModel.findById.mockResolvedValue(b);
      setupGetBookingByIdResponse(BOOKING_STATUSES.COMPLETED);

      await bookingsService.updateBooking(b._id.toString(),
        { status: BOOKING_STATUSES.COMPLETED, adminNotes: 'Done' }, 'admin1');
      expect(b.status).toBe(BOOKING_STATUSES.COMPLETED);
    });

    it('should handle PENDING → COMPLETED (claim capacity)', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const type = { _id: typeId, name: 'Test', isActive: true, capacity: 3,
        availabilityMode: 'ALWAYS', bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' }, dynamicFields: [] };
      const b = new mockBookingModel({ _id: new mongoose.Types.ObjectId(), bookingTypeId: typeId,
        scheduledDate: FUTURE_DATE, scheduledTime: '10:00', status: BOOKING_STATUSES.PENDING });

      mockBookingModel.findById.mockResolvedValue(b);
      mockBookingTypeModel.findById.mockReturnValue(chainable(type));
      setupGetBookingByIdResponse(BOOKING_STATUSES.COMPLETED);

      await bookingsService.updateBooking(b._id.toString(),
        { status: BOOKING_STATUSES.COMPLETED }, 'admin1');
      expect(b.status).toBe(BOOKING_STATUSES.COMPLETED);
    });
  });
});
