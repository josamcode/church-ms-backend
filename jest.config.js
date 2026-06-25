module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    'src/modules/users/user.service.js',
    'src/modules/aids/aid.service.js',
    'src/modules/aids/aid.routes.js',
    'src/modules/bookings/bookings.service.js',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  forceExit: true,
  clearMocks: true,
  restoreMocks: true,
};
