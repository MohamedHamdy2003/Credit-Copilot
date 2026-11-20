import { configSchema } from '../packages/contracts/src/config.js';

describe('safe configuration', () => {
  const base = { DATABASE_URL: 'postgresql://localhost/copilot' };
  it('defaults to strict and disables demo', () => {
    const config = configSchema.parse(base);
    expect(config.ASSESSMENT_MODE).toBe('strict');
    expect(config.ALLOW_DEMO_MODE).toBe(false);
  });
  it('does not silently select the real provider when a fake runtime provider was requested', () => {
    expect(() => configSchema.parse({ ...base, LLM_PROVIDER: 'fake' })).toThrow();
  });
  it('does not interpret the string false as truthy', () => {
    expect(configSchema.parse({ ...base, ALLOW_DEMO_MODE: 'false' }).ALLOW_DEMO_MODE).toBe(false);
  });
  it('rejects unknown modes and demo without explicit enablement', () => {
    expect(() => configSchema.parse({ ...base, ASSESSMENT_MODE: 'relaxed' })).toThrow();
    expect(() => configSchema.parse({ ...base, ASSESSMENT_MODE: 'demo' })).toThrow();
  });
});
