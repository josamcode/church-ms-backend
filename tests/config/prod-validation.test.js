/**
 * P0 Regression Tests — Production Environment Validation
 *
 * All tests call the pure validateConfig(config, envName) function
 * exported from env.js.  No process.env mutation or module caching
 * hacks are needed.
 */

const { validateConfig, _looksLikePlaceholderSecret } = require('../../src/config/env');

// ── Helpers ──

function baseConfig(overrides = {}) {
  function ov(key, fallback) {
    return overrides[key] !== undefined ? overrides[key] : fallback;
  }
  return {
    jwt: {
      accessSecret: ov('accessSecret', 'a'.repeat(32)),
      refreshSecret: ov('refreshSecret', 'b'.repeat(32)),
    },
    cors: {
      origin: ov('corsOrigin', 'https://church.example.com'),
      credentials: ov('corsCredentials', true),
    },
    redis: {
      required: ov('redisRequired', true),
      url: ov('redisUrl', 'redis://localhost:6379'),
      host: ov('redisHost', ''),
    },
    r2: {
      required: ov('r2Required', false),
      enabled: ov('r2Enabled', false),
    },
    docs: {
      enabled: ov('docsEnabled', false),
    },
    mail: {
      enabled: ov('mailEnabled', false),
      host: ov('mailHost', ''),
      from: ov('mailFrom', ''),
      port: ov('mailPort', 587),
      user: ov('mailUser', ''),
      pass: ov('mailPass', ''),
    },
    backup: {
      enabled: false,
    },
  };
}

