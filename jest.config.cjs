module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: { module: 'ESNext', moduleResolution: 'Bundler', isolatedModules: true } }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.ts$'],
  collectCoverageFrom: ['packages/domain/src/**/*.ts', 'packages/application/src/**/*.ts'],
};
