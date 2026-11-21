import type {
  Completion,
  EmbeddingPort,
  GenerationPort,
  Usage,
} from '../../../application/src/ports.js';
import { DomainError, invariant } from '../../../domain/src/errors.js';
import { z } from 'zod';
import {
  embeddingAttemptKind,
  markNativeProviderOperation,
  providerTokenCount,
  recordProviderAttempt,
  type ProviderAttempt,
} from './attempt-meter.js';

const completionSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }),
      }),
    )
    .min(1),
});
const usageMetadataSchema = z.object({
  usageMetadata: z.object({
    promptTokenCount: z.unknown().optional(),
    candidatesTokenCount: z.unknown().optional(),
    thoughtsTokenCount: z.unknown().optional(),
  }),
});
const embeddingSchema = z.object({ embedding: z.object({ values: z.array(z.number().finite()) }) });

export class GeminiAdapter implements GenerationPort, EmbeddingPort {
  constructor(
    private readonly apiKey: string,
    private readonly generationModel: string,
    public readonly model: string,
    public readonly dimensions: number,
  ) {}
  private async request<T>(
    model: string,
    kind: ProviderAttempt['kind'],
    body: unknown,
    parse: (raw: unknown, usage: Usage) => T,
  ): Promise<T> {
    markNativeProviderOperation();
    invariant(
      this.apiKey.length > 0,
      'ProviderNotConfigured',
      'GEMINI_API_KEY is not configured',
      503,
    );
    invariant(
      /^[a-zA-Z0-9._-]+$/.test(model),
      'InvalidModelConfiguration',
      'Invalid provider model identifier',
    );
    const isGeneration = kind === 'generation';
    const operation = isGeneration ? 'generateContent' : 'embedContent';
    const payload = JSON.stringify(body);
    for (let attempt = 0; attempt < 3; attempt++) {
      const usage: Usage = { inputTokens: null, outputTokens: isGeneration ? null : 0 };
      let outcome: ProviderAttempt['outcome'] = 'failed';
      let meteredOutput: number | null = isGeneration ? null : 0;
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:${operation}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: payload,
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!response.ok) {
          const retryable =
            response.status === 408 || response.status === 429 || response.status >= 500;
          if (retryable && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            continue;
          }
          throw new DomainError(
            'ProviderUnavailable',
            `Provider request failed (HTTP ${response.status})`,
            503,
            { model, retryable },
          );
        }
        const raw: unknown = await response.json();
        const counters = usageMetadataSchema.safeParse(raw).data?.usageMetadata;
        usage.inputTokens = providerTokenCount(counters?.promptTokenCount);
        if (isGeneration) {
          usage.outputTokens = providerTokenCount(counters?.candidatesTokenCount);
          const thoughtsTokens =
            counters?.thoughtsTokenCount === undefined
              ? 0
              : providerTokenCount(counters.thoughtsTokenCount);
          if (usage.outputTokens !== null && thoughtsTokens !== null)
            meteredOutput = providerTokenCount(usage.outputTokens + thoughtsTokens);
        }
        const result = parse(raw, usage);
        outcome = 'succeeded';
        return result;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if (error instanceof SyntaxError)
          throw new DomainError('InvalidLLMOutput', 'Provider response is not valid JSON', 422, {
            model,
          });
        if (attempt === 2)
          throw new DomainError(
            'ProviderUnavailable',
            'Provider timed out or could not be reached',
            503,
            { model, retryable: true },
          );
      } finally {
        recordProviderAttempt({
          provider: 'gemini',
          model,
          kind,
          outcome,
          retry: attempt > 0,
          inputTokens: usage.inputTokens,
          outputTokens: meteredOutput,
        });
      }
    }
    throw new DomainError('ProviderUnavailable', 'Provider retries exhausted', 503, {
      model,
      retryable: true,
    });
  }
  completeStructured(system: string, data: string): Promise<Completion> {
    const model = this.generationModel;
    return this.request(
      model,
      'generation',
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: data }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      },
      (raw, usage) => {
        const content = completionSchema.safeParse(raw);
        if (!content.success)
          throw new DomainError(
            'InvalidLLMOutput',
            'Provider response is not valid structured content',
            422,
            { model, ...usage },
          );
        const text = content.data.candidates[0]!.content.parts.map((p) => p.text ?? '').join('');
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new DomainError('InvalidLLMOutput', 'Model did not return JSON', 422, {
            model,
            ...usage,
          });
        }
        return { model, usage, value };
      },
    );
  }
  embed(text: string, purpose: 'document' | 'query'): Promise<number[]> {
    return this.request(
      this.model,
      embeddingAttemptKind(purpose),
      {
        content: { parts: [{ text }] },
        taskType: purpose === 'document' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY',
        outputDimensionality: this.dimensions,
      },
      (raw) => {
        const result = embeddingSchema.safeParse(raw);
        if (!result.success)
          throw new DomainError('EmbeddingFailure', 'Invalid embedding response');
        const vector = result.data.embedding.values;
        const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
        invariant(
          vector.length === this.dimensions && norm > 0,
          'EmbeddingFailure',
          'Embedding dimensions or norm invalid',
        );
        return vector.map((n) => n / norm);
      },
    );
  }
}
