const express = require('express');
const multer = require('multer');

const bookingsController = require('./bookings.controller');
const bookingsValidators = require('./bookings.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT, optionalAuth } = require('../../middlewares/auth');
const { authorizeAnyPermissions, authorizePermissions } = require('../../middlewares/permissions');
const { uploadLimiter } = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/public/types', bookingsController.listPublicBookingTypes);

router.get(
  '/public/types/:id/slots',
  validate(bookingsValidators.listPublicSlots),
  bookingsController.getPublicSlots
);

router.post(
  '/public/upload-image',
  uploadLimiter,
  upload.single('image'),
  bookingsController.uploadPublicImage
);

router.post(
  '/public',
  optionalAuth,
  validate(bookingsValidators.createPublicBooking),
  bookingsController.createPublicBooking
);

router.get(
  '/mine',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.BOOKINGS_VIEW_OWN,
    PERMISSIONS.BOOKINGS_VIEW,
    PERMISSIONS.BOOKINGS_MANAGE
  ),
  validate(bookingsValidators.listBookings),
  bookingsController.listMyBookings
);

router.get(
  '/types',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.BOOKINGS_VIEW,
    PERMISSIONS.BOOKINGS_MANAGE,
    PERMISSIONS.BOOKINGS_TYPES_MANAGE
  ),
  bookingsController.listBookingTypes
);

router.post(
  '/types',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.BOOKINGS_TYPES_MANAGE),
  validate(bookingsValidators.createBookingType),
  bookingsController.createBookingType
);

router.patch(
  '/types/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.BOOKINGS_TYPES_MANAGE),
  validate(bookingsValidators.updateBookingType),
  bookingsController.updateBookingType
);

router.get(
  '/',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.BOOKINGS_VIEW,
    PERMISSIONS.BOOKINGS_MANAGE
  ),
  validate(bookingsValidators.listBookings),
  bookingsController.listBookings
);

router.get(
  '/:id',
  authenticateJWT,
  authorizeAnyPermissions(PERMISSIONS.BOOKINGS_VIEW, PERMISSIONS.BOOKINGS_MANAGE),
  validate(bookingsValidators.idParam),
  bookingsController.getBookingById
);

router.patch(
  '/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.BOOKINGS_MANAGE),
  validate(bookingsValidators.updateBooking),
  bookingsController.updateBooking
);

module.exports = router;
