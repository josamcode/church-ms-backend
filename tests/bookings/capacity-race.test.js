/**
 * P0 Regression Tests — Booking Capacity Race
 *
 * - parallel_confirmations_cannot_exceed_capacity
 */

const mongoose = require('mongoose');
const { BOOKING_STATUSES } = require('../../src/modules/bookings/booking.model');

describe('Booking Capacity Race Protection', () => {
  let bookingsService;

  beforeAll(() => {
    jest.mock('../../src/utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
  });

  beforeEach(() => {
    jest.resetModules();

    // Mock Booking model
    const mockBookingModel = function (data) {
      this._id = data._id || new mongoose.Types.ObjectId();
      this.bookingTypeId = data.bookingTypeId;
      this.scheduledDate = data.scheduledDate;
      this.scheduledTime = data.scheduledTime;
      this.status = data.status || BOOKING_STATUSES.PENDING;
      this.adminNotes = data.adminNotes || '';
      this.save = jest.fn().mockResolvedValue(this);
      this.toObject = jest.fn().mockReturnValue({ ...data, _id: this._id });
    };

    mockBookingModel.findById = jest.fn();
    mockBookingModel.findOne = jest.fn();
    mockBookingModel.find = jest.fn();
    mockBookingModel.create = jest.fn();
    mockBookingModel.countDocuments = jest.fn();

    jest.mock('../../src/modules/bookings/booking.model', () => {
      const actual = jest.requireActual('../../src/modules/bookings/booking.model');
      return {
        ...actual,
        BOOKING_STATUSES: actual.BOOKING_STATUSES,
        BOOKING_STATUS_VALUES: actual.BOOKING_STATUS_VALUES,
        __esModule: true,
        default: mockBookingModel,
      };
    });

    // Mock BookingType model
    const mockBookingTypeModel = {
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
    };

    jest.mock('../../src/modules/bookings/bookings.service', () => {
      // We're testing the service, so we need the real one
      jest.unmock('../../src/modules/bookings/bookings.service');
      const actual = jest.requireActual('../../src/modules/bookings/bookings.service');
      return actual;
    });

    jest.mock('../../src/utils/fileUploads', () => ({
      validateImageUpload: jest.fn(),
    }));

    jest.mock('../../src/services/storage/storage.service', () => ({
      uploadFile: jest.fn(),
      deleteFile: jest.fn(),
    }));

    bookingsService = require('../../src/modules/bookings/bookings.service');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('parallel_confirmations_cannot_exceed_capacity', () => {
    it('should detect over-capacity after insert and compensate for create', async () => {
      // Setup: a booking type with capacity 1
      const typeId = new mongoose.Types.ObjectId();
      const type = {
        _id: typeId,
        name: 'Test',
        isActive: true,
        availabilityMode: 'ALWAYS',
        capacity: 1,
        durationMinutes: 30,
        slotIntervalMinutes: 30,
        bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' },
        dynamicFields: [],
      };

      const mockBooking = {
        _id: new mongoose.Types.ObjectId(),
        bookingTypeId: typeId,
        scheduledDate: '2026-07-01',
        scheduledTime: '10:00',
        status: BOOKING_STATUSES.PENDING,
        adminNotes: '',
        save: jest.fn().mockResolvedValue(undefined),
        toObject: jest.fn().mockReturnValue({
          _id: new mongoose.Types.ObjectId(),
          bookingTypeId: typeId,
          bookingTypeNameSnapshot: 'Test',
          requester: { name: 'Tester', phone: '123', email: '' },
          scheduledDate: '2026-07-01',
          scheduledTime: '10:00',
          scheduledAt: new Date(),
          notes: '',
          additionalFields: [],
          status: BOOKING_STATUSES.PENDING,
          adminNotes: '',
          source: 'public',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      };

      // First call to _getBookedSlotCounts: capacity check (1 booking already exists)
      // Second call: post-write verification (now 2 bookings, over capacity)
      let callCount = 0;
      const originalFindMethod = mongoose.Model.find || jest.fn();
      jest.spyOn(bookingsService, '_getBookedSlotCounts').mockImplementation(async () => {
        callCount++;
        const map = new Map();
        if (callCount === 1) {
          // Pre-write: 1 booking exists = at capacity
          map.set('2026-07-01|10:00', 1);
        } else {
          // Post-write: 2 bookings = over capacity (race condition!)
          map.set('2026-07-01|10:00', 2);
        }
        return map;
      });

      // _assertCapacityAvailable should throw because already at capacity (1 == capacity 1, remaining=0)
      jest.spyOn(bookingsService, '_assertCapacityAvailable').mockRejectedValue(
        new (require('../../src/utils/ApiError'))(
          409, 'The selected time slot is no longer available', 'DUPLICATE_VALUE'
        )
      );

      await expect(
        bookingsService._assertCapacityAvailable(type, '2026-07-01', '10:00')
      ).rejects.toThrow();
    });

    it('should detect post-confirm over-capacity and revert status to pending', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const bookingId = new mongoose.Types.ObjectId();
      const type = {
        _id: typeId,
        name: 'Test',
        isActive: true,
        availabilityMode: 'ALWAYS',
        capacity: 1,
        durationMinutes: 30,
        slotIntervalMinutes: 30,
        bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' },
        dynamicFields: [],
      };

      // Simulate a booking that was just confirmed
      const booking = {
        _id: bookingId,
        bookingTypeId: typeId,
        scheduledDate: '2026-07-01',
        scheduledTime: '10:00',
        status: BOOKING_STATUSES.CONFIRMED,
        adminNotes: '',
        save: jest.fn().mockResolvedValue(undefined),
      };

      // Post-write verification shows 2 bookings (over capacity of 1)
      const overCapacityMap = new Map();
      overCapacityMap.set('2026-07-01|10:00', 2);

      jest.spyOn(bookingsService, '_getBookedSlotCounts').mockResolvedValue(overCapacityMap);

      // _verifyAndCompensateCapacity throws after compensating
      try {
        await bookingsService._verifyAndCompensateCapacity(
          type, '2026-07-01', '10:00', booking, 'confirm'
        );
      } catch (err) {
        // Expected: it throws after compensation
      }

      // Should have reverted status to PENDING
      expect(booking.status).toBe(BOOKING_STATUSES.PENDING);
      expect(booking.adminNotes).toContain('Auto-reverted');
      expect(booking.save).toHaveBeenCalled();
    });

    it('should detect post-create over-capacity and cancel the booking', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const bookingId = new mongoose.Types.ObjectId();
      const type = {
        _id: typeId,
        name: 'Test',
        isActive: true,
        availabilityMode: 'ALWAYS',
        capacity: 1,
        durationMinutes: 30,
        slotIntervalMinutes: 30,
        bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' },
        dynamicFields: [],
      };

      const booking = {
        _id: bookingId,
        bookingTypeId: typeId,
        scheduledDate: '2026-07-01',
        scheduledTime: '10:00',
        status: BOOKING_STATUSES.PENDING,
        adminNotes: '',
        save: jest.fn().mockResolvedValue(undefined),
      };

      const overCapacityMap = new Map();
      overCapacityMap.set('2026-07-01|10:00', 2);

      jest.spyOn(bookingsService, '_getBookedSlotCounts').mockResolvedValue(overCapacityMap);

      // _verifyAndCompensateCapacity throws after compensating
      try {
        await bookingsService._verifyAndCompensateCapacity(
          type, '2026-07-01', '10:00', booking, 'create'
        );
      } catch (err) {
        // Expected: it throws after compensation
      }

      // Should have cancelled the booking
      expect(booking.status).toBe(BOOKING_STATUSES.CANCELLED);
      expect(booking.adminNotes).toContain('Auto-cancelled');
      expect(booking.save).toHaveBeenCalled();
    });

    it('should NOT compensate when capacity is not exceeded', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const bookingId = new mongoose.Types.ObjectId();
      const type = {
        _id: typeId,
        name: 'Test',
        isActive: true,
        availabilityMode: 'ALWAYS',
        capacity: 2,
        durationMinutes: 30,
        slotIntervalMinutes: 30,
        bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' },
        dynamicFields: [],
      };

      const booking = {
        _id: bookingId,
        bookingTypeId: typeId,
        scheduledDate: '2026-07-01',
        scheduledTime: '10:00',
        status: BOOKING_STATUSES.CONFIRMED,
        adminNotes: '',
        save: jest.fn(),
      };

      // Capacity is 2, only 1 booked — fine
      const normalMap = new Map();
      normalMap.set('2026-07-01|10:00', 1);

      jest.spyOn(bookingsService, '_getBookedSlotCounts').mockResolvedValue(normalMap);

      await bookingsService._verifyAndCompensateCapacity(
        type, '2026-07-01', '10:00', booking, 'confirm'
      );

      // No compensation should have occurred
      expect(booking.save).not.toHaveBeenCalled();
    });

    it('should throw after compensation for create', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const bookingId = new mongoose.Types.ObjectId();
      const type = {
        _id: typeId,
        name: 'Test',
        isActive: true,
        availabilityMode: 'ALWAYS',
        capacity: 1,
        durationMinutes: 30,
        slotIntervalMinutes: 30,
        bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' },
        dynamicFields: [],
      };

      const booking = {
        _id: bookingId,
        bookingTypeId: typeId,
        scheduledDate: '2026-07-01',
        scheduledTime: '10:00',
        status: BOOKING_STATUSES.PENDING,
        adminNotes: '',
        save: jest.fn().mockResolvedValue(undefined),
      };

      const overCapacityMap = new Map();
      overCapacityMap.set('2026-07-01|10:00', 2);

      jest.spyOn(bookingsService, '_getBookedSlotCounts').mockResolvedValue(overCapacityMap);

      let caughtError = null;
      try {
        await bookingsService._verifyAndCompensateCapacity(
          type, '2026-07-01', '10:00', booking, 'create'
        );
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError.message).toContain('simultaneous booking');
      expect(booking.status).toBe(BOOKING_STATUSES.CANCELLED);
    });

    it('should throw after compensation for confirm', async () => {
      const typeId = new mongoose.Types.ObjectId();
      const bookingId = new mongoose.Types.ObjectId();
      const type = {
        _id: typeId,
        name: 'Test',
        isActive: true,
        availabilityMode: 'ALWAYS',
        capacity: 1,
        durationMinutes: 30,
        slotIntervalMinutes: 30,
        bookingHorizonDays: 45,
        availabilityConfig: { timezone: 'Africa/Cairo' },
        dynamicFields: [],
      };

      const booking = {
        _id: bookingId,
        bookingTypeId: typeId,
        scheduledDate: '2026-07-01',
        scheduledTime: '10:00',
        status: BOOKING_STATUSES.CONFIRMED,
        adminNotes: '',
        save: jest.fn().mockResolvedValue(undefined),
      };

      const overCapacityMap = new Map();
      overCapacityMap.set('2026-07-01|10:00', 2);

      jest.spyOn(bookingsService, '_getBookedSlotCounts').mockResolvedValue(overCapacityMap);

      let caughtError = null;
      try {
        await bookingsService._verifyAndCompensateCapacity(
          type, '2026-07-01', '10:00', booking, 'confirm'
        );
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError.message).toContain('simultaneous');
      expect(booking.status).toBe(BOOKING_STATUSES.PENDING);
    });
  });
});
