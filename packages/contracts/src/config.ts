import { z } from 'zod';

export const configSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    ASSESSMENT_MODE: z.enum(['strict', 'demo']).default('strict'),
    ALLOW_DEMO_MODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((s) => s === 'true'),
    LLM_PROVIDER: z.enum(['gemini', 'fake']).default('gemini'),
    GEMINI_API_KEY: z.string().default(''),
    GENERATION_MODEL: z.string().default('gemini-3.5-flash-lite'),
    EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(2000).default(768),
    RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.65),
    UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10485760),
    DATA_DIR: z.string().default('./data/runtime'),
    DEMO_PASSWORD: z.string().default(''),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(8),
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
