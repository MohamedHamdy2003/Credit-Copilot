import { z } from 'zod';

export const GENERATION_MODES = ['gemini', 'auto', 'ollama'] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export const generationProviderUpdateSchema = z
  .object({
    mode: z.enum(GENERATION_MODES),
    ollamaModel: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/, 'Invalid Ollama model name')
      .refine((name) => !/[-:]cloud$/i.test(name), 'Ollama requires a local model')
      .optional(),
  })
  .strict();

export type GenerationProviderUpdate = z.infer<typeof generationProviderUpdateSchema>;

export interface LlmProviderStatus {
  mode: GenerationMode;
  activeProvider: 'gemini' | 'ollama';
  activeModel: string;
  geminiConfigured: boolean;
  geminiModel: string;
  ollamaReachable: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaModels: string[];
  canManage: boolean;
}
