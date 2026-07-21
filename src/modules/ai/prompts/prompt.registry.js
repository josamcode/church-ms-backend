/**
 * Prompt registry.
 *
 * Features reference a prompt by key; the registry resolves the key to the
 * current version. Every usage record stores the resolved version string, so a
 * change in output quality can be traced to a specific prompt revision rather
 * than guessed at.
 */

const crypto = require('crypto');

const notificationDraftV1 = require('./templates/notificationDraft.v1');
const analyticsNarrativeV1 = require('./templates/analyticsNarrative.v1');
const importAmbiguityV1 = require('./templates/importAmbiguity.v1');

const PROMPTS = Object.freeze({
  notificationDraft: notificationDraftV1,
  analyticsNarrative: analyticsNarrativeV1,
  importAmbiguity: importAmbiguityV1,
});

function getPrompt(key) {
  const template = PROMPTS[key];
  if (!template) {
    throw new Error(`Unknown prompt key "${key}"`);
  }
  return template;
}

/**
 * Build the system and user text for a prompt key.
 * @returns {{system: string, prompt: string, version: string, promptHash: string}}
 */
function renderPrompt(key, input) {
  const template = getPrompt(key);
  const prompt = template.build(input);

  return {
    system: template.SYSTEM,
    prompt,
    version: template.VERSION,
    // A fingerprint, so identical requests can be grouped and repeated
    // failures correlated, without ever storing the prompt text itself.
    promptHash: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16),
  };
}

function listPromptVersions() {
  return Object.fromEntries(
    Object.entries(PROMPTS).map(([key, template]) => [key, template.VERSION])
  );
}

module.exports = { getPrompt, renderPrompt, listPromptVersions, PROMPTS };
