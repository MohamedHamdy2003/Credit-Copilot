import { z } from 'zod';
import type { OllamaSettings } from '../../../contracts/src/config.js';
import type {
  Completion,
  GenerationPort,
  GenerationSchema,
} from '../../../application/src/ports.js';
import { DomainError } from '../../../domain/src/errors.js';

const chatResponse = z.object({
  done: z.literal(true),
  done_reason: z.string().optional(),
  message: z.object({ content: z.string() }),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
});

export class OllamaAdapter implements GenerationPort {
  constructor(private readonly settings: OllamaSettings) {}

  async completeStructured(
    system: string,
    data: string,
    schema?: GenerationSchema,
  ): Promise<Completion> {
    const model = `ollama:${this.settings.OLLAMA_MODEL}`;
    const unavailable = () =>
      new DomainError('ProviderUnavailable', 'Local Ollama generation is unavailable', 503, {
        model,
      });
    let raw: unknown;
    try {
      const response = await fetch(new URL('/api/chat', this.settings.OLLAMA_BASE_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.settings.OLLAMA_TIMEOUT_MS),
        body: JSON.stringify({
          model: this.settings.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: data },
          ],
          stream: false,
          format: schema ?? 'json',
          options: { temperature: 0, num_ctx: 8192 },
        }),
      });
      if (!response.ok) throw unavailable();
      raw = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new DomainError('InvalidLLMOutput', 'Local Ollama returned invalid JSON', 422, {
          model,
        });
      throw unavailable();
    }
    const result = chatResponse.safeParse(raw);
    if (!result.success)
      throw new DomainError('InvalidLLMOutput', 'Local Ollama response is incomplete', 422, {
        model,
      });
    const usage = {
      inputTokens: result.data.prompt_eval_count ?? null,
      outputTokens: result.data.eval_count ?? null,
    };
    try {
      if (result.data.done_reason === 'length') throw new Error('Output limit reached');
      const value: unknown = JSON.parse(result.data.message.content);
      return { model, usage, value };
    } catch {
      throw new DomainError(
        'InvalidLLMOutput',
        'Local Ollama returned invalid generated JSON',
        422,
        {
          model,
          ...usage,
        },
      );
    }
  }
}
