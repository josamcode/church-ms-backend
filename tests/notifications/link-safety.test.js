/**
 * P0 Regression Tests — Notification Link Safety
 *
 * 1.  notification_link_rejects_external_url_by_default
 * 2.  notification_link_rejects_protocol_relative_url
 * 3.  notification_link_rejects_javascript_url
 * 4.  notification_link_rejects_data_url
 * 5.  notification_link_accepts_safe_relative_path
 * 6.  notification_link_normalizes_empty_to_safe_default_or_null
 * 7.  push_payload_uses_sanitized_relative_link
 * 8.  service_worker_falls_back_when_link_is_external
 * 9.  service_worker_opens_safe_relative_link
 */

const { sanitizeNotificationLink } = require('../../src/utils/sanitizeNotificationLink');

// ═══════════════════════════════════════════════════════════════
//  Tests 1-6: sanitizeNotificationLink utility
// ═══════════════════════════════════════════════════════════════
describe('sanitizeNotificationLink', () => {
  // 1. notification_link_rejects_external_url_by_default
  describe('notification_link_rejects_external_url_by_default', () => {
    const externalUrls = [
      'https://evil.example.com/phishing',
      'http://evil.example.com/phishing',
      'https://attacker.com',
      'http://192.168.1.1/admin',
      'HTTPS://EVIL.COM',                  // case-insensitive
      'HttP://evil.com/path',
    ];

    externalUrls.forEach((url) => {
      it(`should reject "${url}"`, () => {
        expect(sanitizeNotificationLink(url)).toBe('');
      });
    });
  });

  // 2. notification_link_rejects_protocol_relative_url
  describe('notification_link_rejects_protocol_relative_url', () => {
    const protocolRelative = [
      '//evil.example.com/phishing',
      '//attacker.com',
      '//192.168.1.1/admin',
    ];

    protocolRelative.forEach((url) => {
      it(`should reject "${url}"`, () => {
        expect(sanitizeNotificationLink(url)).toBe('');
      });
    });
  });

  // 3. notification_link_rejects_javascript_url
  describe('notification_link_rejects_javascript_url', () => {
    const jsUrls = [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'javascript%3Aalert(1)',             // encoded colon
      'javascript%2f%2fevil.com',          // encoded slashes
    ];

    jsUrls.forEach((url) => {
      it(`should reject "${url}"`, () => {
        expect(sanitizeNotificationLink(url)).toBe('');
      });
    });
  });

  // 4. notification_link_rejects_data_url
  describe('notification_link_rejects_data_url', () => {
    const dataUrls = [
      'data:text/html,<script>alert(1)</script>',
      'data:application/json,{}',
    ];

    dataUrls.forEach((url) => {
      it(`should reject "${url}"`, () => {
        expect(sanitizeNotificationLink(url)).toBe('');
      });
    });
  });

  // Additional evasion attempts
  describe('rejects_other_dangerous_inputs', () => {
    it('should reject vbscript: scheme', () => {
      expect(sanitizeNotificationLink('vbscript:msgbox(1)')).toBe('');
    });

    it('should reject backslash-based path traversal', () => {
      expect(sanitizeNotificationLink('\\evil.com\\path')).toBe('');
    });

    it('should reject paths with .. traversal', () => {
      expect(sanitizeNotificationLink('/dashboard/../../../etc/passwd')).toBe('');
    });

    it('should reject paths with null bytes', () => {
      // null byte would break the regex but it's already handled by string ops
      expect(sanitizeNotificationLink('/dashboard\x00/evil')).toBe('');
    });

    it('should reject paths longer than 2000 chars', () => {
      const long = '/dashboard/' + 'a'.repeat(2000);
      expect(sanitizeNotificationLink(long)).toBe('');
    });

    it('should reject paths with angle brackets (XSS)', () => {
      expect(sanitizeNotificationLink('/dashboard/<script>')).toBe('');
    });
  });

  // 5. notification_link_accepts_safe_relative_path
  describe('notification_link_accepts_safe_relative_path', () => {
    const safePaths = [
      '/dashboard',
      '/dashboard/notifications/inbox',
      '/bookings',
      '/archive/some-page',
      '/users/explorer',
      '/notifications/inbox',
      '/confessions/sessions',
      '/meetings',
      '/divine-liturgies',
      '/settings',
      '/chats',
      '/dashboard/notifications/507f1f77bcf86cd799439011',
      '/dashboard?tab=notifications',
      '/archive?collection=photos&year=2025',
      '/some/path-with-dashes_and_underscores',
    ];

    safePaths.forEach((path) => {
      it(`should accept "${path}"`, () => {
        expect(sanitizeNotificationLink(path)).toBe(path);
      });
    });
  });

  // 6. notification_link_normalizes_empty_to_safe_default_or_null
  describe('notification_link_normalizes_empty_to_safe_default_or_null', () => {
    it('should return empty string for null', () => {
      expect(sanitizeNotificationLink(null)).toBe('');
    });

    it('should return empty string for undefined', () => {
      expect(sanitizeNotificationLink(undefined)).toBe('');
    });

    it('should return empty string for empty string', () => {
      expect(sanitizeNotificationLink('')).toBe('');
    });

    it('should return empty string for whitespace-only', () => {
      expect(sanitizeNotificationLink('   ')).toBe('');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  Test 7: push_payload_uses_sanitized_relative_link
// ═══════════════════════════════════════════════════════════════
describe('push_payload_uses_sanitized_relative_link', () => {
  let pushService;
  let PushSubscription;
  let User;

  beforeAll(() => {
    jest.mock('../../src/utils/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
    jest.mock('../../src/config/env', () => ({
      env: 'test', isProduction: false, isDevelopmentLike: true,
      push: { enabled: true, vapidPublicKey: 'test-pub', vapidPrivateKey: 'test-priv', vapidEmail: 'mailto:test@test.com', vapidSubject: 'mailto:test@test.com' },
    }));
    jest.mock('web-push', () => ({
      setVapidDetails: jest.fn(),
      sendNotification: jest.fn().mockResolvedValue({ statusCode: 201 }),
    }));
    jest.mock('../../src/modules/notifications/pushSubscription.model', () => ({
      find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
      deleteOne: jest.fn(),
      distinct: jest.fn().mockResolvedValue([]),
    }));
    jest.mock('../../src/modules/users/user.model', () => ({
      findById: jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(null) }),
      find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) }),
    }));
  });

  beforeEach(() => {
    pushService = require('../../src/modules/notifications/push.service');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should use a safe relative path when given a safe link', () => {
    const payload = pushService._buildWebPushPayload({
      id: 'test-1', type: 'admin', title: 'Test', message: 'Hello',
      link: '/dashboard/notifications/inbox',
    });
    expect(payload.link).toBe('/dashboard/notifications/inbox');
    expect(payload.data.link).toBe('/dashboard/notifications/inbox');
  });

  it('should fall back to default when given an external URL', () => {
    const payload = pushService._buildWebPushPayload({
      id: 'test-2', type: 'admin', title: 'Test', message: 'Hello',
      link: 'https://evil.example.com/phishing',
    });
    expect(payload.link).toBe('/dashboard/notifications/inbox');
    expect(payload.data.link).toBe('/dashboard/notifications/inbox');
  });

  it('should fall back to default when given a javascript: URL', () => {
    const payload = pushService._buildWebPushPayload({
      id: 'test-3', type: 'admin', title: 'Test', message: 'Hello',
      link: 'javascript:alert(1)',
    });
    expect(payload.link).toBe('/dashboard/notifications/inbox');
    expect(payload.data.link).toBe('/dashboard/notifications/inbox');
  });

  it('should fall back to default when given a protocol-relative URL', () => {
    const payload = pushService._buildWebPushPayload({
      id: 'test-4', type: 'admin', title: 'Test', message: 'Hello',
      link: '//evil.example.com',
    });
    expect(payload.link).toBe('/dashboard/notifications/inbox');
    expect(payload.data.link).toBe('/dashboard/notifications/inbox');
  });

  it('should fall back to default when link is empty', () => {
    const payload = pushService._buildWebPushPayload({
      id: 'test-5', type: 'admin', title: 'Test', message: 'Hello',
      link: '',
    });
    expect(payload.link).toBe('/dashboard/notifications/inbox');
    expect(payload.data.link).toBe('/dashboard/notifications/inbox');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Tests 8-9: service worker link validation logic (extracted helper)
// ═══════════════════════════════════════════════════════════════

// This helper replicates the logic from sw.js — a standalone regex
// that the service worker uses to validate notification click links.
function resolveServiceWorkerDestination(rawLink) {
  // Must start with "/" followed by a non-slash character (rejects //evil.com)
  const SAFE_PATH = /^\/[a-zA-Z0-9\-_.~@:?&=+%#!$'()*,;][a-zA-Z0-9/\-_.~@:?&=+%#!$'()*,;]*$/;
  const safeLink = SAFE_PATH.test(rawLink) ? rawLink : '/dashboard/notifications/inbox';
  return safeLink;
}

describe('service_worker_link_safety', () => {
  // 8. service_worker_falls_back_when_link_is_external
  describe('service_worker_falls_back_when_link_is_external', () => {
    it('should fall back to default when link is an external https URL', () => {
      expect(resolveServiceWorkerDestination('https://evil.example.com/phishing'))
        .toBe('/dashboard/notifications/inbox');
    });

    it('should fall back to default when link is a protocol-relative URL', () => {
      expect(resolveServiceWorkerDestination('//evil.example.com'))
        .toBe('/dashboard/notifications/inbox');
    });

    it('should fall back to default when link is javascript:', () => {
      expect(resolveServiceWorkerDestination('javascript:alert(1)'))
        .toBe('/dashboard/notifications/inbox');
    });

    it('should fall back to default when link is data:', () => {
      expect(resolveServiceWorkerDestination('data:text/html,<script>alert(1)</script>'))
        .toBe('/dashboard/notifications/inbox');
    });

    it('should fall back to default when link is empty', () => {
      expect(resolveServiceWorkerDestination(''))
        .toBe('/dashboard/notifications/inbox');
    });

    it('should fall back to default when link is null/undefined', () => {
      expect(resolveServiceWorkerDestination(null))
        .toBe('/dashboard/notifications/inbox');
      expect(resolveServiceWorkerDestination(undefined))
        .toBe('/dashboard/notifications/inbox');
    });

    it('should fall back to default for path traversal', () => {
      expect(resolveServiceWorkerDestination('../../../etc/passwd'))
        .toBe('/dashboard/notifications/inbox');
    });
  });

  // 9. service_worker_opens_safe_relative_link
  describe('service_worker_opens_safe_relative_link', () => {
    const safeLinks = [
      '/dashboard',
      '/dashboard/notifications/inbox',
      '/bookings',
      '/archive/some-page',
      '/users/explorer',
      '/notifications/inbox',
      '/confessions/sessions',
      '/meetings',
      '/divine-liturgies',
      '/settings',
      '/chats',
      '/dashboard/notifications/507f1f77bcf86cd799439011',
      '/dashboard?tab=notifications',
      '/archive?collection=photos&year=2025',
    ];

    safeLinks.forEach((link) => {
      it(`should pass through safe link "${link}"`, () => {
        expect(resolveServiceWorkerDestination(link)).toBe(link);
      });
    });
  });
});
