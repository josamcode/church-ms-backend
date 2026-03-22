const mongoose = require('mongoose');

const CHAT_MESSAGE_KINDS = Object.freeze({
  TEXT: 'text',
});

const CHAT_MESSAGE_SOURCES = Object.freeze({
  MANUAL: 'manual',
  BROADCAST: 'broadcast',
});

const chatMessageSchema = new mongoose.Schema(
  {
    threadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChatThread',
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    kind: {
      type: String,
      enum: Object.values(CHAT_MESSAGE_KINDS),
      default: CHAT_MESSAGE_KINDS.TEXT,
    },
    source: {
      type: String,
      enum: Object.values(CHAT_MESSAGE_SOURCES),
      default: CHAT_MESSAGE_SOURCES.MANUAL,
    },
    text: {
      type: String,
      trim: true,
      required: true,
      maxlength: 2000,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

chatMessageSchema.index({ threadId: 1, createdAt: -1, _id: -1 });

const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

module.exports = {
  ChatMessage,
  CHAT_MESSAGE_KINDS,
  CHAT_MESSAGE_SOURCES,
};
