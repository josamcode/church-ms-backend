const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const bookingsService = require('./bookings.service');

const listPublicBookingTypes = asyncHandler(async (_req, res) => {
  const types = await bookingsService.listPublicBookingTypes();
  return ApiResponse.success(res, {
    message: 'Booking types loaded successfully',
    data: types,
  });
});

const getPublicSlots = asyncHandler(async (req, res) => {
  const slots = await bookingsService.getPublicSlots(req.params.id, {
    fromDate: req.query.fromDate,
    days: parseInt(req.query.days, 10) || 45,
  });

  return ApiResponse.success(res, {
    message: 'Booking slots loaded successfully',
    data: slots,
  });
});

const createPublicBooking = asyncHandler(async (req, res) => {
  const booking = await bookingsService.createPublicBooking(req.body, req.user?.id || null);
  return ApiResponse.created(res, {
    message: 'Booking created successfully',
    data: booking,
  });
});

const uploadPublicImage = asyncHandler(async (req, res) => {
  const image = await bookingsService.uploadImageToCloudinary(req.file, req.body);
  return ApiResponse.success(res, {
    message: 'Booking image uploaded successfully',
    data: image,
  });
});

const listBookingTypes = asyncHandler(async (_req, res) => {
  const types = await bookingsService.listBookingTypes();
  return ApiResponse.success(res, {
    message: 'Booking types loaded successfully',
    data: types,
  });
});

const createBookingType = asyncHandler(async (req, res) => {
  const type = await bookingsService.createBookingType(req.body, req.user.id);
  return ApiResponse.created(res, {
    message: 'Booking type created successfully',
    data: type,
  });
});

const updateBookingType = asyncHandler(async (req, res) => {
  const type = await bookingsService.updateBookingType(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'Booking type updated successfully',
    data: type,
  });
});

const listBookings = asyncHandler(async (req, res) => {
  const { bookings, meta } = await bookingsService.listBookings({
    cursor: req.query.cursor,
    limit: parseInt(req.query.limit, 10) || 20,
    order: req.query.order || 'desc',
    filters: {
      status: req.query.status,
      bookingTypeId: req.query.bookingTypeId,
      q: req.query.q,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    },
  });

  return ApiResponse.success(res, {
    message: 'Bookings loaded successfully',
    data: bookings,
    meta,
  });
});

const listMyBookings = asyncHandler(async (req, res) => {
  const { bookings, meta } = await bookingsService.listBookings({
    cursor: req.query.cursor,
    limit: parseInt(req.query.limit, 10) || 20,
    order: req.query.order || 'desc',
    viewerUserId: req.user.id,
    ownOnly: true,
    filters: {
      status: req.query.status,
      bookingTypeId: req.query.bookingTypeId,
      q: req.query.q,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    },
  });

  return ApiResponse.success(res, {
    message: 'My bookings loaded successfully',
    data: bookings,
    meta,
  });
});

const getBookingById = asyncHandler(async (req, res) => {
  const booking = await bookingsService.getBookingById(req.params.id);
  return ApiResponse.success(res, {
    message: 'Booking loaded successfully',
    data: booking,
  });
});

const updateBooking = asyncHandler(async (req, res) => {
  const booking = await bookingsService.updateBooking(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'Booking updated successfully',
    data: booking,
  });
});

module.exports = {
  listPublicBookingTypes,
  getPublicSlots,
  createPublicBooking,
  uploadPublicImage,
  listBookingTypes,
  createBookingType,
  updateBookingType,
  listBookings,
  listMyBookings,
  getBookingById,
  updateBooking,
};
