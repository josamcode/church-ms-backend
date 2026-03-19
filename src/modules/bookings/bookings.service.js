const mongoose = require('mongoose');
const cloudinary = require('../../config/cloudinary');
const streamifier = require('streamifier');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const ApiError = require('../../utils/ApiError');
const BookingType = require('./bookingType.model');
const Booking = require('./booking.model');

const { AVAILABILITY_MODES, FIELD_TYPES } = BookingType;
const { BOOKING_STATUSES } = Booking;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

class BookingsService {
  _toObjectId(id, fieldName = 'id') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return new mongoose.Types.ObjectId(id);
  }

  _isValidDateString(value) {
    return DATE_PATTERN.test(String(value || ''));
  }

  _isValidTimeString(value) {
    return TIME_PATTERN.test(String(value || ''));
  }

  _createUtcDate(dateStr, timeStr = '00:00') {
    if (!this._isValidDateString(dateStr) || !this._isValidTimeString(timeStr)) {
      return null;
    }

    const [year, month, day] = dateStr.split('-').map(Number);
    const [hours, minutes] = timeStr.split(':').map(Number);
    return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
  }

  _addDays(dateStr, days) {
    const date = this._createUtcDate(dateStr, '00:00');
    if (!date) return null;
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  _getTodayDateString() {
    return new Date().toISOString().slice(0, 10);
  }

  _normalizeDateInput(dateStr) {
    if (this._isValidDateString(dateStr)) return dateStr;
    return this._getTodayDateString();
  }

  _timeToMinutes(timeStr) {
    const [hours, minutes] = String(timeStr).split(':').map(Number);
    return hours * 60 + minutes;
  }

  _minutesToTime(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60)
      .toString()
      .padStart(2, '0');
    const minutes = (totalMinutes % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  _dedupeStrings(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
  }

  _generateTimesFromRange(startTime, endTime, intervalMinutes, durationMinutes) {
    if (!this._isValidTimeString(startTime) || !this._isValidTimeString(endTime)) {
      return [];
    }

    const start = this._timeToMinutes(startTime);
    const end = this._timeToMinutes(endTime);
    if (start >= end) return [];

    const safeInterval = Math.max(Number(intervalMinutes) || 30, 5);
    const safeDuration = Math.max(Number(durationMinutes) || safeInterval, 5);
    const times = [];

    for (let current = start; current + safeDuration <= end; current += safeInterval) {
      times.push(this._minutesToTime(current));
    }

    return times;
  }

  _buildDateRange(startDate, endDate) {
    if (!this._isValidDateString(startDate) || !this._isValidDateString(endDate) || startDate > endDate) {
      return [];
    }

    const dates = [];
    for (let date = startDate; date && date <= endDate; date = this._addDays(date, 1)) {
      dates.push(date);
    }
    return dates;
  }

  _resolveSearchWindow(type, fromDate, days) {
    const safeFromDate = this._normalizeDateInput(fromDate);
    const safeDays = Math.max(Math.min(Number(days) || type.bookingHorizonDays || 45, 120), 1);
    const horizon = Math.max(Number(type.bookingHorizonDays) || safeDays, 1);
    const finalDays = Math.min(safeDays, horizon);
    const toDate = this._addDays(safeFromDate, finalDays - 1);

    return {
      fromDate: safeFromDate,
      toDate,
      safeDays: finalDays,
    };
  }

  _mapFieldDefinition(field) {
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      required: !!field.required,
      placeholder: field.placeholder || '',
      helpText: field.helpText || '',
      options: Array.isArray(field.options)
        ? field.options.map((option) => ({
            label: option.label,
            value: option.value,
          }))
        : [],
    };
  }

  _mapBookingType(type, { includeAvailabilityConfig = true } = {}) {
    return {
      id: type._id,
      name: type.name,
      description: type.description || '',
      instructions: type.instructions || '',
      isActive: type.isActive !== false,
      availabilityMode: type.availabilityMode,
      durationMinutes: type.durationMinutes,
      slotIntervalMinutes: type.slotIntervalMinutes,
      capacity: type.capacity,
      bookingHorizonDays: type.bookingHorizonDays,
      availabilityConfig: includeAvailabilityConfig
        ? {
            timezone: type.availabilityConfig?.timezone || 'Africa/Cairo',
            timeRange: type.availabilityConfig?.timeRange || {},
            dateRange: type.availabilityConfig?.dateRange || {},
            specificDays: Array.isArray(type.availabilityConfig?.specificDays)
              ? type.availabilityConfig.specificDays
              : [],
            specificDates: Array.isArray(type.availabilityConfig?.specificDates)
              ? type.availabilityConfig.specificDates.map((entry) => ({
                  date: entry.date,
                  startTime: entry.startTime || '',
                  endTime: entry.endTime || '',
                  exactTimes: Array.isArray(entry.exactTimes) ? entry.exactTimes : [],
                }))
              : [],
            exactDateTimes: Array.isArray(type.availabilityConfig?.exactDateTimes)
              ? type.availabilityConfig.exactDateTimes.map((entry) => ({
                  date: entry.date,
                  time: entry.time,
                }))
              : [],
          }
        : undefined,
      dynamicFields: Array.isArray(type.dynamicFields)
        ? type.dynamicFields.map((field) => this._mapFieldDefinition(field))
        : [],
      createdAt: type.createdAt,
      updatedAt: type.updatedAt,
    };
  }

  _mapBooking(booking) {
    const bookingType = booking.bookingTypeId || null;
    const typeIsPopulated = bookingType && typeof bookingType === 'object' && bookingType.name;
    const bookingTypeId = typeIsPopulated ? bookingType._id : booking.bookingTypeId;

    return {
      id: booking._id,
      bookingType: {
        id: bookingTypeId || null,
        name: typeIsPopulated ? bookingType.name : booking.bookingTypeNameSnapshot,
      },
      requester: {
        name: booking.requester?.name || '',
        phone: booking.requester?.phone || '',
        email: booking.requester?.email || '',
      },
      scheduledDate: booking.scheduledDate,
      scheduledTime: booking.scheduledTime || '',
      scheduledAt: booking.scheduledAt,
      notes: booking.notes || '',
      additionalFields: Array.isArray(booking.additionalFields)
        ? booking.additionalFields.map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            value: field.value ?? null,
          }))
        : [],
      status: booking.status,
      adminNotes: booking.adminNotes || '',
      source: booking.source || 'public',
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
    };
  }

  _getTypeSpecificDateMap(type) {
    const entries = Array.isArray(type.availabilityConfig?.specificDates)
      ? type.availabilityConfig.specificDates
      : [];
    return new Map(
      entries
        .filter((entry) => this._isValidDateString(entry.date))
        .map((entry) => [entry.date, entry])
    );
  }

  _isExactTimeMode(mode) {
    return (
      mode === AVAILABILITY_MODES.SPECIFIC_DATES_TIME ||
      mode === AVAILABILITY_MODES.DATE_TIME
    );
  }

  _modeRequiresTime(mode) {
    return (
      mode === AVAILABILITY_MODES.DATE_TIME_RANGE ||
      mode === AVAILABILITY_MODES.SPECIFIC_DAYS_TIME ||
      this._isExactTimeMode(mode)
    );
  }

  _getExactTimesForDate(type, dateStr) {
    const specificDateTimes = (Array.isArray(type.availabilityConfig?.specificDates)
      ? type.availabilityConfig.specificDates
      : [])
      .filter((entry) => entry.date === dateStr)
      .flatMap((entry) => (Array.isArray(entry.exactTimes) ? entry.exactTimes : []));

    const legacyDateTimes = (Array.isArray(type.availabilityConfig?.exactDateTimes)
      ? type.availabilityConfig.exactDateTimes
      : [])
      .filter((entry) => entry.date === dateStr)
      .map((entry) => entry.time);

    return this._dedupeStrings(
      [...specificDateTimes, ...legacyDateTimes].filter((time) => this._isValidTimeString(time))
    ).sort();
  }

  _getSpecificConfiguredDates(type) {
    const datesFromSpecificDates = (Array.isArray(type.availabilityConfig?.specificDates)
      ? type.availabilityConfig.specificDates
      : [])
      .map((entry) => entry.date);

    const datesFromLegacyDateTimes = (Array.isArray(type.availabilityConfig?.exactDateTimes)
      ? type.availabilityConfig.exactDateTimes
      : [])
      .map((entry) => entry.date);

    return this._dedupeStrings(
      [...datesFromSpecificDates, ...datesFromLegacyDateTimes].filter((date) =>
        this._isValidDateString(date)
      )
    ).sort();
  }

  _isWithinTimeRange(timeStr, timeRange = {}) {
    if (!timeRange?.startTime || !timeRange?.endTime) return true;
    if (!this._isValidTimeString(timeStr)) return false;
    return timeStr >= timeRange.startTime && timeStr <= timeRange.endTime;
  }

  _isWithinDateRange(dateStr, dateRange = {}) {
    if (!this._isValidDateString(dateStr)) return false;
    if (dateRange?.startDate && dateStr < dateRange.startDate) return false;
    if (dateRange?.endDate && dateStr > dateRange.endDate) return false;
    return true;
  }

  _isWithinHorizon(type, dateStr) {
    if (!this._isValidDateString(dateStr)) return false;

    const fromDate = this._getTodayDateString();
    const horizonDays = Math.max(Number(type.bookingHorizonDays) || 365, 1);
    const toDate = this._addDays(fromDate, horizonDays - 1);

    return dateStr >= fromDate && dateStr <= toDate;
  }

  _getBaseTimesForDate(type, dateStr) {
    const config = type.availabilityConfig || {};
    const timeRange = config.timeRange || {};
    const specificDateEntry = this._getTypeSpecificDateMap(type).get(dateStr);

    if (specificDateEntry) {
      if (Array.isArray(specificDateEntry.exactTimes) && specificDateEntry.exactTimes.length > 0) {
        return this._dedupeStrings(specificDateEntry.exactTimes.filter((time) => this._isValidTimeString(time))).sort();
      }

      const startTime = specificDateEntry.startTime || timeRange.startTime;
      const endTime = specificDateEntry.endTime || timeRange.endTime;
      return this._generateTimesFromRange(
        startTime,
        endTime,
        type.slotIntervalMinutes,
        type.durationMinutes
      );
    }

    return this._generateTimesFromRange(
      timeRange.startTime,
      timeRange.endTime,
      type.slotIntervalMinutes,
      type.durationMinutes
    );
  }

  _getAvailableDateCandidates(type, fromDate, toDate) {
    const config = type.availabilityConfig || {};

    switch (type.availabilityMode) {
      case AVAILABILITY_MODES.ALWAYS:
        return this._buildDateRange(fromDate, toDate);

      case AVAILABILITY_MODES.DATE_RANGE: {
        const startDate = config.dateRange?.startDate || fromDate;
        const endDate = config.dateRange?.endDate || toDate;
        const effectiveStart = startDate > fromDate ? startDate : fromDate;
        const effectiveEnd = endDate < toDate ? endDate : toDate;
        return this._buildDateRange(effectiveStart, effectiveEnd);
      }

      case AVAILABILITY_MODES.DATE_TIME_RANGE: {
        const startDate = config.dateRange?.startDate || fromDate;
        const endDate = config.dateRange?.endDate || toDate;
        const effectiveStart = startDate > fromDate ? startDate : fromDate;
        const effectiveEnd = endDate < toDate ? endDate : toDate;
        return this._buildDateRange(effectiveStart, effectiveEnd);
      }

      case AVAILABILITY_MODES.SPECIFIC_DAYS: {
        const specificDays = new Set(
          Array.isArray(config.specificDays) ? config.specificDays.map(Number) : []
        );
        return this._buildDateRange(fromDate, toDate).filter((dateStr) => {
          const date = this._createUtcDate(dateStr, '00:00');
          return date && specificDays.has(date.getUTCDay());
        });
      }

      case AVAILABILITY_MODES.SPECIFIC_DAYS_TIME: {
        const specificDays = new Set(
          Array.isArray(config.specificDays) ? config.specificDays.map(Number) : []
        );
        return this._buildDateRange(fromDate, toDate).filter((dateStr) => {
          const date = this._createUtcDate(dateStr, '00:00');
          return date && specificDays.has(date.getUTCDay());
        });
      }

      case AVAILABILITY_MODES.SPECIFIC_DATES:
        return this._getSpecificConfiguredDates(type)
          .filter((dateStr) => dateStr >= fromDate && dateStr <= toDate)
          .sort();

      case AVAILABILITY_MODES.SPECIFIC_DATES_TIME:
      case AVAILABILITY_MODES.DATE_TIME:
        return this._getSpecificConfiguredDates(type)
          .filter((dateStr) => dateStr >= fromDate && dateStr <= toDate)
          .sort();

      case AVAILABILITY_MODES.NONE:
      default:
        return [];
    }
  }

  async _getBookedSlotCounts(bookingTypeId, fromDate, toDate) {
    const fromScheduledAt = this._createUtcDate(fromDate, '00:00');
    const toScheduledAt = this._createUtcDate(toDate, '23:59');
    const bookings = await Booking.find({
      bookingTypeId: this._toObjectId(bookingTypeId, 'bookingTypeId'),
      status: { $ne: BOOKING_STATUSES.CANCELLED },
      scheduledAt: {
        $gte: fromScheduledAt,
        $lte: toScheduledAt,
      },
    })
      .select('scheduledDate scheduledTime')
      .lean();

    const counts = new Map();
    bookings.forEach((booking) => {
      const key = `${booking.scheduledDate}|${booking.scheduledTime || ''}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }

  async _buildSlotsForType(type, { fromDate, toDate }) {
    const bookedCounts = await this._getBookedSlotCounts(type._id, fromDate, toDate);
    const candidateDates = this._getAvailableDateCandidates(type, fromDate, toDate);
    const groupedSlots = [];

    for (const date of candidateDates) {
      const times =
        this._isExactTimeMode(type.availabilityMode)
          ? this._getExactTimesForDate(type, date)
          : this._getBaseTimesForDate(type, date);

      if (!times.length) continue;

      const slots = times
        .map((time) => {
          const booked = bookedCounts.get(`${date}|${time}`) || 0;
          const remaining = Math.max((type.capacity || 1) - booked, 0);
          return {
            date,
            time,
            remaining,
            isAvailable: remaining > 0,
          };
        })
        .filter((slot) => slot.isAvailable);

      if (slots.length > 0) {
        groupedSlots.push({
          date,
          slots,
        });
      }
    }

    return groupedSlots;
  }

  async listPublicBookingTypes() {
    const types = await BookingType.find({ isActive: true }).sort({ name: 1 }).lean();
    return types.map((type) => this._mapBookingType(type, { includeAvailabilityConfig: true }));
  }

  async listBookingTypes() {
    const types = await BookingType.find().sort({ createdAt: -1, name: 1 }).lean();
    return types.map((type) => this._mapBookingType(type));
  }

  async createBookingType(payload, actorUserId) {
    const normalizedName = String(payload.name || '').trim().toLowerCase();
    const existing = await BookingType.findOne({ normalizedName }).lean();
    if (existing) {
      throw ApiError.conflict('Booking type already exists', 'DUPLICATE_VALUE');
    }

    const created = await BookingType.create({
      ...payload,
      name: String(payload.name || '').trim(),
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    return this._mapBookingType(created.toObject());
  }

  async updateBookingType(id, payload, actorUserId) {
    const bookingType = await BookingType.findById(this._toObjectId(id));
    if (!bookingType) {
      throw ApiError.notFound('Booking type not found', 'RESOURCE_NOT_FOUND');
    }

    const normalizedName = String(payload.name || '').trim().toLowerCase();
    const duplicate = await BookingType.findOne({
      normalizedName,
      _id: { $ne: bookingType._id },
    }).lean();
    if (duplicate) {
      throw ApiError.conflict('Booking type already exists', 'DUPLICATE_VALUE');
    }

    bookingType.name = String(payload.name || '').trim();
    bookingType.description = payload.description || undefined;
    bookingType.instructions = payload.instructions || undefined;
    bookingType.isActive = payload.isActive !== false;
    bookingType.availabilityMode = payload.availabilityMode;
    bookingType.durationMinutes = payload.durationMinutes;
    bookingType.slotIntervalMinutes = payload.slotIntervalMinutes;
    bookingType.capacity = payload.capacity;
    bookingType.bookingHorizonDays = payload.bookingHorizonDays;
    bookingType.availabilityConfig = payload.availabilityConfig || {};
    bookingType.dynamicFields = Array.isArray(payload.dynamicFields) ? payload.dynamicFields : [];
    bookingType.updatedBy = actorUserId;

    await bookingType.save();
    return this._mapBookingType(bookingType.toObject());
  }

  async getPublicSlots(bookingTypeId, { fromDate, days }) {
    const type = await BookingType.findById(this._toObjectId(bookingTypeId)).lean();
    if (!type || !type.isActive) {
      throw ApiError.notFound('Booking type not found', 'RESOURCE_NOT_FOUND');
    }

    const { fromDate: safeFromDate, toDate } = this._resolveSearchWindow(type, fromDate, days);
    const groupedSlots = await this._buildSlotsForType(type, {
      fromDate: safeFromDate,
      toDate,
    });

    return {
      bookingType: this._mapBookingType(type, { includeAvailabilityConfig: false }),
      fromDate: safeFromDate,
      toDate,
      dates: groupedSlots,
    };
  }

  async _resolveBookableType(bookingTypeId) {
    const type = await BookingType.findById(this._toObjectId(bookingTypeId)).lean();
    if (!type || !type.isActive) {
      throw ApiError.notFound('Booking type not found', 'RESOURCE_NOT_FOUND');
    }
    return type;
  }

  _validateFieldValue(definition, rawValue) {
    const value = rawValue ?? null;

    if (definition.required) {
      const isEmptyString = typeof value === 'string' && value.trim() === '';
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      const isEmptyObject =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0;

      if (value === null || value === undefined || isEmptyString || isEmptyArray || isEmptyObject) {
        throw ApiError.badRequest(`${definition.label} is required`, 'VALIDATION_ERROR');
      }
    }

    if (value === null || value === undefined || value === '') {
      return null;
    }

    switch (definition.type) {
      case FIELD_TYPES.TEXT:
      case FIELD_TYPES.TEXTAREA:
      case FIELD_TYPES.EMAIL:
      case FIELD_TYPES.PHONE:
      case FIELD_TYPES.DATE: {
        const normalized = String(value).trim();
        if (!normalized) return null;
        if (definition.type === FIELD_TYPES.EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
          throw ApiError.badRequest(`${definition.label} must be a valid email`, 'VALIDATION_ERROR');
        }
        if (definition.type === FIELD_TYPES.DATE && !this._isValidDateString(normalized)) {
          throw ApiError.badRequest(`${definition.label} must be a valid date`, 'VALIDATION_ERROR');
        }
        return normalized;
      }

      case FIELD_TYPES.NUMBER: {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
          throw ApiError.badRequest(`${definition.label} must be a valid number`, 'VALIDATION_ERROR');
        }
        return numericValue;
      }

      case FIELD_TYPES.CHECKBOX:
        return Boolean(value);

      case FIELD_TYPES.SELECT: {
        const normalized = String(value).trim();
        const options = new Set((definition.options || []).map((option) => option.value));
        if (!options.has(normalized)) {
          throw ApiError.badRequest(`${definition.label} has an invalid option`, 'VALIDATION_ERROR');
        }
        return normalized;
      }

      case FIELD_TYPES.IMAGE: {
        if (!value || typeof value !== 'object' || !value.url) {
          throw ApiError.badRequest(`${definition.label} requires an uploaded image`, 'VALIDATION_ERROR');
        }
        return {
          url: String(value.url).trim(),
          publicId: value.publicId ? String(value.publicId).trim() : '',
        };
      }

      default:
        return value;
    }
  }

  _normalizeAdditionalFields(type, submittedFields = []) {
    const definitionMap = new Map(
      (Array.isArray(type.dynamicFields) ? type.dynamicFields : []).map((field) => [field.key, field])
    );

    const submittedMap = new Map(
      (Array.isArray(submittedFields) ? submittedFields : []).map((field) => [field.key, field?.value])
    );

    return [...definitionMap.values()].map((definition) => ({
      key: definition.key,
      label: definition.label,
      type: definition.type,
      value: this._validateFieldValue(definition, submittedMap.get(definition.key)),
    }));
  }

  async _assertCapacityAvailable(type, scheduledDate, scheduledTime) {
    const bookedCounts = await this._getBookedSlotCounts(type._id, scheduledDate, scheduledDate);
    const booked = bookedCounts.get(`${scheduledDate}|${scheduledTime || ''}`) || 0;
    const remaining = Math.max((type.capacity || 1) - booked, 0);

    if (remaining <= 0) {
      throw ApiError.conflict('The selected time slot is no longer available', 'DUPLICATE_VALUE');
    }
  }

  _assertRequestedScheduleAllowed(type, scheduledDate, scheduledTime) {
    if (!this._isValidDateString(scheduledDate)) {
      throw ApiError.badRequest('Scheduled slot is invalid', 'VALIDATION_ERROR');
    }

    const requiresTime = this._modeRequiresTime(type.availabilityMode);
    if (requiresTime && !this._isValidTimeString(scheduledTime)) {
      throw ApiError.badRequest('Scheduled slot is invalid', 'VALIDATION_ERROR');
    }

    if (!this._isWithinHorizon(type, scheduledDate)) {
      throw ApiError.badRequest('Selected date is outside the allowed booking window', 'VALIDATION_ERROR');
    }

    const config = type.availabilityConfig || {};

    switch (type.availabilityMode) {
      case AVAILABILITY_MODES.ALWAYS:
        return;

      case AVAILABILITY_MODES.DATE_RANGE:
        if (!this._isWithinDateRange(scheduledDate, config.dateRange)) {
          throw ApiError.badRequest('Selected date is not available for this booking type', 'VALIDATION_ERROR');
        }
        return;

      case AVAILABILITY_MODES.DATE_TIME_RANGE:
        if (!this._isWithinDateRange(scheduledDate, config.dateRange)) {
          throw ApiError.badRequest('Selected date is not available for this booking type', 'VALIDATION_ERROR');
        }
        if (!this._isWithinTimeRange(scheduledTime, config.timeRange)) {
          throw ApiError.badRequest('Selected time is not available for this booking type', 'VALIDATION_ERROR');
        }
        return;

      case AVAILABILITY_MODES.SPECIFIC_DAYS: {
        const allowedDays = new Set(Array.isArray(config.specificDays) ? config.specificDays.map(Number) : []);
        const date = this._createUtcDate(scheduledDate, '00:00');
        if (!date || !allowedDays.has(date.getUTCDay())) {
          throw ApiError.badRequest('Selected date is not available for this booking type', 'VALIDATION_ERROR');
        }
        return;
      }

      case AVAILABILITY_MODES.SPECIFIC_DAYS_TIME: {
        const allowedDays = new Set(Array.isArray(config.specificDays) ? config.specificDays.map(Number) : []);
        const date = this._createUtcDate(scheduledDate, '00:00');
        if (!date || !allowedDays.has(date.getUTCDay())) {
          throw ApiError.badRequest('Selected date is not available for this booking type', 'VALIDATION_ERROR');
        }
        if (!this._isWithinTimeRange(scheduledTime, config.timeRange)) {
          throw ApiError.badRequest('Selected time is not available for this booking type', 'VALIDATION_ERROR');
        }
        return;
      }

      case AVAILABILITY_MODES.SPECIFIC_DATES:
        if (!this._getSpecificConfiguredDates(type).includes(scheduledDate)) {
          throw ApiError.badRequest('Selected date is not available for this booking type', 'VALIDATION_ERROR');
        }
        return;

      case AVAILABILITY_MODES.SPECIFIC_DATES_TIME:
      case AVAILABILITY_MODES.DATE_TIME: {
        const exactTimes = this._getExactTimesForDate(type, scheduledDate);
        if (!exactTimes.length || !exactTimes.includes(scheduledTime)) {
          throw ApiError.badRequest('Selected time is not available for this booking type', 'VALIDATION_ERROR');
        }
        return;
      }

      case AVAILABILITY_MODES.NONE:
      default:
        throw ApiError.badRequest('This booking type is not currently available', 'VALIDATION_ERROR');
    }
  }

  async createPublicBooking(payload, actorUserId = null) {
    const type = await this._resolveBookableType(payload.bookingTypeId);

    if (type.availabilityMode === AVAILABILITY_MODES.NONE) {
      throw ApiError.badRequest('This booking type is not currently available', 'VALIDATION_ERROR');
    }

    const scheduledTime = this._modeRequiresTime(type.availabilityMode)
      ? payload.scheduledTime
      : null;

    this._assertRequestedScheduleAllowed(type, payload.scheduledDate, scheduledTime);
    await this._assertCapacityAvailable(type, payload.scheduledDate, scheduledTime);

    const scheduledAt = this._createUtcDate(payload.scheduledDate, scheduledTime || '00:00');
    if (!scheduledAt) {
      throw ApiError.badRequest('Scheduled slot is invalid', 'VALIDATION_ERROR');
    }

    const additionalFields = this._normalizeAdditionalFields(type, payload.dynamicFields);

    const created = await Booking.create({
      bookingTypeId: type._id,
      bookingTypeNameSnapshot: type.name,
      requester: {
        name: payload.requesterName.trim(),
        phone: payload.requesterPhone.trim(),
        email: payload.requesterEmail ? payload.requesterEmail.trim().toLowerCase() : undefined,
      },
      scheduledDate: payload.scheduledDate,
      scheduledTime,
      scheduledAt,
      notes: payload.notes || undefined,
      additionalFields,
      createdBy: actorUserId || undefined,
      source: 'public',
    });

    return this._mapBooking(created.toObject());
  }

  async listBookings({
    cursor,
    limit = 20,
    order = 'desc',
    filters = {},
    viewerUserId = null,
    ownOnly = false,
  }) {
    const query = {};
    const andConditions = [];

    if (ownOnly) {
      query.createdBy = this._toObjectId(viewerUserId, 'viewerUserId');
    }

    if (filters.bookingTypeId) {
      query.bookingTypeId = this._toObjectId(filters.bookingTypeId, 'bookingTypeId');
    }

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.q) {
      andConditions.push({
        $or: [
          { bookingTypeNameSnapshot: { $regex: filters.q, $options: 'i' } },
          { 'requester.name': { $regex: filters.q, $options: 'i' } },
          { 'requester.phone': { $regex: filters.q, $options: 'i' } },
          { 'requester.email': { $regex: filters.q, $options: 'i' } },
          { notes: { $regex: filters.q, $options: 'i' } },
        ],
      });
    }

    const scheduledAtQuery = {};
    if (filters.dateFrom) {
      const dateFrom = this._createUtcDate(filters.dateFrom, '00:00');
      if (dateFrom) scheduledAtQuery.$gte = dateFrom;
    }
    if (filters.dateTo) {
      const dateTo = this._createUtcDate(filters.dateTo, '23:59');
      if (dateTo) scheduledAtQuery.$lte = dateTo;
    }
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        scheduledAtQuery[order === 'desc' ? '$lt' : '$gt'] = cursorDate;
      }
    }

    if (Object.keys(scheduledAtQuery).length > 0) {
      query.scheduledAt = scheduledAtQuery;
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    const sortDirection = order === 'desc' ? -1 : 1;
    const totalCount = await Booking.countDocuments(query);
    const bookings = await Booking.find(query)
      .sort({ scheduledAt: sortDirection, _id: sortDirection })
      .limit(limit)
      .populate('bookingTypeId', 'name')
      .lean();

    const hasMore = bookings.length === limit;
    const lastItem = bookings[bookings.length - 1];

    return {
      bookings: bookings.map((booking) => this._mapBooking(booking)),
      meta: {
        limit,
        hasMore,
        nextCursor:
          hasMore && lastItem?.scheduledAt ? new Date(lastItem.scheduledAt).toISOString() : null,
        count: bookings.length,
        totalCount,
      },
    };
  }

  async getBookingById(id, { viewerUserId = null, ownOnly = false } = {}) {
    const query = { _id: this._toObjectId(id) };
    if (ownOnly) {
      query.createdBy = this._toObjectId(viewerUserId, 'viewerUserId');
    }

    const booking = await Booking.findOne(query)
      .populate('bookingTypeId', 'name')
      .lean();

    if (!booking) {
      throw ApiError.notFound('Booking not found', 'RESOURCE_NOT_FOUND');
    }

    return this._mapBooking(booking);
  }

  async updateBooking(id, payload, actorUserId) {
    const booking = await Booking.findById(this._toObjectId(id));
    if (!booking) {
      throw ApiError.notFound('Booking not found', 'RESOURCE_NOT_FOUND');
    }

    if (payload.status !== undefined) {
      booking.status = payload.status;
    }

    if (payload.adminNotes !== undefined) {
      booking.adminNotes = payload.adminNotes || undefined;
    }

    booking.updatedBy = actorUserId;
    await booking.save();

    return this.getBookingById(booking._id);
  }

  async uploadImageToCloudinary(file) {
    if (!file) {
      throw ApiError.badRequest('Image file is required', 'UPLOAD_FAILED');
    }

    if (!config.upload.allowedImageTypes.includes(file.mimetype)) {
      throw ApiError.badRequest(
        'File type is not allowed. Allowed types: JPEG, PNG, GIF, WEBP',
        'UPLOAD_INVALID_TYPE'
      );
    }

    if (file.size > config.upload.maxFileSize) {
      throw ApiError.badRequest(
        `File exceeds size limit (${Math.round(config.upload.maxFileSize / 1024 / 1024)} MB)`,
        'UPLOAD_FILE_TOO_LARGE'
      );
    }

    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'church/bookings',
          resource_type: 'image',
          transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        },
        (error, result) => {
          if (error) {
            logger.error(`Cloudinary booking image upload error: ${error.message}`);
            reject(ApiError.internal('Failed to upload booking image'));
            return;
          }

          resolve(result);
        }
      );

      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });

    return {
      url: uploadResult.secure_url,
      publicId: uploadResult.public_id,
    };
  }
}

module.exports = new BookingsService();
