module.exports = {
  ...require('./jest.config.cjs'),
  testMatch: ['<rootDir>/tests/**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 60000,
};
