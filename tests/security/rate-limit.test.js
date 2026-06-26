const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const request = require('supertest');

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/config/env', () => ({
  env: 'test',
  isProduction: false,
  isDevelopmentLike: true,
  jwt: {
    accessSecret: 'development_only_access_secret_change_before_production_123456',
    refreshSecret: 'development_only_refresh_secret_change_before_production_123456',
  },
  redis: { enabled: false, required: false },
  rateLimit: {
    windowMs: 15 * 60 * 1000,
    max: 100,
    anonymousMax: 100,
    authenticatedMax: 100,
  },
}));

jest.mock('../../src/config/redis', () => ({
  isReady: false,
  isFallback: true,
  isRequired: false,
  status: 'fallback',
  call: jest.fn(),
}));

const {
  authLoginLimiter,
  createRateLimiter,
  publicBookingLimiter,
  publicBookingUploadLimiter,
  analyticsSessionLimiter,
  resolveAuthenticatedRateLimitKey,
  resolveIpRateLimitKey,
  resolveLoginIdentifierRateLimitKey,
  resolvePublicBookingIdentifierRateLimitKey,
} = require('../../src/middlewares/rateLimit');

const ApiResponse = require('../../src/utils/apiResponse');

const buildApp = (middleware, handler = (_req, res) => ApiResponse.success(res, { message: 'ok' })) => {
  const app = express();
  app.use(express.json({ limit: '50kb' }));
  app.use(express.urlencoded({ extended: true, limit: '20kb' }));
  app.use((req, res, next) => {
    res.requestId = 'test-request-id';
    next();
  });
  app.all('/limited', middleware, handler);
  return app;
};

const tokenFor = (userId) =>
  jwt.sign({ sub: userId, role: 'ADMIN', authVersion: 0 }, 'development_only_access_secret_change_before_production_123456');

describe('rate limit abuse controls', () => {
  it('blocks excessive global-style requests and returns a consistent 429 shape', async () => {
    const app = buildApp(createRateLimiter(60 * 1000, 2, 'Too many test requests.', 'test:global:'));

    await request(app).get('/limited').expect(200);
    await request(app).get('/limited').expect(200);
    const res = await request(app).get('/limited').expect(429);

    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED' },
      requestId: 'test-request-id',
    });
    expect(res.body.message).toBe('Too many test requests.');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('allows normal request volume below the configured limit', async () => {
    const app = buildApp(createRateLimiter(60 * 1000, 3, 'Too many.', 'test:normal:'));

    await request(app).get('/limited').expect(200);
    await request(app).get('/limited').expect(200);
    await request(app).get('/limited').expect(200);
  });

  it('blocks brute force login attempts', async () => {
    const app = buildApp(authLoginLimiter);
    const body = { identifier: 'person@example.com', password: 'bad-password' };

    for (let i = 0; i < 8; i += 1) {
      await request(app).post('/limited').send(body).expect(200);
    }

    const res = await request(app).post('/limited').send(body).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(JSON.stringify(res.body)).not.toContain('person@example.com');
    expect(JSON.stringify(res.body)).not.toContain('bad-password');
  });

  it('auth limiter key includes the normalized identifier without exposing it', () => {
    const keyA = resolveLoginIdentifierRateLimitKey({
      body: { identifier: ' Person@Example.com ' },
      ip: '127.0.0.1',
    });
    const keyB = resolveLoginIdentifierRateLimitKey({
      body: { identifier: 'person@example.com' },
      ip: '127.0.0.1',
    });
    const keyC = resolveLoginIdentifierRateLimitKey({
      body: { identifier: 'other@example.com' },
      ip: '127.0.0.1',
    });

    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(keyC);
    expect(keyA).not.toContain('person@example.com');
  });

  it('rate-limits public booking creation by requester identifier', async () => {
    const app = buildApp(publicBookingLimiter);
    const body = {
      requesterPhone: '01000000000',
      requesterEmail: 'person@example.com',
    };

    for (let i = 0; i < 4; i += 1) {
      await request(app).post('/limited').send(body).expect(200);
    }

    await request(app).post('/limited').send(body).expect(429);
  });

  it('public booking requester key uses IP fallback when unauthenticated identifier is missing', () => {
    const key = resolvePublicBookingIdentifierRateLimitKey({
      body: {},
      ip: '203.0.113.10',
    });

    expect(key).toBe('ip:203.0.113.10');
  });

  it('rate-limits public booking upload before storage work', async () => {
    const storageWork = jest.fn((_req, res) => ApiResponse.success(res, { message: 'stored' }));
    const app = buildApp(
      [
        publicBookingUploadLimiter,
        multer({
          storage: multer.memoryStorage(),
          limits: { fileSize: 1024, files: 1, fields: 2, parts: 4 },
        }).single('image'),
      ],
      storageWork
    );

    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (let i = 0; i < 20; i += 1) {
      await request(app)
        .post('/limited')
        .field('bookingTypeId', '507f1f77bcf86cd799439011')
        .field('fieldKey', 'photo')
        .attach('image', image, { filename: `test-${i}.png`, contentType: 'image/png' })
        .expect(200);
    }

    await request(app)
      .post('/limited')
      .field('bookingTypeId', '507f1f77bcf86cd799439011')
      .field('fieldKey', 'photo')
      .attach('image', image, { filename: 'blocked.png', contentType: 'image/png' })
      .expect(429);

    expect(storageWork).toHaveBeenCalledTimes(20);
  });

  it('rate-limits analytics sync by session and visitor', async () => {
    const app = buildApp(analyticsSessionLimiter);
    const body = { sessionId: 'session_12345678', visitorId: 'visitor_12345678' };

    for (let i = 0; i < 240; i += 1) {
      await request(app).post('/limited').send(body).expect(200);
    }

    await request(app).post('/limited').send(body).expect(429);
  });

  it('authenticated limiter key uses userId when a valid token is available', () => {
    const token = tokenFor('user-123');
    const key = resolveAuthenticatedRateLimitKey({
      headers: { authorization: `Bearer ${token}` },
    });

    expect(key).toBe('user:user-123');
  });

  it('unauthenticated limiter key uses IP', () => {
    expect(resolveIpRateLimitKey({ ip: '198.51.100.7' })).toBe('ip:198.51.100.7');
  });

  it('rate limit errors do not expose submitted secrets', async () => {
    const app = buildApp(authLoginLimiter);
    const body = { identifier: 'secret-user@example.com', password: 'UltraSecret123!' };

    for (let i = 0; i < 9; i += 1) {
      await request(app).post('/limited').send(body);
    }

    const res = await request(app).post('/limited').send(body).expect(429);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(body.identifier);
    expect(serialized).not.toContain(body.password);
  });
});

describe('production Redis requirement for rate limiting', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('does not silently fall back when Redis-backed limits are required', () => {
    jest.resetModules();
    jest.doMock('../../src/config/env', () => ({
      isProduction: true,
      redis: { required: true },
      jwt: { accessSecret: 'a'.repeat(40) },
      rateLimit: { windowMs: 900000, max: 100 },
    }));
    jest.doMock('../../src/config/redis', () => ({
      isReady: false,
      isFallback: true,
      call: jest.fn(),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }));

    expect(() => require('../../src/middlewares/rateLimit')).toThrow(
      'Redis-backed rate limiting is required'
    );
  });
});
