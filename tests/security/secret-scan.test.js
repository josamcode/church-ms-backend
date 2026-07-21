/**
 * Secret scanner — AI provider key detection.
 *
 * Every credential in this file is synthetic and assembled at runtime from
 * harmless parts. No real key is ever committed, and `tests/` is in the
 * scanner's allow-list so these fixtures cannot trip the scanner on itself.
 */

const { scanContent, SECRET_PATTERNS } = require('../../scripts/scan-secrets');

// Built by concatenation so no line in this file reads as a pasted key.
const FAKE = {
  anthropic: 'sk-ant-' + 'api03-' + 'A'.repeat(20) + '_deadbeef',
  openaiProject: 'sk-proj-' + 'B'.repeat(32),
  openaiServiceAccount: 'sk-svcacct-' + 'C'.repeat(32),
  gemini: 'AIza' + 'D'.repeat(35),
  groq: 'gsk_' + 'E'.repeat(44),
  xai: 'xai-' + 'F'.repeat(44),
  legacyOpenai: 'sk-' + 'G'.repeat(40),
};

function labelsFor(content) {
  return scanContent(content).map((f) => f.label);
}

describe('secret scanner — AI provider key patterns', () => {
  it('detects an Anthropic API key', () => {
    expect(labelsFor(`const k = "${FAKE.anthropic}";`)).toContain('Anthropic API key');
  });

  it('detects an OpenAI project key', () => {
    expect(labelsFor(`const k = "${FAKE.openaiProject}";`)).toContain('OpenAI project API key');
  });

  it('detects an OpenAI service account key', () => {
    expect(labelsFor(`const k = "${FAKE.openaiServiceAccount}";`))
      .toContain('OpenAI service account key');
  });

  it('detects a Google AI / Gemini API key', () => {
    expect(labelsFor(`const k = "${FAKE.gemini}";`)).toContain('Google AI / Gemini API key');
  });

  it('detects a Groq API key', () => {
    expect(labelsFor(`const k = "${FAKE.groq}";`)).toContain('Groq API key');
  });

  it('detects an xAI API key', () => {
    expect(labelsFor(`const k = "${FAKE.xai}";`)).toContain('xAI API key');
  });

  it('still detects the legacy sk- style key', () => {
    expect(labelsFor(`const k = "${FAKE.legacyOpenai}";`))
      .toContain('OpenAI/Stripe-style secret key');
  });

  // Regression guard for the exact gap this change closes: hyphenated provider
  // prefixes are invisible to /sk-[a-zA-Z0-9]{32,}/ because the literal `sk-`
  // is followed by a short segment and another hyphen.
  it('catches hyphen-prefixed keys that the generic sk- rule alone misses', () => {
    const generic = SECRET_PATTERNS.find(
      (p) => p.label === 'OpenAI/Stripe-style secret key'
    ).pattern;

    for (const key of [FAKE.anthropic, FAKE.openaiProject, FAKE.openaiServiceAccount]) {
      generic.lastIndex = 0;
      expect(generic.test(key)).toBe(false); // the old rule alone would miss it
      expect(scanContent(`k = "${key}"`).length).toBeGreaterThan(0); // the new rules catch it
    }
  });

  describe('AI provider key assignments by env-var name', () => {
    it.each([
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_AI_API_KEY',
      'DEEPSEEK_API_KEY',
    ])('flags a hardcoded %s', (varName) => {
      const labels = labelsFor(`${varName} = "not-a-real-value-but-long-enough"`);
      expect(labels).toContain('AI provider API key assignment');
    });
  });

  describe('false-positive resistance', () => {
    it('ignores placeholder values in env examples', () => {
      const content = [
        'ANTHROPIC_API_KEY=',
        'OPENAI_API_KEY=your_openai_api_key_here',
        'AI_ENABLED=false',
      ].join('\n');
      expect(labelsFor(content)).not.toContain('AI provider API key assignment');
    });

    it('ignores a reference to a key that is read from the environment', () => {
      const content = 'apiKey: process.env.ANTHROPIC_API_KEY,';
      expect(labelsFor(content)).not.toContain('AI provider API key assignment');
    });

    it('does not flag ordinary prose containing the word AIza', () => {
      expect(labelsFor('// see AIza docs for details')).toEqual([]);
    });
  });
});
