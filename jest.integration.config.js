/**
 * Integration test project.
 *
 * Split from the default config because these suites need a real MongoDB and
 * are therefore slower and environment-dependent. Keeping them out of
 * `npm test` means the unit gate stays fast and hermetic; CI runs both.
 *
 * Backend selection (see tests/helpers/mongo.js):
 *   - `MONGO_TEST_URI` set  → use that server
 *   - otherwise             → spawn mongodb-memory-server
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['<rootDir>/tests/integration/**/*.test.js'],

  // Cold-cache `mongod` download plus server startup.
  testTimeout: 120000,

  // Integration suites share one server; running files in parallel would make
  // the shared-database teardown race.
  maxWorkers: 1,

  verbose: true,
  forceExit: true,
  clearMocks: true,
  restoreMocks: true,
};
