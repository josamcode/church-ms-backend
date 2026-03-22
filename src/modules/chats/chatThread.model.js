const mongoose = require('mongoose');

const CHAT_THREAD_TYPES = Object.freeze({
  DIRECT: 'direct',
  GROUP: 'group',
});

const CHAT_PARTICIPANT_ROLES = Object.freeze({
  ADMIN: 'admin',
  MEMBER: 'member',
});

const chatParticipantSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: String,
      enum: Object.values(CHAT_PARTICIPANT_ROLES),
      default: CHAT_PARTICIPANT_ROLES.MEMBER,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    lastReadAt: {
      type: Date,
      default: null,
    },
    lastReadMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChatMessage',
      default: null,
    },
  },
  { _id: false }
);

const chatThreadSettingsSchema = new mongoose.Schema(
  {
    allowMemberMessages: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const chatThreadSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: Object.values(CHAT_THREAD_TYPES),
      required: true,
    },
    directKey: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    title: {
      type: String,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    participants: {
      type: [chatParticipantSchema],
      default: [],
      validate: {
        validator(participants) {
          return Array.isArray(participants) && participants.length >= 2;
        },
        message: 'Chat thread must include at least two participants',
      },
    },
    settings: {
      type: chatThreadSettingsSchema,
      default: () => ({ allowMemberMessages: true }),
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    lastMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChatMessage',
      default: null,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
    lastMessagePreview: {
      type: String,
      trim: true,
      maxlength: 400,
    },
    lastMessageSenderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

chatThreadSchema.pre('validate', function (next) {
  const uniqueParticipants = new Map();
  for (const participant of this.participants || []) {
    if (participant?.userId) {
      uniqueParticipants.set(String(participant.userId), participant);
    }
  }
  this.participants = [...uniqueParticipants.values()];

  if (this.type === CHAT_THREAD_TYPES.DIRECT) {
    const participantIds = (this.participants || [])
      .map((participant) => String(participant.userId))
      .sort();

    if (participantIds.length !== 2) {
      this.invalidate('participants', 'Direct chat must include exactly two participants');
    } else {
      this.directKey = participantIds.join(':');
      this.title = undefined;
      this.description = undefined;
      this.settings = { allowMemberMessages: true };
    }
  } else {
    this.directKey = undefined;
    if (!String(this.title || '').trim()) {
      this.invalidate('title', 'Group title is required');
    }
  }

  next();
});

chatThreadSchema.index({ 'participants.userId': 1, lastMessageAt: -1 });
chatThreadSchema.index({ type: 1, lastMessageAt: -1 });
chatThreadSchema.index({ createdBy: 1, createdAt: -1 });

const ChatThread = mongoose.model('ChatThread', chatThreadSchema);

module.exports = {
  ChatThread,
  CHAT_THREAD_TYPES,
  CHAT_PARTICIPANT_ROLES,
};
