/**
 * Prompt-injection heuristics.
 *
 * These detect *common* injection phrasings. They are a signal for auditing and
 * for flagging output as low-confidence — they are explicitly NOT a security
 * boundary, because a pattern list can always be paraphrased around.
 *
 * The actual boundary is structural: zero tools in Phase 1, strict output
 * schemas, no write path from a model response, and permissions enforced by
 * the same middleware as every other request.
 */

const INJECTION_PATTERNS = Object.freeze([
  Object.freeze({ name: 'ignore_previous', pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)\b/i }),
  Object.freeze({ name: 'role_override', pattern: /\byou\s+are\s+now\s+(?:a|an|the)\b/i }),
  Object.freeze({ name: 'system_prompt_probe', pattern: /\b(?:reveal|show|print|repeat|output)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|rules?)\b/i }),
  Object.freeze({ name: 'developer_mode', pattern: /\b(?:developer|god|admin|dan)\s+mode\b/i }),
  Object.freeze({ name: 'fake_system_tag', pattern: /<\/?(?:system|assistant|human|instructions?)\s*>/i }),
  // Determiners are optional and stackable ("send all the records to …"), so
  // the qualifier group repeats rather than matching exactly one word.
  Object.freeze({ name: 'exfiltration_request', pattern: /\b(?:send|post|upload|exfiltrate|transmit)\s+(?:(?:this|that|the|all|every|any)\s+){0,3}(?:data|contents?|records?|users?|members?|files?)\s+to\b/i }),
  Object.freeze({ name: 'permission_escalation', pattern: /\b(?:grant|give|assign)\s+(?:me|myself|this\s+user)\s+(?:admin|super|all)\b/i }),
  Object.freeze({ name: 'instruction_terminator', pattern: /\b(?:end\s+of\s+(?:instructions?|prompt)|###\s*end)\b/i }),
  // No `\b` on the Arabic patterns: JavaScript word boundaries are defined
  // against [A-Za-z0-9_], so `\b` never matches before an Arabic letter and
  // would make these rules silently dead.
  Object.freeze({ name: 'arabic_ignore_previous', pattern: /(?:تجاهل|أهمل)\s+(?:كل\s+)?(?:التعليمات|الأوامر|ما\s+سبق)/ }),
  Object.freeze({ name: 'arabic_role_override', pattern: /أنت\s+الآن/ }),
]);

/**
 * Scan text for injection signals.
 *
 * @param {string} text
 * @returns {{ suspicious: boolean, matches: string[] }}
 */
function detectInjection(text) {
  const value = String(text ?? '');
  const matches = [];

  for (const { name, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(value)) matches.push(name);
  }

  return { suspicious: matches.length > 0, matches };
}

/** Scan several inputs at once, reporting which field each signal came from. */
function detectInjectionInPayload(payload) {
  const matches = [];

  const walk = (value, path) => {
    if (typeof value === 'string') {
      const result = detectInjection(value);
      result.matches.forEach((name) => matches.push({ path, rule: name }));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => walk(entry, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, entry]) => {
        walk(entry, path ? `${path}.${key}` : key);
      });
    }
  };

  walk(payload, '');
  return { suspicious: matches.length > 0, matches };
}

module.exports = { detectInjection, detectInjectionInPayload, INJECTION_PATTERNS };
