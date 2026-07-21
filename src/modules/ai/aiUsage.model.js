const mongoose = require('mongoose');
const { AI_FEATURE_VALUES } = require('./ai.constants');

/**
 * Per-call AI usage record.
 *
 * What is deliberately NOT stored: the prompt text, the response text, any
 * personal field value, API keys, or retrieved document contents. A prompt
 * fingerprint is enough to group calls, spot duplicates, and correlate errors
 * with a prompt version — storing the text itself would recreate, in a second
 * collection, exactly the exposure the redaction gate exists to prevent.
 */
const aiUsageSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    userRole: { type: String, default: null },
    feature: { type: String, required: true, enum: AI_FEATURE_VALUES, index: true },

    provider: { type: String, required: true },
    model: { type: String, required: true },

    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cachedInputTokens: { type: Number, default: 0 },
    estimatedCostUsd: { type: Number, default: 0 },

    latencyMs: { type: Number, default: 0 },
    retryCount: { type: Number, default: 0 },
    usedFallback: { type: Boolean, default: false },

    // Tool-call telemetry. Phase 1 ships zero tools so this stays empty, but
    // the field is defined now (per §21.2) so the record shape is stable when
    // Phase 2 introduces tools — a later schema change to a 400-day-retained
    // collection is more disruptive than an unused array.
    toolCalls: [
      {
        _id: false,
        name: { type: String },
        durationMs: { type: Number },
        resultCount: { type: Number },
      },
    ],

    // Identifiers only — never record contents.
    recordsAccessed: [{ type: String }],

    redactionApplied: { type: Boolean, default: false },
    // A single true here is treated as a security incident, not a metric.
    redactionBlocked: { type: Boolean, default: false },

    schemaValid: { type: Boolean, default: null },
    schemaRetries: { type: Number, default: 0 },

    humanApproval: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'not_required'],
      default: 'not_required',
    },
    userFeedback: {
      type: String,
      enum: ['positive', 'negative', 'none'],
      default: 'none',
    },
    // How far the human moved the draft, as an acceptance-quality proxy.
    editDistance: { type: Number, default: null },

    providerErrorCategory: { type: String, default: null },

    // Fingerprints only.
    promptHash: { type: String, default: null },
    promptVersion: { type: String, default: null },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// Cost reporting and per-user anomaly checks.
aiUsageSchema.index({ feature: 1, createdAt: -1 });
aiUsageSchema.index({ userId: 1, createdAt: -1 });

// Retention matches the audit log. Note there is no inline `index: true` on
// `createdAt`: it would collide by name with this TTL index and silently
// prevent it from being created.
aiUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

const AiUsage = mongoose.models.AiUsage || mongoose.model('AiUsage', aiUsageSchema);

module.exports = AiUsage;
