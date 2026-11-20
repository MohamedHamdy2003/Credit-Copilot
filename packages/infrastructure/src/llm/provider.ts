import type { Config } from '../../../contracts/src/config.js';
import type {
  Completion,
  EmbeddingPort,
  GenerationPort,
  GenerationSchema,
} from '../../../application/src/ports.js';
import { DomainError } from '../../../domain/src/errors.js';
import { GeminiAdapter } from './gemini.js';
import { OllamaAdapter } from './ollama.js';

export class GenerationFallback implements GenerationPort, EmbeddingPort {
  constructor(
    private readonly primary: GenerationPort & EmbeddingPort,
    private readonly local: GenerationPort,
  ) {}

  get model() {
    return this.primary.model;
  }

  get dimensions() {
    return this.primary.dimensions;
  }

  embed(text: string, purpose: 'document' | 'query') {
    return this.primary.embed(text, purpose);
  }

  async completeStructured(
    system: string,
    data: string,
    schema?: GenerationSchema,
  ): Promise<Completion> {
    try {
      return await this.primary.completeStructured(system, data, schema);
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        error.code !== 'ProviderUnavailable' ||
        error.details.retryable !== true ||
        typeof error.details.model !== 'string'
      )
        throw error;
      const fallbackFrom = error.details.model;
      try {
        const completion = await this.local.completeStructured(system, data, schema);
        return { ...completion, fallbackFrom };
      } catch (localError) {
        if (!(localError instanceof DomainError)) throw localError;
        throw new DomainError(localError.code, localError.message, localError.status, {
          ...localError.details,
          fallbackFrom,
        });
      }
    }
  }
}

export function createProvider(config: Config): GenerationPort & EmbeddingPort {
  const gemini = new GeminiAdapter(
    config.GEMINI_API_KEY,
    config.GENERATION_MODEL,
    config.EMBEDDING_MODEL,
    config.EMBEDDING_DIMENSIONS,
  );
  return config.OLLAMA_FALLBACK_ENABLED
    ? new GenerationFallback(gemini, new OllamaAdapter(config))
    : gemini;
}
