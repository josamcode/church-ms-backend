let chatIo = null;

const getUserRoom = (userId) => `user:${String(userId)}`;
const getThreadViewerRoom = (threadId) => `thread-view:${String(threadId)}`;

const normalizeUserIds = (userIds = []) =>
  [...new Set((Array.isArray(userIds) ? userIds : []).filter(Boolean).map((id) => String(id)))];

const setChatIo = (io) => {
  chatIo = io;
};

const emitToUsers = (userIds = [], eventName, payload) => {
  if (!chatIo) return;

  normalizeUserIds(userIds).forEach((userId) => {
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

const syncSocketActiveThreadView = (socket, threadId = null) => {
  if (!socket) return;

  const previousThreadId = String(socket.data.activeChatThreadId || '').trim();
  const nextThreadId = String(threadId || '').trim();

  if (previousThreadId && previousThreadId !== nextThreadId) {
    socket.leave(getThreadViewerRoom(previousThreadId));
  }

  if (nextThreadId && previousThreadId !== nextThreadId) {
    socket.join(getThreadViewerRoom(nextThreadId));
  }

  socket.data.activeChatThreadId = nextThreadId || null;
};

const filterUsersNotViewingThread = (threadId, userIds = []) => {
  const normalizedThreadId = String(threadId || '').trim();
  const normalizedUserIds = normalizeUserIds(userIds);

  if (!chatIo || !normalizedThreadId || !normalizedUserIds.length) {
    return normalizedUserIds;
  }

  const viewerSocketIds = chatIo.sockets.adapter.rooms.get(getThreadViewerRoom(normalizedThreadId));
  if (!viewerSocketIds?.size) {
    return normalizedUserIds;
  }

  const viewingUserIds = new Set();
  viewerSocketIds.forEach((socketId) => {
    const viewerSocket = chatIo.sockets.sockets.get(socketId);
    const userId = viewerSocket?.data?.user?.id;
    if (userId) {
      viewingUserIds.add(String(userId));
    }
  });

  return normalizedUserIds.filter((userId) => !viewingUserIds.has(userId));
};

module.exports = {
  setChatIo,
  getUserRoom,
  getThreadViewerRoom,
  emitToUsers,
  emitThreadRefresh,
  emitThreadRemoved,
  emitMessageCreated,
  emitTypingIndicator,
  syncSocketActiveThreadView,
  filterUsersNotViewingThread,
};
