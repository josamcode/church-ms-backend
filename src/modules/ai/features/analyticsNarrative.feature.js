/**
 * MVP-2 — analytics narrative.
 *
 * The server assembles the metric snapshot itself; the client sends only a
 * period and a scope. That means the caller cannot inject arbitrary numbers
 * into the prompt, and the set of legitimate `metricKey` values is known
 * server-side — which is what makes the hallucination check below possible.
 *
 * The payload is aggregate counts only: no member, no identifier, no free text.
 */

const { orchestrate } = require('../ai.orchestrator');
const { ANALYTICS_NARRATIVE_SCHEMA } = require('../schemas/analyticsNarrative.schema');
const { AI_FEATURES, AI_WORKLOADS, AI_SENSITIVITY, AI_OUTPUT_LIMITS } = require('../ai.constants');

const HTML_TAG_PATTERN = /<[^>]+>/;

/**
 * Reject invented metrics.
 *
 * This is the check that makes the feature safe to show to an administrator.
 * A model can produce a fluent, confident sentence about a number it was never
 * given; comparing every cited `metricKey` against the keys actually sent turns
 * that from an undetectable error into a hard rejection.
 *
 * The whole response is rejected, not just the offending observation: a model
 * that invented one metric has demonstrated it is not grounded in the payload,
 * so the remaining statements have not earned trust either.
 */
function buildPostValidate(suppliedMetricKeys) {
  const allowed = new Set(suppliedMetricKeys);

  return function postValidate(narrative) {
    const invented = (narrative.observations || [])
      .map((observation) => observation.metricKey)
      .filter((key) => !allowed.has(key));

    if (invented.length > 0) {
      throw new Error(
        `Narrative cited metrics that were never supplied: ${[...new Set(invented)].join(', ')}`
      );
    }

    if (String(narrative.narrative_ar || '').length > AI_OUTPUT_LIMITS.narrativeLength) {
      throw new Error('Narrative exceeds the maximum length');
    }

    const allText = JSON.stringify(narrative);
    if (HTML_TAG_PATTERN.test(allText)) {
      throw new Error('Narrative contains HTML markup');
    }
    if (!/[؀-ۿ]/.test(String(narrative.narrative_ar || ''))) {
      throw new Error('Narrative is not in Arabic');
    }

    return narrative;
  };
}

/**
 * @param {object} input
 * @param {string} input.period
 * @param {string} input.scope
 * @param {Array<{key: string, label: string, value: number, previousValue?: number}>} input.metrics
 * @param {import('../providers/provider.interface').AiRequestContext} context
 */
async function narrateAnalytics(input, context) {
  const metricKeys = (input.metrics || []).map((metric) => metric.key);

  return orchestrate({
    feature: AI_FEATURES.ANALYTICS_NARRATIVE,
    workload: AI_WORKLOADS.ARABIC_SUMMARIZATION,
    sensitivity: AI_SENSITIVITY.INTERNAL,
    capability: 'generateStructured',
    schema: ANALYTICS_NARRATIVE_SCHEMA,
    schemaName: 'AnalyticsNarrative',
    promptKey: 'analyticsNarrative',
    input,
    context,
    postValidate: buildPostValidate(metricKeys),
    maxTokens: 2048,
  });
}

module.exports = { narrateAnalytics, buildPostValidate };
