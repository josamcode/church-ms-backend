/**
 * The AI permission model.
 *
 * The design claim under test: AI permissions are ADDITIVE. Holding one grants
 * no data access on its own — the matching domain permission is always required
 * too — so introducing AI cannot widen anybody's reach.
 */

const {
  PERMISSIONS,
  PERMISSIONS_ARRAY,
  ROLE_PERMISSIONS,
  SUPER_ADMIN_ONLY_PERMISSIONS,
  getEffectivePermissions,
  filterAssignablePermissions,
} = require('../../src/constants/permissions');
const { ROLES } = require('../../src/constants/roles');

const AI_PERMISSIONS = [
  PERMISSIONS.AI_DRAFT_CONTENT,
  PERMISSIONS.AI_EXPLAIN_ANALYTICS,
  PERMISSIONS.AI_DATA_QUALITY_REVIEW,
];

describe('AI permission constants', () => {
  it('defines exactly three AI permissions', () => {
    const declared = PERMISSIONS_ARRAY.filter((p) => p.startsWith('AI_'));
    expect(declared.sort()).toEqual([...AI_PERMISSIONS].sort());
  });

  it('registers them in the permissions array', () => {
    AI_PERMISSIONS.forEach((permission) => {
      expect(PERMISSIONS_ARRAY).toContain(permission);
    });
  });
});

describe('AI permissions are not granted by default', () => {
  // Enabling AI for a person must be a conscious act, which also gives
  // gradual rollout without a second feature-flag mechanism.
  it('are absent from the ADMIN role', () => {
    AI_PERMISSIONS.forEach((permission) => {
      expect(ROLE_PERMISSIONS[ROLES.ADMIN]).not.toContain(permission);
    });
  });

  it('are absent from the USER role', () => {
    AI_PERMISSIONS.forEach((permission) => {
      expect(ROLE_PERMISSIONS[ROLES.USER]).not.toContain(permission);
    });
  });

  it('an ADMIN with no overrides has no AI permission', () => {
    const effective = getEffectivePermissions(ROLES.ADMIN, [], []);
    AI_PERMISSIONS.forEach((permission) => {
      expect(effective).not.toContain(permission);
    });
  });

  it('SUPER_ADMIN holds them, as it holds everything', () => {
    const effective = getEffectivePermissions(ROLES.SUPER_ADMIN, [], []);
    AI_PERMISSIONS.forEach((permission) => {
      expect(effective).toContain(permission);
    });
  });
});

describe('AI permissions are grantable and revocable', () => {
  it('can be granted to an ADMIN through extraPermissions', () => {
    const effective = getEffectivePermissions(ROLES.ADMIN, [PERMISSIONS.AI_DRAFT_CONTENT], []);
    expect(effective).toContain(PERMISSIONS.AI_DRAFT_CONTENT);
  });

  /**
   * The subtle one. `filterAssignablePermissions` strips
   * SUPER_ADMIN_ONLY_PERMISSIONS from BOTH the grant and the deny list, so a
   * permission placed there cannot be explicitly denied to a non-super-admin.
   * Keeping the AI permissions out of that list is what makes deny work.
   */
  it('are not in SUPER_ADMIN_ONLY_PERMISSIONS, so denial is effective', () => {
    AI_PERMISSIONS.forEach((permission) => {
      expect(SUPER_ADMIN_ONLY_PERMISSIONS).not.toContain(permission);
    });
  });

  it('deny overrides grant', () => {
    const effective = getEffectivePermissions(
      ROLES.ADMIN,
      [PERMISSIONS.AI_DRAFT_CONTENT],
      [PERMISSIONS.AI_DRAFT_CONTENT]
    );
    expect(effective).not.toContain(PERMISSIONS.AI_DRAFT_CONTENT);
  });

  it('survives the assignability filter in both directions', () => {
    AI_PERMISSIONS.forEach((permission) => {
      expect(filterAssignablePermissions(ROLES.ADMIN, [permission])).toContain(permission);
    });
  });

  it('grants each AI permission independently', () => {
    const effective = getEffectivePermissions(ROLES.ADMIN, [PERMISSIONS.AI_EXPLAIN_ANALYTICS], []);
    expect(effective).toContain(PERMISSIONS.AI_EXPLAIN_ANALYTICS);
    expect(effective).not.toContain(PERMISSIONS.AI_DRAFT_CONTENT);
    expect(effective).not.toContain(PERMISSIONS.AI_DATA_QUALITY_REVIEW);
  });
});

describe('AI permissions grant no domain access on their own', () => {
  it('AI_DRAFT_CONTENT alone does not confer NOTIFICATIONS_CREATE', () => {
    const effective = getEffectivePermissions(ROLES.USER, [PERMISSIONS.AI_DRAFT_CONTENT], []);
    expect(effective).toContain(PERMISSIONS.AI_DRAFT_CONTENT);
    expect(effective).not.toContain(PERMISSIONS.NOTIFICATIONS_CREATE);
  });

  it('AI_EXPLAIN_ANALYTICS alone does not confer SYSTEM_ANALYTICS_VIEW', () => {
    const effective = getEffectivePermissions(ROLES.USER, [PERMISSIONS.AI_EXPLAIN_ANALYTICS], []);
    expect(effective).not.toContain(PERMISSIONS.SYSTEM_ANALYTICS_VIEW);
  });

  /**
   * The strongest form of the additive claim: granting all three AI
   * permissions changes the effective set by exactly those three and nothing
   * else. Asserting specific domain permissions are absent would be weaker and
   * can pass for the wrong reason — the role may not have had them anyway.
   */
  it.each([ROLES.USER, ROLES.ADMIN])(
    'adds exactly the AI permissions and nothing more for %s',
    (role) => {
      const before = new Set(getEffectivePermissions(role, [], []));
      const after = getEffectivePermissions(role, AI_PERMISSIONS, []);
      const added = after.filter((permission) => !before.has(permission));

      expect(added.sort()).toEqual([...AI_PERMISSIONS].sort());
    }
  );

  it('never grants a confession or aid permission through an AI grant', () => {
    const before = new Set(getEffectivePermissions(ROLES.USER, [], []));
    const after = getEffectivePermissions(ROLES.USER, AI_PERMISSIONS, []);
    const added = after.filter((permission) => !before.has(permission));

    expect(added.filter((p) => p.startsWith('CONFESSIONS_') || p.startsWith('AIDS_')))
      .toEqual([]);
  });
});

