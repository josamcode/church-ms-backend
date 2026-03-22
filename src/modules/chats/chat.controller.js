const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const chatService = require('./chat.service');

const listChats = asyncHandler(async (req, res) => {
  const chats = await chatService.listChats({
    viewerUserId: req.user.id,
    viewerPermissions: req.userPermissions || [],
    filters: req.query,
  });

  return ApiResponse.success(res, {
    message: 'Chats loaded successfully',
    data: chats,
  });
});

const getChatById = asyncHandler(async (req, res) => {
  const payload = await chatService.getChatById(req.params.id, {
    viewerUserId: req.user.id,
    viewerPermissions: req.userPermissions || [],
  });

  return ApiResponse.success(res, {
    message: 'Chat loaded successfully',
    data: payload,
  });
});

const listMessages = asyncHandler(async (req, res) => {
  const payload = await chatService.listMessages(req.params.id, {
    viewerUserId: req.user.id,
    viewerPermissions: req.userPermissions || [],
    cursor: req.query.cursor,
    limit: req.query.limit,
  });

  return ApiResponse.success(res, {
    message: 'Messages loaded successfully',
    data: payload.messages,
    meta: payload.meta,
  });
});

const searchUsers = asyncHandler(async (req, res) => {
  const users = await chatService.searchUsers({
    actorUserId: req.user.id,
    q: req.query.q,
    limit: req.query.limit,
  });

  return ApiResponse.success(res, {
    message: 'Chat users loaded successfully',
    data: users,
  });
});

const getAudienceOptions = asyncHandler(async (_req, res) => {
  const options = await chatService.getAudienceOptions();

  return ApiResponse.success(res, {
    message: 'Chat audience options loaded successfully',
    data: options,
  });
});

const createDirectChat = asyncHandler(async (req, res) => {
  const thread = await chatService.createDirectChat({
    actorUserId: req.user.id,
    targetUserId: req.body.targetUserId,
  });

  return ApiResponse.created(res, {
    message: 'Direct chat created successfully',
    data: thread,
  });
});

const createGroupChat = asyncHandler(async (req, res) => {
  const thread = await chatService.createGroupChat(req.body, req.user.id);

  return ApiResponse.created(res, {
    message: 'Group chat created successfully',
    data: thread,
  });
});

const updateGroupChat = asyncHandler(async (req, res) => {
  const thread = await chatService.updateGroupChat(
    req.params.id,
    req.body,
    req.user.id,
    req.userPermissions || []
  );

  return ApiResponse.success(res, {
    message: 'Group chat updated successfully',
    data: thread,
  });
});

const sendMessage = asyncHandler(async (req, res) => {
  const message = await chatService.sendMessage(req.params.id, {
    actorUserId: req.user.id,
    viewerPermissions: req.userPermissions || [],
    text: req.body.text,
  });

  return ApiResponse.created(res, {
    message: 'Message sent successfully',
    data: message,
  });
});

const markRead = asyncHandler(async (req, res) => {
  const thread = await chatService.markThreadAsRead(req.params.id, {
    actorUserId: req.user.id,
    viewerPermissions: req.userPermissions || [],
    messageId: req.body.messageId,
  });

  return ApiResponse.success(res, {
    message: 'Chat marked as read successfully',
    data: thread,
  });
});

const createBroadcast = asyncHandler(async (req, res) => {
  const result = await chatService.createBroadcast({
    actorUserId: req.user.id,
    template: req.body.template,
    audience: req.body.audience,
  });

  return ApiResponse.created(res, {
    message: 'Broadcast sent successfully',
    data: result,
  });
});

module.exports = {
  listChats,
  getChatById,
  listMessages,
  searchUsers,
  getAudienceOptions,
  createDirectChat,
  createGroupChat,
  updateGroupChat,
  sendMessage,
  markRead,
  createBroadcast,
};
