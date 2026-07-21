/**
 * The contract every provider adapter must satisfy.
 *
 * This project is plain CommonJS with no TypeScript, so the contract is
 * expressed as JSDoc typedefs: editor-level checking without introducing a
 * build step, consistent with the rest of the codebase.
 *
 * Design rule: an adapter **omits** methods for capabilities it does not
 * support rather than implementing them to throw. Discovery happens through
 * `supports()`, never by calling and catching.
 */

/**
 * @typedef {'generateText'|'generateStructured'|'streamText'|'embed'
 *          |'transcribe'|'generateSpeech'|'analyzeImage'|'runToolLoop'} AiCapability
 */

/**
 * @typedef {Object} AiRequestContext
 * @property {string}   userId       - from req.user.id
 * @property {string[]} permissions  - from req.userPermissions (backend-authoritative)
 * @property {string}   requestId    - from middlewares/requestId.js
 * @property {string}   feature      - feature key, for audit and quotas
 * @property {'public'|'internal'|'sensitive'} sensitivity
 * @property {'ar'|'en'} language
 * @property {string}   [role]
 */

/**
 * @typedef {Object} AiUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cachedInputTokens
 * @property {number} estimatedCostUsd
 */

/**
 * @typedef {Object} AiResult
 * @property {any}     data          - text, or a validated object
 * @property {AiUsage} usage
 * @property {string}  provider
 * @property {string}  model
 * @property {number}  latencyMs
 * @property {boolean} usedFallback
 */

/**
 * @typedef {Object} AiProviderAdapter
 * @property {string} name
 * @property {(capability: AiCapability) => boolean} supports
 * @property {() => boolean} isConfigured
 *
 * @property {(params: {
 *   prompt: string, system?: string, maxTokens?: number,
 *   temperature?: number, model: string, context: AiRequestContext
 * }) => Promise<AiResult>} [generateText]
 *
 * @property {(params: {
 *   prompt: string, system?: string, schema: object, schemaName: string,
 *   maxTokens?: number, model: string, context: AiRequestContext
 * }) => Promise<AiResult>} [generateStructured]
 *
 * @property {(params: {
 *   prompt: string, system?: string, onDelta: (chunk: string) => void,
 *   model: string, context: AiRequestContext
 * }) => Promise<AiResult>} [streamText]
 *
 * @property {(params: {
 *   input: string[], model: string, context: AiRequestContext
 * }) => Promise<AiResult>} [embed]
 *
 * @property {(params: {
 *   audio: Buffer, mimeType: string, language?: string, context: AiRequestContext
 * }) => Promise<AiResult>} [transcribe]
 *
 * @property {(params: {
 *   text: string, voice?: string, context: AiRequestContext
 * }) => Promise<AiResult>} [generateSpeech]
 *
 * @property {(params: {
 *   images: Array<{data: Buffer, mimeType: string}>, prompt: string,
 *   context: AiRequestContext
 * }) => Promise<AiResult>} [analyzeImage]
 *
 * @property {(params: {
 *   prompt: string, tools: object[],
 *   onToolCall: (name: string, args: object) => Promise<object>,
 *   maxIterations: number, context: AiRequestContext
 * }) => Promise<AiResult>} [runToolLoop]
 */

/**
 * Assert an object satisfies the mandatory part of the contract.
 * Called at registry construction so a malformed adapter fails loudly at boot
 * rather than on the first user request.
 *
 * @param {AiProviderAdapter} adapter
 */
function assertValidAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('AI adapter must be an object');
  }
  if (typeof adapter.name !== 'string' || !adapter.name) {
    throw new Error('AI adapter must expose a non-empty name');
  }
  if (typeof adapter.supports !== 'function') {
    throw new Error(`AI adapter "${adapter.name}" must implement supports()`);
  }
  if (typeof adapter.isConfigured !== 'function') {
    throw new Error(`AI adapter "${adapter.name}" must implement isConfigured()`);
  }
  return adapter;
}

module.exports = { assertValidAdapter };
