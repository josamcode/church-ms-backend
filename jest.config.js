module.exports = {
  testEnvironment: 'node',

  // `roots` must include `src` as well as `tests`. With `roots: ['<rootDir>/tests']`
  // Jest never walks `src`, so every file in `collectCoverageFrom` that no test
  // happens to require is silently dropped from the report — which is why
  // coverage/lcov.info used to be written as a zero-byte file.
  roots: ['<rootDir>/tests', '<rootDir>/src'],

  // Anchored so that widening `roots` does not make Jest treat anything under
  // `src` as a test suite.
  testMatch: ['<rootDir>/tests/**/*.test.js'],

  // Integration suites need a real MongoDB; they run from
  // jest.integration.config.js via `npm run test:integration`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/'],

  collectCoverageFrom: [
    'src/**/*.js',
    // Entry point and wiring: exercised by running the server, not by unit tests.
    '!src/server.js',
    '!src/app.js',
    // Generated/derived surface with no branching logic worth gating.
    '!src/docs/**',
    // Index barrels re-export only.
    '!src/**/index.js',
  ],

  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov', 'json-summary', 'json'],

  // Thresholds are a ratchet, not an aspiration: they are set just under the
  // measured value so any regression fails CI, and are raised as coverage grows.
  // `global` is deliberately modest because most of `src` is still uncovered;
  // the per-file entries pin the modules that security tests actually exercise.
  coverageThreshold: {
    global: {
      statements: 16,
      branches: 10,
      functions: 14,
      lines: 16,
    },
    'src/modules/bookings/bookings.service.js': {
      statements: 37,
      branches: 27,
      functions: 36,
      lines: 38,
    },
    'src/modules/aids/aid.service.js': {
      statements: 30,
      branches: 10,
      functions: 26,
      lines: 29,
    },
    'src/utils/sanitizeNotificationLink.js': {
      statements: 90,
      branches: 85,
      functions: 100,
      lines: 90,
    },
  },

  verbose: true,
  forceExit: true,
  clearMocks: true,
  restoreMocks: true,
};
