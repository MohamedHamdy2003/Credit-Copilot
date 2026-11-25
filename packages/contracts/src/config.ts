import { z } from 'zod';

export const MAX_QUERY_REWRITE_EXPANSIONS = 4;

export const ollamaSettingsSchema = z.object({
  OLLAMA_BASE_URL: z
    .url()
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]', 'ollama'].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
      );
    }, 'Ollama must use a loopback HTTP origin')
    .default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/)
    .refine((name) => !/[-:]cloud$/i.test(name), 'Ollama requires a local model')
    .default('qwen3:4b-instruct-2507-q4_K_M'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(100).max(180000).default(120000),
});
export type OllamaSettings = z.infer<typeof ollamaSettingsSchema>;

export const configSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    EVALUATION_DATABASE_URL: z.string().url().optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    ASSESSMENT_MODE: z.enum(['strict', 'demo']).default('strict'),
    ASSESSMENT_ORCHESTRATION: z.enum(['workflow', 'agents']).default('workflow'),
    ALLOW_DEMO_MODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((s) => s === 'true'),
    LLM_PROVIDER: z.literal('gemini').default('gemini'),
    OLLAMA_FALLBACK_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    ...ollamaSettingsSchema.shape,
    GEMINI_API_KEY: z.string().default(''),
    GEMINI_BILLING_TIER: z.enum(['unknown', 'confirmed_free']).default('unknown'),
    GENERATION_MODEL: z.string().default('gemini-3.5-flash-lite'),
    EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(2000).default(768),
    RETRIEVAL_STRATEGY: z.enum(['hybrid', 'vector']).default('hybrid'),
    RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.65),
    QUERY_REWRITE_MAX_EXPANSIONS: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_QUERY_REWRITE_EXPANSIONS)
      .default(2),
    UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10485760),
    DEMO_PASSWORD: z.string().default(''),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(720),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((s) => s === 'true'),
  })
  .superRefine((config, ctx) => {
    if (config.ASSESSMENT_MODE === 'demo' && !config.ALLOW_DEMO_MODE) {
      ctx.addIssue({
        code: 'custom',
        message: 'Demo default requires ALLOW_DEMO_MODE=true',
        path: ['ASSESSMENT_MODE'],
      });
    }
  });
export type Config = z.infer<typeof configSchema>;
