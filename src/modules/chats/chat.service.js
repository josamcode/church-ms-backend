const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { buildPaginationMeta } = require('../../utils/pagination');
const { PERMISSIONS } = require('../../constants/permissions');
const { ROLES_ARRAY } = require('../../constants/roles');
const { AGE_GROUPS_ARRAY } = require('../../constants/ageGroups');
const User = require('../users/user.model');
const { ChatThread, CHAT_THREAD_TYPES, CHAT_PARTICIPANT_ROLES } = require('./chatThread.model');
const { ChatMessage, CHAT_MESSAGE_SOURCES } = require('./chatMessage.model');
const {
  emitThreadRefresh,
  emitThreadRemoved,
  emitMessageCreated,
} = require('./chat.realtime');

class ChatsService {
  _toObjectId(id, fieldName = 'id') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return new mongoose.Types.ObjectId(id);
  }

  _normalizeId(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value instanceof mongoose.Types.ObjectId) return value.toString();
    if (typeof value === 'object' && value._id) return String(value._id);
    return String(value);
  }

  _normalizeIdArray(values = []) {
    return [...new Set((Array.isArray(values) ? values : [])
      .filter(Boolean)
      .map((value) => this._normalizeId(value))
      .filter(Boolean))];
  }

  _normalizeDistinctStrings(values = []) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  _pickUserForTemplate(user = {}) {
    const healthConditions = Array.isArray(user.health?.conditions)
      ? user.health.conditions.map((condition) => condition?.name).filter(Boolean)
      : [];

    return {
      id: this._normalizeId(user._id || user.id),
      name: user.fullName || '',
      fullName: user.fullName || '',
      firstName: String(user.fullName || '').trim().split(/\s+/).filter(Boolean)[0] || '',
      phonePrimary: user.phonePrimary || '',
      whatsappNumber: user.whatsappNumber || '',
      role: user.role || '',
      gender: user.gender || '',
      ageGroup: user.ageGroup || '',
      familyName: user.familyName || '',
      houseName: user.houseName || '',
      tags: Array.isArray(user.tags) ? user.tags : [],
      diseases: healthConditions,
      healthConditions,
    };
  }

  _renderTemplate(template, recipientUser) {
    const safeTemplate = String(template || '');
    const context = {
      user: this._pickUserForTemplate(recipientUser),
    };

    return safeTemplate.replace(/\{([^{}]+)\}/g, (_match, rawPath) => {
      const path = String(rawPath || '').trim();
      if (!path) return '';

      const resolved = path.split('.').reduce((value, key) => {
        if (value == null) return undefined;
        return value[key];
      }, context);

      if (resolved == null) return '';
      if (Array.isArray(resolved)) return resolved.join(', ');
      return String(resolved);
    });
  }

  _buildDirectKey(userAId, userBId) {
    return [this._normalizeId(userAId), this._normalizeId(userBId)].sort().join(':');
  }

  _mapUser(user) {
    if (!user) return null;
    return {
      id: this._normalizeId(user._id || user.id),
      fullName: user.fullName || '',
      role: user.role || '',
      avatar: user.avatar?.url
        ? {
            url: user.avatar.url,
          }
        : null,
      phonePrimary: user.phonePrimary || '',
      ageGroup: user.ageGroup || '',
    };
  }

  async _loadUsersMap(
    userIds = [],
    projection = 'fullName role avatar phonePrimary ageGroup allowOthersToViewCreatedChats'
  ) {
    const normalizedIds = this._normalizeIdArray(userIds);
    if (!normalizedIds.length) {
      return new Map();
    }

    const users = await User.find({
      _id: { $in: normalizedIds.map((id) => this._toObjectId(id)) },
      isDeleted: { $ne: true },
    })
      .select(projection)
      .lean();

    return new Map(users.map((user) => [this._normalizeId(user._id), user]));
  }

  async _getActiveChatUsers(userIds = [], { allowUsersWithoutLogin = false } = {}) {
    const normalizedIds = this._normalizeIdArray(userIds);
    if (!normalizedIds.length) return [];

    const users = await User.find({
      _id: { $in: normalizedIds.map((id) => this._toObjectId(id)) },
      isDeleted: { $ne: true },
    })
      .select('fullName role avatar phonePrimary ageGroup health familyName houseName tags hasLogin isLocked')
      .lean();

    if (users.length !== normalizedIds.length) {
      throw ApiError.notFound('One or more selected users were not found', 'USER_NOT_FOUND');
    }

    if (!allowUsersWithoutLogin) {
      const usersWithoutLogin = users.filter((user) => user.hasLogin !== true);
      if (usersWithoutLogin.length > 0) {
        throw ApiError.badRequest(
          'Selected users must have login access enabled before they can use chat',
          'VALIDATION_ERROR'
        );
      }
    }

    return normalizedIds.map((id) => users.find((user) => this._normalizeId(user._id) === id));
  }

  async _buildVisibilityQuery(viewerUserId, viewerPermissions = []) {
    const participantCondition = {
      'participants.userId': this._toObjectId(viewerUserId, 'viewerUserId'),
    };

    if (!viewerPermissions.includes(PERMISSIONS.CHATS_VIEW_ALL)) {
      return {
        isDeleted: { $ne: true },
        ...participantCondition,
      };
    }

    const visibleCreators = await User.find({
      isDeleted: { $ne: true },
      allowOthersToViewCreatedChats: { $ne: false },
    })
      .select('_id')
      .lean();

    const visibleCreatorIds = visibleCreators.map((user) => user._id);

    return {
      isDeleted: { $ne: true },
      $or: [
        participantCondition,
        { createdBy: this._toObjectId(viewerUserId, 'viewerUserId') },
        ...(visibleCreatorIds.length ? [{ createdBy: { $in: visibleCreatorIds } }] : []),
      ],
    };
  }

  async _getThreadForViewer(threadId, viewerUserId, viewerPermissions = []) {
    const thread = await ChatThread.findById(this._toObjectId(threadId, 'threadId')).lean();
    if (!thread || thread.isDeleted) {
      throw ApiError.notFound('Chat thread not found', 'RESOURCE_NOT_FOUND');
    }

    const viewerId = this._normalizeId(viewerUserId);
    const participant = (thread.participants || []).find(
      (item) => this._normalizeId(item.userId) === viewerId
    );

    if (participant) {
      return { thread, participant };
    }

    if (!viewerPermissions.includes(PERMISSIONS.CHATS_VIEW_ALL)) {
      throw ApiError.notFound('Chat thread not found', 'RESOURCE_NOT_FOUND');
    }

    const creator = await User.findById(thread.createdBy)
      .select('allowOthersToViewCreatedChats')
      .lean();

    const creatorAllowsView =
      this._normalizeId(thread.createdBy) === viewerId ||
      creator?.allowOthersToViewCreatedChats !== false;

    if (!creatorAllowsView) {
      throw ApiError.notFound('Chat thread not found', 'RESOURCE_NOT_FOUND');
    }

    return { thread, participant: null };
  }

  _canParticipantSendMessages(thread, participant, actorUserId) {
    if (!participant) return false;
    if (thread.type === CHAT_THREAD_TYPES.DIRECT) return true;

    if (thread.settings?.allowMemberMessages !== false) return true;

    return (
      participant.role === CHAT_PARTICIPANT_ROLES.ADMIN ||
      this._normalizeId(thread.createdBy) === this._normalizeId(actorUserId)
    );
  }

  _mapThread(thread, viewerUserId, usersMap) {
    const viewerId = this._normalizeId(viewerUserId);
    const participants = (thread.participants || []).map((participant) => {
      const user = usersMap.get(this._normalizeId(participant.userId));
      return {
        ...this._mapUser(user),
        role: participant.role || CHAT_PARTICIPANT_ROLES.MEMBER,
        joinedAt: participant.joinedAt || null,
        lastReadAt:
          this._normalizeId(participant.userId) === viewerId ? participant.lastReadAt || null : null,
      };
    });

    const viewerParticipant = (thread.participants || []).find(
      (participant) => this._normalizeId(participant.userId) === viewerId
    );

    const lastMessageSender = usersMap.get(this._normalizeId(thread.lastMessageSenderId));
    const creator = usersMap.get(this._normalizeId(thread.createdBy));

    let title = thread.title || '';
    let directUser = null;

    if (thread.type === CHAT_THREAD_TYPES.DIRECT) {
      const otherParticipant =
        participants.find((participant) => participant.id !== viewerId) ||
        participants[0] ||
        null;
      directUser = otherParticipant;
      title =
        otherParticipant?.fullName ||
        participants.map((participant) => participant.fullName).filter(Boolean).join(' / ');
    }

    const lastMessageAt = thread.lastMessageAt || null;
    const lastReadAt = viewerParticipant?.lastReadAt || null;
    const hasUnread =
      Boolean(viewerParticipant) &&
      Boolean(lastMessageAt) &&
      this._normalizeId(thread.lastMessageSenderId) !== viewerId &&
      (!lastReadAt || new Date(lastMessageAt).getTime() > new Date(lastReadAt).getTime());

    return {
      id: this._normalizeId(thread._id),
      type: thread.type,
      title: title || 'Untitled chat',
      description: thread.description || '',
      participants,
      participantCount: participants.length,
      directUser,
      settings: {
        allowMemberMessages: thread.settings?.allowMemberMessages !== false,
      },
      createdBy: this._mapUser(creator),
      lastMessageId: this._normalizeId(thread.lastMessageId),
      lastMessagePreview: thread.lastMessagePreview || '',
      lastMessageAt,
      lastMessageSender: this._mapUser(lastMessageSender),
      canCurrentUserSendMessages: this._canParticipantSendMessages(
        thread,
        viewerParticipant,
        viewerUserId
      ),
      isParticipant: Boolean(viewerParticipant),
      hasUnread,
      viewerLastReadAt: lastReadAt,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  _mapMessage(message, usersMap) {
    const sender = usersMap.get(this._normalizeId(message.senderId));
    return {
      id: this._normalizeId(message._id),
      threadId: this._normalizeId(message.threadId),
      kind: message.kind,
      source: message.source,
      text: message.text || '',
      metadata: message.metadata || null,
      sender: this._mapUser(sender),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }

  async _buildThreadPayload(thread, viewerUserId, { recentMessagesLimit = 40 } = {}) {
    const messages = await ChatMessage.find({
      threadId: this._toObjectId(thread._id, 'threadId'),
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(recentMessagesLimit)
      .lean();

    const userIds = [
      ...this._normalizeIdArray([
        thread.createdBy,
        thread.lastMessageSenderId,
        ...(thread.participants || []).map((participant) => participant.userId),
        ...messages.map((message) => message.senderId),
      ]),
    ];

    const usersMap = await this._loadUsersMap(userIds);

    return {
      thread: this._mapThread(thread, viewerUserId, usersMap),
      messages: messages.reverse().map((message) => this._mapMessage(message, usersMap)),
    };
  }

  async _createOrGetDirectThread(actorUserId, targetUserId) {
    const directKey = this._buildDirectKey(actorUserId, targetUserId);
    const existing = await ChatThread.findOne({
      directKey,
      isDeleted: { $ne: true },
    });

    if (existing) {
      return existing;
    }

    try {
      return await ChatThread.create({
        type: CHAT_THREAD_TYPES.DIRECT,
        participants: [
          {
            userId: this._toObjectId(actorUserId, 'actorUserId'),
            role: CHAT_PARTICIPANT_ROLES.MEMBER,
          },
          {
            userId: this._toObjectId(targetUserId, 'targetUserId'),
            role: CHAT_PARTICIPANT_ROLES.MEMBER,
          },
        ],
        createdBy: this._toObjectId(actorUserId, 'actorUserId'),
        updatedBy: this._toObjectId(actorUserId, 'actorUserId'),
      });
    } catch (error) {
      if (error?.code === 11000) {
        const resolved = await ChatThread.findOne({
          directKey,
          isDeleted: { $ne: true },
        });
        if (resolved) {
          return resolved;
        }
      }
      throw error;
    }
  }

  async _persistMessage(
    thread,
    actorUserId,
    text,
    { source = CHAT_MESSAGE_SOURCES.MANUAL, metadata = null } = {}
  ) {
    const participant = (thread.participants || []).find(
      (item) => this._normalizeId(item.userId) === this._normalizeId(actorUserId)
    );

    if (!participant) {
      throw ApiError.forbidden(
        'You must be a chat participant to send messages',
        'PERMISSION_DENIED'
      );
    }

    if (!this._canParticipantSendMessages(thread, participant, actorUserId)) {
      throw ApiError.forbidden(
        'This group only allows admins to send messages right now',
        'PERMISSION_DENIED'
      );
    }

    const message = await ChatMessage.create({
      threadId: thread._id,
      senderId: this._toObjectId(actorUserId, 'actorUserId'),
      text: String(text || '').trim(),
      source,
      metadata,
    });

    participant.lastReadAt = message.createdAt;
    participant.lastReadMessageId = message._id;
    thread.lastMessageId = message._id;
    thread.lastMessageAt = message.createdAt;
    thread.lastMessagePreview = message.text.slice(0, 400);
    thread.lastMessageSenderId = message.senderId;
    thread.updatedBy = this._toObjectId(actorUserId, 'actorUserId');
    await thread.save();

    return message;
  }

  async _notifyMessage(threadId, messageId) {
    const thread = await ChatThread.findById(threadId).lean();
    const message = await ChatMessage.findById(messageId).lean();
    if (!thread || !message) return;

    const participantUserIds = (thread.participants || []).map((participant) => participant.userId);
    const usersMap = await this._loadUsersMap([message.senderId]);
    emitMessageCreated(participantUserIds, {
      threadId: this._normalizeId(thread._id),
      message: this._mapMessage(message, usersMap),
    });
    emitThreadRefresh(participantUserIds, thread._id);
  }

  async listChats({ viewerUserId, viewerPermissions = [], filters = {} }) {
    const query = await this._buildVisibilityQuery(viewerUserId, viewerPermissions);
    if (filters.type) {
      query.type = filters.type;
    }

    const threads = await ChatThread.find(query)
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(200)
      .lean();

    const userIds = this._normalizeIdArray([
      ...threads.map((thread) => thread.createdBy),
      ...threads.map((thread) => thread.lastMessageSenderId),
      ...threads.flatMap((thread) => (thread.participants || []).map((participant) => participant.userId)),
    ]);
    const usersMap = await this._loadUsersMap(userIds);

    let mapped = threads.map((thread) => this._mapThread(thread, viewerUserId, usersMap));

    if (filters.q) {
      const q = String(filters.q).trim().toLowerCase();
      mapped = mapped.filter((thread) => {
        const haystack = [
          thread.title,
          thread.description,
          thread.lastMessagePreview,
          thread.directUser?.fullName,
          ...thread.participants.map((participant) => participant.fullName),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    return mapped;
  }

  async getChatById(chatId, { viewerUserId, viewerPermissions = [] }) {
    const { thread } = await this._getThreadForViewer(chatId, viewerUserId, viewerPermissions);
    return this._buildThreadPayload(thread, viewerUserId);
  }

  async listMessages(chatId, { viewerUserId, viewerPermissions = [], cursor, limit = 40 }) {
    const { thread } = await this._getThreadForViewer(chatId, viewerUserId, viewerPermissions);

    const query = {
      threadId: this._toObjectId(thread._id, 'threadId'),
    };

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        query.createdAt = { $lt: cursorDate };
      }
    }

    const messages = await ChatMessage.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const usersMap = await this._loadUsersMap(messages.map((message) => message.senderId));
    const meta = buildPaginationMeta(messages, limit, 'createdAt');

    return {
      messages: messages.reverse().map((message) => this._mapMessage(message, usersMap)),
      meta,
    };
  }

  async searchUsers({ actorUserId, q = '', limit = 20 }) {
    const query = {
      isDeleted: { $ne: true },
      hasLogin: true,
      _id: { $ne: this._toObjectId(actorUserId, 'actorUserId') },
    };

    const trimmedQuery = String(q || '').trim();
    if (trimmedQuery) {
      query.$or = [
        { fullName: { $regex: trimmedQuery, $options: 'i' } },
        { phonePrimary: { $regex: trimmedQuery, $options: 'i' } },
        { email: { $regex: trimmedQuery, $options: 'i' } },
      ];
    }

    const users = await User.find(query)
      .select('fullName role avatar phonePrimary ageGroup')
      .sort({ fullName: 1 })
      .limit(limit)
      .lean();

    return users.map((user) => this._mapUser(user));
  }

  async getAudienceOptions() {
    const baseFilter = {
      isDeleted: { $ne: true },
      hasLogin: true,
    };

    const [tags, diseases, familyNames, houseNames] = await Promise.all([
      User.distinct('tags', baseFilter),
      User.distinct('health.conditions.name', baseFilter),
      User.distinct('familyName', baseFilter),
      User.distinct('houseName', baseFilter),
    ]);

    return {
      roles: ROLES_ARRAY,
      ageGroups: AGE_GROUPS_ARRAY,
      genders: ['male', 'female', 'other'],
      tags: this._normalizeDistinctStrings(tags),
      diseases: this._normalizeDistinctStrings(diseases),
      familyNames: this._normalizeDistinctStrings(familyNames),
      houseNames: this._normalizeDistinctStrings(houseNames),
    };
  }

  async createDirectChat({ actorUserId, targetUserId }) {
    if (this._normalizeId(actorUserId) === this._normalizeId(targetUserId)) {
      throw ApiError.badRequest(
        'You cannot start a direct chat with yourself',
        'VALIDATION_ERROR'
      );
    }

    await this._getActiveChatUsers([targetUserId]);

    const thread = await this._createOrGetDirectThread(actorUserId, targetUserId);
    emitThreadRefresh([actorUserId, targetUserId], thread._id);

    const payload = await this._buildThreadPayload(thread.toObject ? thread.toObject() : thread, actorUserId, {
      recentMessagesLimit: 20,
    });
    return payload.thread;
  }

  async createGroupChat(payload, actorUserId) {
    const requestedMemberIds = this._normalizeIdArray([
      actorUserId,
      ...(payload.memberIds || []),
      ...(payload.adminUserIds || []),
    ]);

    await this._getActiveChatUsers(requestedMemberIds);

    const adminIds = new Set(this._normalizeIdArray([actorUserId, ...(payload.adminUserIds || [])]));
    const participants = requestedMemberIds.map((userId) => ({
      userId: this._toObjectId(userId),
      role: adminIds.has(userId)
        ? CHAT_PARTICIPANT_ROLES.ADMIN
        : CHAT_PARTICIPANT_ROLES.MEMBER,
    }));

    const thread = await ChatThread.create({
      type: CHAT_THREAD_TYPES.GROUP,
      title: String(payload.title || '').trim(),
      description: payload.description ? String(payload.description).trim() : undefined,
      participants,
      settings: {
        allowMemberMessages: payload.allowMemberMessages !== false,
      },
      createdBy: this._toObjectId(actorUserId, 'actorUserId'),
      updatedBy: this._toObjectId(actorUserId, 'actorUserId'),
    });

    emitThreadRefresh(requestedMemberIds, thread._id);

    const createdThread = await ChatThread.findById(thread._id).lean();
    const payloadResult = await this._buildThreadPayload(createdThread, actorUserId, {
      recentMessagesLimit: 20,
    });
    return payloadResult.thread;
  }

  async updateGroupChat(chatId, payload, actorUserId, actorPermissions = []) {
    const { thread, participant } = await this._getThreadForViewer(chatId, actorUserId, actorPermissions);
    if (thread.type !== CHAT_THREAD_TYPES.GROUP) {
      throw ApiError.badRequest('Only group chats can be updated', 'VALIDATION_ERROR');
    }

    if (!participant && !actorPermissions.includes(PERMISSIONS.CHATS_VIEW_ALL)) {
      throw ApiError.forbidden('You cannot edit this group chat', 'PERMISSION_DENIED');
    }

    const editableThread = await ChatThread.findById(thread._id);
    const previousParticipantIds = this._normalizeIdArray(
      editableThread.participants.map((item) => item.userId)
    );

    if (payload.title !== undefined) {
      editableThread.title = String(payload.title || '').trim();
    }

    if (payload.description !== undefined) {
      editableThread.description = payload.description
        ? String(payload.description).trim()
        : undefined;
    }

    if (payload.allowMemberMessages !== undefined) {
      editableThread.settings.allowMemberMessages = Boolean(payload.allowMemberMessages);
    }

    if (payload.memberIdsToAdd || payload.memberIdsToRemove || payload.adminUserIds) {
      const nextParticipantIds = new Set(previousParticipantIds);

      this._normalizeIdArray(payload.memberIdsToRemove).forEach((userId) => {
        if (userId !== this._normalizeId(editableThread.createdBy)) {
          nextParticipantIds.delete(userId);
        }
      });

      this._normalizeIdArray(payload.memberIdsToAdd).forEach((userId) => {
        nextParticipantIds.add(userId);
      });

      const nextAdminIds = new Set(
        this._normalizeIdArray([
          editableThread.createdBy,
          ...(payload.adminUserIds !== undefined
            ? payload.adminUserIds
            : editableThread.participants
                .filter((item) => item.role === CHAT_PARTICIPANT_ROLES.ADMIN)
                .map((item) => item.userId)),
        ])
      );

      const finalParticipantIds = [...nextParticipantIds];
      if (finalParticipantIds.length < 2) {
        throw ApiError.badRequest(
          'A group chat must keep at least two participants',
          'VALIDATION_ERROR'
        );
      }

      await this._getActiveChatUsers(finalParticipantIds);

      editableThread.participants = finalParticipantIds.map((userId) => {
        const existingParticipant = editableThread.participants.find(
          (participantItem) => this._normalizeId(participantItem.userId) === userId
        );

        return {
          userId: this._toObjectId(userId),
          role: nextAdminIds.has(userId)
            ? CHAT_PARTICIPANT_ROLES.ADMIN
            : CHAT_PARTICIPANT_ROLES.MEMBER,
          joinedAt: existingParticipant?.joinedAt || new Date(),
          lastReadAt: existingParticipant?.lastReadAt || null,
          lastReadMessageId: existingParticipant?.lastReadMessageId || null,
        };
      });
    }

    editableThread.updatedBy = this._toObjectId(actorUserId, 'actorUserId');
    await editableThread.save();

    const nextParticipantIds = this._normalizeIdArray(
      editableThread.participants.map((item) => item.userId)
    );
    const removedParticipantIds = previousParticipantIds.filter(
      (userId) => !nextParticipantIds.includes(userId)
    );

    if (removedParticipantIds.length > 0) {
      emitThreadRemoved(removedParticipantIds, editableThread._id);
    }
    emitThreadRefresh(nextParticipantIds, editableThread._id);

    const payloadResult = await this._buildThreadPayload(editableThread.toObject(), actorUserId, {
      recentMessagesLimit: 20,
    });
    return payloadResult.thread;
  }

  async sendMessage(chatId, { actorUserId, viewerPermissions = [], text }) {
    const { thread, participant } = await this._getThreadForViewer(chatId, actorUserId, viewerPermissions);
    if (!participant) {
      throw ApiError.forbidden(
        'You must be a participant to send a message',
        'PERMISSION_DENIED'
      );
    }

    const editableThread = await ChatThread.findById(thread._id);
    const message = await this._persistMessage(editableThread, actorUserId, text, {
      source: CHAT_MESSAGE_SOURCES.MANUAL,
    });

    await this._notifyMessage(editableThread._id, message._id);

    const usersMap = await this._loadUsersMap([message.senderId]);
    return this._mapMessage(message.toObject ? message.toObject() : message, usersMap);
  }

  async markThreadAsRead(chatId, { actorUserId, viewerPermissions = [], messageId = null }) {
    const { thread, participant } = await this._getThreadForViewer(chatId, actorUserId, viewerPermissions);
    if (!participant) {
      throw ApiError.forbidden(
        'You must be a participant to mark messages as read',
        'PERMISSION_DENIED'
      );
    }

    const editableThread = await ChatThread.findById(thread._id);
    const editableParticipant = editableThread.participants.find(
      (item) => this._normalizeId(item.userId) === this._normalizeId(actorUserId)
    );

    if (!editableParticipant) {
      throw ApiError.forbidden(
        'You must be a participant to mark messages as read',
        'PERMISSION_DENIED'
      );
    }

    if (messageId) {
      const message = await ChatMessage.findById(this._toObjectId(messageId, 'messageId')).lean();
      if (!message || this._normalizeId(message.threadId) !== this._normalizeId(editableThread._id)) {
        throw ApiError.notFound('Message not found in this thread', 'RESOURCE_NOT_FOUND');
      }
      editableParticipant.lastReadAt = message.createdAt;
      editableParticipant.lastReadMessageId = message._id;
    } else {
      editableParticipant.lastReadAt = editableThread.lastMessageAt || new Date();
      editableParticipant.lastReadMessageId = editableThread.lastMessageId || null;
    }

    editableThread.updatedBy = this._toObjectId(actorUserId, 'actorUserId');
    await editableThread.save();
    emitThreadRefresh([actorUserId], editableThread._id);

    const payload = await this._buildThreadPayload(editableThread.toObject(), actorUserId, {
      recentMessagesLimit: 20,
    });
    return payload.thread;
  }

  _buildBroadcastAudienceQuery(audience = {}, actorUserId) {
    const query = {
      isDeleted: { $ne: true },
    };

    if (!audience.includeLocked) {
      query.isLocked = { $ne: true };
    }

    if (!audience.includeUsersWithoutLogin) {
      query.hasLogin = true;
    }

    const andConditions = [];

    if (Array.isArray(audience.userIds) && audience.userIds.length > 0) {
      query._id = {
        $in: audience.userIds.map((id) => this._toObjectId(id, 'audience.userIds')),
      };
    }

    if (Array.isArray(audience.roles) && audience.roles.length > 0) {
      query.role = { $in: audience.roles };
    }

    if (Array.isArray(audience.tags) && audience.tags.length > 0) {
      query.tags = { $in: audience.tags };
    }

    if (Array.isArray(audience.diseases) && audience.diseases.length > 0) {
      query['health.conditions.name'] = { $in: audience.diseases };
    }

    if (Array.isArray(audience.ageGroups) && audience.ageGroups.length > 0) {
      query.ageGroup = { $in: audience.ageGroups };
    }

    if (Array.isArray(audience.genders) && audience.genders.length > 0) {
      query.gender = { $in: audience.genders };
    }

    if (Array.isArray(audience.familyNames) && audience.familyNames.length > 0) {
      query.familyName = { $in: audience.familyNames };
    }

    if (Array.isArray(audience.houseNames) && audience.houseNames.length > 0) {
      query.houseName = { $in: audience.houseNames };
    }

    if (!audience.includeSelf) {
      andConditions.push({
        _id: { $ne: this._toObjectId(actorUserId, 'actorUserId') },
      });
    }

    const hasAnySelector = Boolean(
      audience.all ||
      (Array.isArray(audience.userIds) && audience.userIds.length > 0) ||
      (Array.isArray(audience.roles) && audience.roles.length > 0) ||
      (Array.isArray(audience.tags) && audience.tags.length > 0) ||
      (Array.isArray(audience.diseases) && audience.diseases.length > 0) ||
      (Array.isArray(audience.ageGroups) && audience.ageGroups.length > 0) ||
      (Array.isArray(audience.genders) && audience.genders.length > 0) ||
      (Array.isArray(audience.familyNames) && audience.familyNames.length > 0) ||
      (Array.isArray(audience.houseNames) && audience.houseNames.length > 0)
    );

    if (!hasAnySelector) {
      throw ApiError.badRequest(
        'Broadcast audience must include at least one selector or set audience.all to true',
        'VALIDATION_ERROR'
      );
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    return query;
  }

  async createBroadcast({ actorUserId, template, audience }) {
    const query = this._buildBroadcastAudienceQuery(audience, actorUserId);
    const recipients = await User.find(query)
      .select('fullName role avatar phonePrimary ageGroup health familyName houseName tags hasLogin isLocked')
      .sort({ fullName: 1 })
      .lean();

    if (!recipients.length) {
      throw ApiError.badRequest(
        'No users matched the selected broadcast audience',
        'VALIDATION_ERROR'
      );
    }

    const touchedThreadIds = new Set();

    for (const recipient of recipients) {
      const thread = await this._createOrGetDirectThread(actorUserId, recipient._id);
      const editableThread = await ChatThread.findById(thread._id);
      const renderedText = this._renderTemplate(template, recipient).trim();
      await this._persistMessage(editableThread, actorUserId, renderedText, {
        source: CHAT_MESSAGE_SOURCES.BROADCAST,
        metadata: {
          template,
          recipient: {
            id: this._normalizeId(recipient._id),
            fullName: recipient.fullName || '',
          },
        },
      });

      touchedThreadIds.add(this._normalizeId(editableThread._id));
      await this._notifyMessage(editableThread._id, editableThread.lastMessageId);
    }

    return {
      recipientCount: recipients.length,
      threadCount: touchedThreadIds.size,
      recipients: recipients.slice(0, 10).map((recipient) => this._mapUser(recipient)),
    };
  }
}

module.exports = new ChatsService();
