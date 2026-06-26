const express = require('express');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizeAnyPermissions, authorizePermissions } = require('../../middlewares/permissions');
const validate = require('../../middlewares/validate');
const { chatMessageLimiter } = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');
const chatController = require('./chat.controller');
const chatValidators = require('./chat.validators');

const router = express.Router();

router.use(authenticateJWT);

router.get(
  '/',
  authorizePermissions(PERMISSIONS.CHATS_VIEW),
  validate(chatValidators.listChats),
  chatController.listChats
);

router.get(
  '/users/search',
  authorizeAnyPermissions(
    PERMISSIONS.CHATS_START,
    PERMISSIONS.CHATS_GROUPS_MANAGE,
    PERMISSIONS.CHATS_BROADCAST
  ),
  validate(chatValidators.searchUsers),
  chatController.searchUsers
);

router.get(
  '/audience-options',
  authorizeAnyPermissions(PERMISSIONS.CHATS_BROADCAST, PERMISSIONS.CHATS_GROUPS_MANAGE),
  chatController.getAudienceOptions
);

router.post(
  '/direct',
  authorizePermissions(PERMISSIONS.CHATS_START),
  validate(chatValidators.createDirectChat),
  chatController.createDirectChat
);

router.post(
  '/groups',
  authorizePermissions(PERMISSIONS.CHATS_GROUPS_MANAGE),
  validate(chatValidators.createGroupChat),
  chatController.createGroupChat
);

router.post(
  '/broadcasts',
  authorizePermissions(PERMISSIONS.CHATS_BROADCAST),
  validate(chatValidators.createBroadcast),
  chatController.createBroadcast
);

router.get(
  '/:id',
  authorizePermissions(PERMISSIONS.CHATS_VIEW),
  validate(chatValidators.idParam),
  chatController.getChatById
);

router.get(
  '/:id/messages',
  authorizePermissions(PERMISSIONS.CHATS_VIEW),
  validate(chatValidators.getMessages),
  chatController.listMessages
);

router.post(
  '/:id/messages',
  authorizePermissions(PERMISSIONS.CHATS_SEND),
  chatMessageLimiter,
  validate(chatValidators.sendMessage),
  chatController.sendMessage
);

router.post(
  '/:id/read',
  authorizePermissions(PERMISSIONS.CHATS_VIEW),
  validate(chatValidators.markRead),
  chatController.markRead
);

router.patch(
  '/:id/group',
  authorizePermissions(PERMISSIONS.CHATS_GROUPS_MANAGE),
  validate(chatValidators.updateGroupChat),
  chatController.updateGroupChat
);

module.exports = router;
