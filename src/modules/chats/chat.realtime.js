let chatIo = null;

const getUserRoom = (userId) => `user:${String(userId)}`;

const setChatIo = (io) => {
  chatIo = io;
};

const emitToUsers = (userIds = [], eventName, payload) => {
  if (!chatIo) return;

  [...new Set((Array.isArray(userIds) ? userIds : []).filter(Boolean).map((id) => String(id)))]
    .forEach((userId) => {
      chatIo.to(getUserRoom(userId)).emit(eventName, payload);
    });
};

const emitThreadRefresh = (userIds, threadId) => {
  emitToUsers(userIds, 'chat:thread:refresh', {
    threadId: String(threadId),
  });
};

const emitThreadRemoved = (userIds, threadId) => {
  emitToUsers(userIds, 'chat:thread:removed', {
    threadId: String(threadId),
  });
};

const emitMessageCreated = (userIds, payload) => {
  emitToUsers(userIds, 'chat:message:new', payload);
};

const emitTypingIndicator = (userIds, payload) => {
  emitToUsers(userIds, 'chat:typing', payload);
};

module.exports = {
  setChatIo,
  getUserRoom,
  emitToUsers,
  emitThreadRefresh,
  emitThreadRemoved,
  emitMessageCreated,
  emitTypingIndicator,
};