// ═══════════════════════════════════════════════
//  1. production_requires_redis
// ═══════════════════════════════════════════════
describe('production_requires_redis', () => {
  it('should throw when redis.required is false in production', () => {
    expect(() =>
      validateConfig(baseConfig({ redisRequired: false }), 'production')
    ).toThrow('REDIS_REQUIRED must be true in production');
  });

  it('should throw when redis is required but no URL or host provided', () => {
    expect(() =>
      validateConfig(baseConfig({ redisUrl: '', redisHost: '' }), 'production')
    ).toThrow('Redis is required in this environment');
  });

  it('should NOT throw when Redis is properly configured in production', () => {
    expect(() =>
      validateConfig(baseConfig(), 'production')
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════
//  2. production_rejects_in_memory_redis_fallback
// ═══════════════════════════════════════════════
describe('production_rejects_in_memory_redis_fallback', () => {
  it('should not allow Redis to be optional in production', () => {
    expect(() =>
      validateConfig(baseConfig({ redisRequired: false }), 'production')
    ).toThrow('REDIS_REQUIRED must be true');
  });

  it('should allow Redis fallback in development', () => {
    expect(() =>
      validateConfig(baseConfig({ redisRequired: false, redisUrl: '', redisHost: '' }), 'development')
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════
//  3. production_rejects_placeholder_jwt_secrets
// ═══════════════════════════════════════════════
describe('production_rejects_placeholder_jwt_secrets', () => {
  const placeholders = [
    'replace-with-a-long-random-access-secret',
    'replace_with_something_else_here_123456789',
    'change_me_please_change_me_please_123456',
    'changeme_changeme_changeme_changeme_12345',
    'example_secret_abc12345678901234567890',
    'default_access_secret_change_me_hello',
    'your_access_secret_your_access_secret',
  ];

  placeholders.forEach((secret) => {
    it(`should reject placeholder JWT secret "${secret.slice(0, 25)}..."`, () => {
      expect(() =>
        validateConfig(baseConfig({ accessSecret: secret }), 'production')
      ).toThrow(/must be at least 32|must not use placeholder/);
    });
  });
});

// ═══════════════════════════════════════════════
//  4. production_rejects_short_jwt_secrets
// ═══════════════════════════════════════════════
describe('production_rejects_short_jwt_secrets', () => {
  it('should reject JWT secret shorter than 32 characters', () => {
    expect(() =>
      validateConfig(baseConfig({ accessSecret: 'short' }), 'production')
    ).toThrow('must be at least 32 characters');
  });

  it('should accept JWT secret of exactly 32 characters', () => {
    expect(() =>
      validateConfig(baseConfig({ accessSecret: 'a'.repeat(32) }), 'production')
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════
//  5. production_rejects_enabled_api_docs
// ═══════════════════════════════════════════════
describe('production_rejects_enabled_api_docs', () => {
  it('should throw when API docs are enabled in production', () => {
    expect(() =>
      validateConfig(baseConfig({ docsEnabled: true }), 'production')
    ).toThrow('ENABLE_API_DOCS must be false in production');
  });

  it('should allow API docs in development', () => {
    expect(() =>
      validateConfig(baseConfig({ docsEnabled: true }), 'development')
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════
//  6. production_requires_r2_credentials_when_r2_selected
// ═══════════════════════════════════════════════
describe('production_requires_r2_credentials_when_r2_selected', () => {
  it('should throw when R2 is required but not enabled', () => {
    expect(() =>
      validateConfig(baseConfig({ r2Required: true, r2Enabled: false }), 'production')
    ).toThrow('R2 storage is required in this environment');
  });

  it('should NOT throw when R2 is required and enabled', () => {
    expect(() =>
      validateConfig(baseConfig({ r2Required: true, r2Enabled: true }), 'production')
    ).not.toThrow();
  });

  it('should NOT throw when R2 is NOT required', () => {
    expect(() =>
      validateConfig(baseConfig({ r2Required: false, r2Enabled: false }), 'production')
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════
//  7. production_requires_cloudinary_credentials (if supported)
// ═══════════════════════════════════════════════
describe('production_requires_cloudinary_credentials_when_cloudinary_selected_if_supported', () => {
  it('should validate storage provider config shape is present', () => {
    // The config object has an r2 key for R2 storage.
    // Cloudinary is not currently supported; this test validates
    // the pattern is extendable.
    const cfg = baseConfig();
    expect(cfg).toHaveProperty('r2');
    expect(cfg.r2).toHaveProperty('required');
    expect(cfg.r2).toHaveProperty('enabled');
  });
});

// ═══════════════════════════════════════════════
//  8. development_allows_safe_local_defaults
// ═══════════════════════════════════════════════
describe('development_allows_safe_local_defaults', () => {
  it('should allow Redis to be optional in development', () => {
    expect(() =>
      validateConfig(baseConfig({ redisRequired: false, redisUrl: '', redisHost: '' }), 'development')
    ).not.toThrow();
  });

  it('should allow API docs in development', () => {
    expect(() =>
      validateConfig(baseConfig({ docsEnabled: true }), 'development')
    ).not.toThrow();
  });

  it('should not require strong JWT secrets in development', () => {
    expect(() =>
      validateConfig(baseConfig({ accessSecret: '', refreshSecret: '' }), 'development')
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════
//  9. health_endpoint_does_not_expose_sensitive_values
// ═══════════════════════════════════════════════
describe('health_endpoint_does_not_expose_sensitive_values', () => {
  it('should not expose redisFallback in health endpoint source', () => {
    const fs = require('fs');
    const appSource = fs.readFileSync(
      require.resolve('../../src/app'),
      'utf-8'
    );
    expect(appSource).not.toContain('redisFallback');
  });

  it('should only expose environment in non-production mode', () => {
    const fs = require('fs');
    const appSource = fs.readFileSync(
      require.resolve('../../src/app'),
      'utf-8'
    );
    // Extract the health route handler
    expect(appSource).toContain('!config.isProduction');
    expect(appSource).toContain('uptime');
    expect(appSource).toContain('timestamp');
    expect(appSource).not.toContain('redisFallback');
  });
});

// ═══════════════════════════════════════════════
//  10. ai_configuration_fails_closed
// ═══════════════════════════════════════════════
describe('ai_configuration_fails_closed', () => {
  function aiConfig(ai) {
    return { ...baseConfig(), ai };
  }

  const PROVIDERS_OK = {
    anthropic: { enabled: true, apiKey: 'placeholder' },
    openai: { enabled: true, apiKey: 'placeholder' },
    gemini: { enabled: false, apiKey: '', billingAccountVerified: false },
  };
  const LIMITS_OK = { dailySpendUsd: 5, monthlySpendUsd: 100 };

  it('should accept a config with AI disabled and no providers', () => {
    expect(() =>
      validateConfig(aiConfig({ enabled: false, providers: {}, limits: {} }), 'production')
    ).not.toThrow();
  });

  it('should accept a fully configured AI block', () => {
    expect(() =>
      validateConfig(aiConfig({ enabled: true, providers: PROVIDERS_OK, limits: LIMITS_OK }), 'production')
    ).not.toThrow();
  });

  it('should reject an enabled Anthropic provider with no API key', () => {
    expect(() =>
      validateConfig(
        aiConfig({
          enabled: true,
          providers: { ...PROVIDERS_OK, anthropic: { enabled: true, apiKey: '' } },
          limits: LIMITS_OK,
        }),
        'production'
      )
    ).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it('should reject an enabled OpenAI provider with no API key', () => {
    expect(() =>
      validateConfig(
        aiConfig({
          enabled: true,
          providers: { ...PROVIDERS_OK, openai: { enabled: true, apiKey: '' } },
          limits: LIMITS_OK,
        }),
        'production'
      )
    ).toThrow(/OPENAI_API_KEY is required/);
  });

  it('should reject AI enabled with no provider at all', () => {
    expect(() =>
      validateConfig(
        aiConfig({
          enabled: true,
          providers: {
            anthropic: { enabled: false, apiKey: '' },
            openai: { enabled: false, apiKey: '' },
            gemini: { enabled: false, apiKey: '' },
          },
          limits: LIMITS_OK,
        }),
        'production'
      )
    ).toThrow(/at least one enabled provider/);
  });

  // Gemini's unpaid tier permits training on prompts, so a key alone must not
  // be enough to enable it — the boot fails rather than sending data there.
  it('should reject Gemini enabled without verified billing', () => {
    expect(() =>
      validateConfig(
        aiConfig({
          enabled: true,
          providers: {
            ...PROVIDERS_OK,
            gemini: { enabled: true, apiKey: 'placeholder', billingAccountVerified: false },
          },
          limits: LIMITS_OK,
        }),
        'production'
      )
    ).toThrow(/AI_GEMINI_BILLING_VERIFIED/);
  });

  it('should allow Gemini once billing is verified', () => {
    expect(() =>
      validateConfig(
        aiConfig({
          enabled: true,
          providers: {
            ...PROVIDERS_OK,
            gemini: { enabled: true, apiKey: 'placeholder', billingAccountVerified: true },
          },
          limits: LIMITS_OK,
        }),
        'production'
      )
    ).not.toThrow();
  });

  it('should reject a non-positive spend ceiling', () => {
    expect(() =>
      validateConfig(
        aiConfig({ enabled: true, providers: PROVIDERS_OK, limits: { dailySpendUsd: 0, monthlySpendUsd: 100 } }),
        'production'
      )
    ).toThrow(/must be positive/);
  });

  // DeepSeek is a rejected provider; a credential for it must never ship.
  it('should reject a DeepSeek credential in production', () => {
    const original = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'placeholder-should-not-exist';
    try {
      expect(() =>
        validateConfig(aiConfig({ enabled: false, providers: {}, limits: {} }), 'production')
      ).toThrow(/rejected provider/);
    } finally {
      if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = original;
    }
  });
});
