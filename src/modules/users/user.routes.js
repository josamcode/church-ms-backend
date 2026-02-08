const express = require('express');
const router = express.Router();
const multer = require('multer');
const userController = require('./user.controller');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const validate = require('../../middlewares/validate');
const userValidators = require('./user.validators');
const { PERMISSIONS } = require('../../constants/permissions');
const { uploadLimiter } = require('../../middlewares/rateLimit');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ═══════ جميع المسارات تتطلب مصادقة ═══════

router.post(
  '/',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_CREATE),
  validate(userValidators.createUser),
  userController.createUser
);

router.post(
  '/upload-avatar',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_UPLOAD_AVATAR),
  uploadLimiter,
  upload.single('avatar'),
  userController.uploadAvatarImage
);

router.get(
  '/custom-detail-keys',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  userController.getCustomDetailKeys
);

router.get(
  '/family-names',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  userController.getFamilyNames
);

router.get(
  '/relation-roles',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  userController.getRelationRoles
);

router.post(
  '/relation-roles',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_UPDATE),
  validate(userValidators.createRelationRole),
  userController.createRelationRole
);

router.get(
  '/',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  validate(userValidators.listUsers),
  userController.listUsers
);

router.get(
  '/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  validate(userValidators.idParam),
  userController.getUser
);

router.patch(
  '/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_UPDATE),
  validate(userValidators.updateUser),
  userController.updateUser
);

router.delete(
  '/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_DELETE),
  validate(userValidators.idParam),
  userController.deleteUser
);

router.post(
  '/:id/avatar',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_UPLOAD_AVATAR),
  uploadLimiter,
  upload.single('avatar'),
  userController.uploadAvatar
);

router.post(
  '/:id/lock',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_LOCK),
  validate(userValidators.lockUser),
  userController.lockUser
);

router.post(
  '/:id/unlock',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_UNLOCK),
  validate(userValidators.idParam),
  userController.unlockUser
);

router.post(
  '/:id/tags',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_TAGS_MANAGE),
  validate(userValidators.manageTags),
  userController.manageTags
);

router.post(
  '/:id/family/link',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.USERS_FAMILY_LINK),
  validate(userValidators.linkFamily),
  userController.linkFamily
);

module.exports = router;
