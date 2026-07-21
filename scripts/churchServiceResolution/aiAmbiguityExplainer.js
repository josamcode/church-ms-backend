/**
 * MVP-3 — annotate ambiguous identity candidates with an explanation.
 *
 * This runs inside a maintenance script, not the API, so it adds no network
 * surface to the application. Its defining property is that the model never
 * receives a record: each candidate pair is reduced to abstract agreement
 * signals first, so the outbound payload contains no name, phone, or date.
 *
 * The verdict is advisory at every confidence level. Nothing here writes a
 * decision, and the two columns it fills are excluded from the workbook's
 * integrity hash precisely because they are commentary, not data.
 */

const logger = require('../../src/utils/logger');
const featureFlags = require('../../src/modules/ai/ops/featureFlags');
const { AI_FEATURES } = require('../../src/modules/ai/ai.constants');
const {
  pseudonymizeComparison,
  explainAmbiguityBatch,
} = require('../../src/modules/ai/features/importAmbiguity.feature');

/** Human-readable Arabic labels for the workbook cell. */
const VERDICT_LABELS = Object.freeze({
  likely_same: 'مرجَّح أنهما نفس الشخص',
  likely_different: 'مرجَّح أنهما شخصان مختلفان',
  unclear: 'غير واضح',
});

const CONFIDENCE_LABELS = Object.freeze({
  high: 'عالية',
  medium: 'متوسطة',
  low: 'منخفضة',
});

/**
 * Turn one candidate row into the record pair the pseudonymizer expects.
 *
 * The source side has only a name — the import sheet carries nothing else — so
 * the remaining signals resolve to "missing", which is itself informative.
 */
function rowToRecordPair(row) {
  return [
    { fullName: row.sourceName },
    {
      fullName: row.candidateFullName,
      birthDate: row.candidateBirthDate,
      familyName: row.candidateFamilyName,
      houseName: row.candidateHouseName,
    },
  ];
}

/**
 * Annotate candidate rows in place with `aiAmbiguityReason` and `aiConfidence`.
 *
 * Always returns the rows. When AI is disabled, unavailable, or fails, the
 * columns stay empty and the workbook is generated exactly as before — the
 * feature is additive and its absence is never an error.
 *
 * @param {Array<object>} candidateRows
 * @param {object} [options]
 * @param {boolean} [options.enabled]   caller's opt-in (the `--ai-explain` flag)
 * @param {number}  [options.maxRows]   ceiling on rows sent, for cost control
 * @param {number}  [options.concurrency]
 * @param {string}  [options.actorUserId]
 */
async function annotateCandidateRows(candidateRows, options = {}) {
  const {
    enabled = false,
    maxRows = 200,
    concurrency = 3,
    actorUserId = null,
  } = options;

  const rows = Array.isArray(candidateRows) ? candidateRows : [];
  if (!rows.length) return rows;

  if (!enabled) return rows;

  if (!featureFlags.isFeatureEnabled(AI_FEATURES.IMPORT_AMBIGUITY)) {
    logger.info('AI ambiguity explanation skipped: feature disabled');
    return rows;
  }

  const targets = rows.slice(0, maxRows);
  if (rows.length > maxRows) {
    // Never truncate silently: a partly-annotated workbook that looks fully
    // annotated is worse than an unannotated one.
    logger.warn('AI ambiguity explanation capped', {
      total: rows.length, explained: maxRows, skipped: rows.length - maxRows,
    });
  }

  const comparisons = targets.map((row) => pseudonymizeComparison(...rowToRecordPair(row)));

  const context = {
    userId: actorUserId,
    role: 'SUPER_ADMIN',
    permissions: [],
    requestId: `workbook-${Date.now()}`,
    feature: AI_FEATURES.IMPORT_AMBIGUITY,
    sensitivity: 'internal',
    language: 'ar',
  };

  let results;
  try {
    results = await explainAmbiguityBatch(comparisons, context, { concurrency });
  } catch (error) {
    // The workbook is the deliverable; an AI outage must not stop it shipping.
    logger.warn('AI ambiguity explanation failed entirely', { reason: error.message });
    return rows;
  }

  let explained = 0;
  results.forEach((result, index) => {
    const row = targets[index];
    if (!result || !result.ok) return;

    const { verdict, confidence, reasoning_ar: reasoning } = result.data;
    row.aiAmbiguityReason = `${VERDICT_LABELS[verdict] || verdict}: ${reasoning}`;
    row.aiConfidence = CONFIDENCE_LABELS[confidence] || confidence;
    explained += 1;
  });

  logger.info('AI ambiguity explanation complete', {
    requested: targets.length, explained, failed: targets.length - explained,
  });

  return rows;
}

module.exports = {
  annotateCandidateRows,
  rowToRecordPair,
  VERDICT_LABELS,
  CONFIDENCE_LABELS,
};
