import { configSchema } from '../packages/contracts/src/config.js';

describe('safe configuration', () => {
  const base = { DATABASE_URL: 'postgresql://localhost/copilot' };
  it('defaults to strict and disables demo', () => {
    const config = configSchema.parse(base);
    expect(config.ASSESSMENT_MODE).toBe('strict');
    expect(config.ALLOW_DEMO_MODE).toBe(false);
    expect(config.OLLAMA_FALLBACK_ENABLED).toBe(false);
    expect(config.SESSION_TTL_HOURS).toBe(720);
  });
  it('enforces session TTL bounds up to 30 days (720 hours)', () => {
    expect(configSchema.parse({ ...base, SESSION_TTL_HOURS: '720' }).SESSION_TTL_HOURS).toBe(720);
    expect(configSchema.safeParse({ ...base, SESSION_TTL_HOURS: '721' }).success).toBe(false);
    expect(configSchema.safeParse({ ...base, SESSION_TTL_HOURS: '0' }).success).toBe(false);
  });
  it('does not silently select the real provider when a fake runtime provider was requested', () => {
    expect(() => configSchema.parse({ ...base, LLM_PROVIDER: 'fake' })).toThrow();
  });
  it('does not interpret the string false as truthy', () => {
    expect(configSchema.parse({ ...base, ALLOW_DEMO_MODE: 'false' }).ALLOW_DEMO_MODE).toBe(false);
  });
  it('accepts an explicit local Ollama origin and rejects remote origins and cloud models', () => {
    expect(
      configSchema.parse({
        ...base,
        OLLAMA_FALLBACK_ENABLED: 'true',
        OLLAMA_BASE_URL: 'http://[::1]:11434',
      }).OLLAMA_FALLBACK_ENABLED,
    ).toBe(true);
    expect(
      configSchema.safeParse({ ...base, OLLAMA_BASE_URL: 'https://ollama.example' }).success,
    ).toBe(false);
    expect(configSchema.safeParse({ ...base, OLLAMA_BASE_URL: 'not a URL' }).success).toBe(false);
    expect(configSchema.safeParse({ ...base, OLLAMA_MODEL: 'qwen3:cloud' }).success).toBe(false);
  });

  it('rejects unknown modes and demo without explicit enablement', () => {
    expect(() => configSchema.parse({ ...base, ASSESSMENT_MODE: 'relaxed' })).toThrow();
    expect(() => configSchema.parse({ ...base, ASSESSMENT_MODE: 'demo' })).toThrow();
  });
});
