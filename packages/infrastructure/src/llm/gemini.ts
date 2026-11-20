import type { Completion, EmbeddingPort, GenerationPort } from '../../../application/src/ports.js';
import { DomainError, invariant } from '../../../domain/src/errors.js';
import { z } from 'zod';

const completionSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }),
      }),
    )
    .min(1),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
    })
    .optional(),
});
export class GeminiAdapter implements GenerationPort, EmbeddingPort {
  constructor(
    private readonly apiKey: string,
    private readonly generationModel: string,
    public readonly model: string,
    public readonly dimensions: number,
  ) {}
  private async request(model: string, operation: string, body: unknown): Promise<unknown> {
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
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:${operation}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: JSON.stringify(body),
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
        return await response.json();
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
      }
    }
    throw new DomainError('ProviderUnavailable', 'Provider retries exhausted', 503, {
      model,
      retryable: true,
    });
  }
  async completeStructured(system: string, data: string): Promise<Completion> {
    const raw = await this.request(this.generationModel, 'generateContent', {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: data }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    });
    const result = completionSchema.safeParse(raw);
    if (!result.success)
      throw new DomainError(
        'InvalidLLMOutput',
        'Provider response is not valid structured content',
      );
    const text = result.data.candidates[0]!.content.parts.map((p) => p.text ?? '').join('');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new DomainError('InvalidLLMOutput', 'Model did not return JSON', 422, {
        model: this.generationModel,
        inputTokens: result.data.usageMetadata?.promptTokenCount ?? null,
        outputTokens: result.data.usageMetadata?.candidatesTokenCount ?? null,
      });
    }
    return {
      value,
      model: this.generationModel,
      usage: {
        inputTokens: result.data.usageMetadata?.promptTokenCount ?? null,
        outputTokens: result.data.usageMetadata?.candidatesTokenCount ?? null,
      },
    };
  }
  async embed(text: string, purpose: 'document' | 'query'): Promise<number[]> {
    const result = z
      .object({ embedding: z.object({ values: z.array(z.number().finite()) }) })
      .safeParse(
        await this.request(this.model, 'embedContent', {
          content: { parts: [{ text }] },
          taskType: purpose === 'document' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY',
          outputDimensionality: this.dimensions,
        }),
      );
    if (!result.success) throw new DomainError('EmbeddingFailure', 'Invalid embedding response');
    const vector = result.data.embedding.values;
    const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
    invariant(
      vector.length === this.dimensions && norm > 0,
      'EmbeddingFailure',
      'Embedding dimensions or norm invalid',
    );
    return vector.map((n) => n / norm);
  }
}
