import { z } from 'zod';
import type { OllamaSettings } from '../../../contracts/src/config.js';
import type {
  Completion,
  GenerationPort,
  GenerationSchema,
  Usage,
} from '../../../application/src/ports.js';
import { DomainError } from '../../../domain/src/errors.js';
import {
  markNativeProviderOperation,
  providerTokenCount,
  recordProviderAttempt,
  type ProviderAttempt,
} from './attempt-meter.js';

const chatResponse = z.object({
  done: z.literal(true),
  done_reason: z.string().optional(),
  message: z.object({ content: z.string() }),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
});
const chatCounters = z.object({
  prompt_eval_count: z.unknown().optional(),
  eval_count: z.unknown().optional(),
});

export class OllamaAdapter implements GenerationPort {
  constructor(private readonly settings: OllamaSettings) {}

  async completeStructured(
    system: string,
    data: string,
    schema?: GenerationSchema,
  ): Promise<Completion> {
    markNativeProviderOperation();
    const model = `ollama:${this.settings.OLLAMA_MODEL}`;
    const unavailable = () =>
      new DomainError('ProviderUnavailable', 'Local Ollama generation is unavailable', 503, {
        model,
      });
    const endpoint = new URL('/api/chat', this.settings.OLLAMA_BASE_URL);
    const payload = JSON.stringify({
      model: this.settings.OLLAMA_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: data },
      ],
      stream: false,
      format: schema ?? 'json',
      options: { temperature: 0, num_ctx: 8192 },
    });
    const signal = AbortSignal.timeout(this.settings.OLLAMA_TIMEOUT_MS);
    const usage: Usage = { inputTokens: null, outputTokens: null };
    let outcome: ProviderAttempt['outcome'] = 'failed';
    try {
      let raw: unknown;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          redirect: 'error',
          signal,
          body: payload,
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
      const counters = chatCounters.safeParse(raw).data;
      usage.inputTokens = providerTokenCount(counters?.prompt_eval_count);
      usage.outputTokens = providerTokenCount(counters?.eval_count);
      const result = chatResponse.safeParse(raw);
      if (!result.success)
        throw new DomainError('InvalidLLMOutput', 'Local Ollama response is incomplete', 422, {
          model,
          ...usage,
        });
      let value: unknown;
      try {
        if (result.data.done_reason === 'length') throw new Error('Output limit reached');
        value = JSON.parse(result.data.message.content);
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
      outcome = 'succeeded';
      return { model, usage, value };
    } finally {
      recordProviderAttempt({
        provider: 'ollama',
        model,
        kind: 'generation',
        outcome,
        retry: false,
        ...usage,
      });
    }
  }
}