describe('AI routes require both an AI and a domain permission', () => {
  const routeSource = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../src/modules/ai/ai.routes.js'),
    'utf8'
  );

  it('pairs the draft endpoint with NOTIFICATIONS_CREATE', () => {
    expect(routeSource).toContain(
      'authorizePermissions(PERMISSIONS.AI_DRAFT_CONTENT, PERMISSIONS.NOTIFICATIONS_CREATE)'
    );
  });

  it('pairs the narrate endpoint with SYSTEM_ANALYTICS_VIEW', () => {
    expect(routeSource).toContain(
      'authorizePermissions(PERMISSIONS.AI_EXPLAIN_ANALYTICS, PERMISSIONS.SYSTEM_ANALYTICS_VIEW)'
    );
  });

  // `authorizePermissions` is `every`; `authorizeAnyPermissions` is `some`.
  // Using the latter here would silently make the pairing meaningless.
  it('never uses the any-of authorizer on an AI route', () => {
    expect(routeSource).not.toContain('authorizeAnyPermissions');
  });

  /**
   * Split the file into one block per `router.<verb>(...)` call so each route
   * is asserted on its own. Counting occurrences across the whole file would
   * also count the import statements and pass for the wrong reason.
   */
  // Comments legitimately discuss `aiLimiter` and `apiMutationLimiter` in
  // prose, so they are stripped before a block is matched for actual middleware
  // usage — otherwise the matcher would confuse a mention with an invocation.
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const routeBlocks = stripComments(routeSource)
    .split(/\brouter\.(?=get\(|post\(|put\(|patch\(|delete\()/)
    .slice(1)
    .map((block) => {
      const verb = block.slice(0, block.indexOf('('));
      const path = (block.match(/'([^']+)'/) || [])[1] || '';
      return { verb, path, block };
    });

  /**
   * Routes that actually invoke a model provider. These carry the strict
   * requirements: an AI rate limiter and two permissions.
   *
   * `/status` reads flags and the caller's own quota; `/feedback` annotates the
   * caller's own usage record. Neither reaches a provider, so neither needs an
   * AI permission — and requiring one on `/feedback` would stop a user
   * reporting a bad draft the moment their AI access was revoked.
   */
  const GENERATION_ROUTES = ['/notifications/draft', '/analytics/narrate'];

  it('finds every declared route', () => {
    expect(routeBlocks.map((r) => `${r.verb} ${r.path}`)).toEqual([
      'get /status',
      'post /notifications/draft',
      'post /analytics/narrate',
      'post /feedback',
    ]);
  });

  it('classifies exactly the provider-invoking routes as generation routes', () => {
    const withAiLimiter = routeBlocks
      .filter((route) => route.block.includes('aiLimiter'))
      .map((route) => route.path);
    expect(withAiLimiter.sort()).toEqual([...GENERATION_ROUTES].sort());
  });

  it('authenticates every AI route', () => {
    routeBlocks.forEach(({ verb, path, block }) => {
      expect({ route: `${verb} ${path}`, authenticated: block.includes('authenticateJWT') })
        .toEqual({ route: `${verb} ${path}`, authenticated: true });
    });
  });

  it('rate-limits every generation endpoint', () => {
    routeBlocks
      .filter((route) => GENERATION_ROUTES.includes(route.path))
      .forEach(({ path, block }) => {
        expect({ route: path, limited: block.includes('aiLimiter') })
          .toEqual({ route: path, limited: true });
      });
  });

  // Non-generation mutations (feedback) rely on the global apiMutationLimiter
  // mounted in app.js, not a route-level one — repeating it here would
  // double-charge the mutation budget.
  it('does not repeat the global mutation limiter on the routes', () => {
    routeBlocks.forEach(({ path, block }) => {
      expect({ route: path, hasApiMutationLimiter: block.includes('apiMutationLimiter') })
        .toEqual({ route: path, hasApiMutationLimiter: false });
    });
  });

  it('requires two permissions on every generation endpoint', () => {
    routeBlocks
      .filter((route) => GENERATION_ROUTES.includes(route.path))
      .forEach(({ path, block }) => {
        const call = block.match(/authorizePermissions\(([^)]*)\)/);
        expect(call).not.toBeNull();
        const args = call[1].split(',').map((s) => s.trim()).filter(Boolean);
        expect({ route: path, permissionCount: args.length })
          .toEqual({ route: path, permissionCount: 2 });
        // Exactly one AI permission and one domain permission.
        expect(args.filter((a) => a.includes('.AI_'))).toHaveLength(1);
      });
  });
});
