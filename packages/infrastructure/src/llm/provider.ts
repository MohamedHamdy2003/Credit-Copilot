import type { Config, OllamaSettings } from '../../../contracts/src/config.js';
import {
  generationProviderUpdateSchema,
  type GenerationMode,
  type GenerationProviderUpdate,
  type LlmProviderStatus,
} from '../../../contracts/src/llm.js';
import type {
  Completion,
  EmbeddingPort,
  GenerationPort,
  GenerationSchema,
} from '../../../application/src/ports.js';
import { DomainError, invariant } from '../../../domain/src/errors.js';
import { GeminiAdapter } from './gemini.js';
import { listOllamaModels, OllamaAdapter } from './ollama.js';
import { observeEmbedding, observeGeneration, runProviderFallback } from './attempt-meter.js';

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
    return observeEmbedding(this.model, purpose, () => this.primary.embed(text, purpose));
  }

  async completeStructured(
    system: string,
    data: string,
    schema?: GenerationSchema,
  ): Promise<Completion> {
    try {
      return await observeGeneration(() => this.primary.completeStructured(system, data, schema));
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
        const completion = await runProviderFallback(fallbackFrom, () =>
          observeGeneration(() => this.local.completeStructured(system, data, schema)),
        );
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

export interface RuntimeProviderControl {
  status(canManage: boolean): Promise<LlmProviderStatus>;
  configure(update: GenerationProviderUpdate): Promise<LlmProviderStatus>;
}

export class RuntimeGenerationProvider
  implements GenerationPort, EmbeddingPort, RuntimeProviderControl
{
  private mode: GenerationMode;
  private ollamaModel: string;

  constructor(
    private readonly primary: GenerationPort & EmbeddingPort,
    private readonly options: {
      geminiConfigured: boolean;
      geminiModel: string;
      ollama: OllamaSettings;
      initialMode: GenerationMode;
      localFactory?: (settings: OllamaSettings) => GenerationPort;
      probeOllama?: (baseUrl: string) => Promise<{ reachable: boolean; models: string[] }>;
    },
  ) {
    this.mode = options.initialMode;
    this.ollamaModel = options.ollama.OLLAMA_MODEL;
  }

  get model() {
    return this.primary.model;
  }

  get dimensions() {
    return this.primary.dimensions;
  }

  private localAdapter() {
    const settings: OllamaSettings = { ...this.options.ollama, OLLAMA_MODEL: this.ollamaModel };
    return this.options.localFactory
      ? this.options.localFactory(settings)
      : new OllamaAdapter(settings);
  }

  private probe() {
    return this.options.probeOllama
      ? this.options.probeOllama(this.options.ollama.OLLAMA_BASE_URL)
      : listOllamaModels(this.options.ollama.OLLAMA_BASE_URL);
  }

  embed(text: string, purpose: 'document' | 'query') {
    return observeEmbedding(this.model, purpose, () => this.primary.embed(text, purpose));
  }

  completeStructured(system: string, data: string, schema?: GenerationSchema): Promise<Completion> {
    if (this.mode === 'ollama') {
      return observeGeneration(() => this.localAdapter().completeStructured(system, data, schema));
    }
    if (this.mode === 'auto') {
      return new GenerationFallback(this.primary, this.localAdapter()).completeStructured(
        system,
        data,
        schema,
      );
    }
    return observeGeneration(() => this.primary.completeStructured(system, data, schema));
  }

  private resolveOllamaModel(models: string[], requested?: string): string {
    if (requested) return requested;
    if (models.length > 0 && !models.includes(this.ollamaModel)) return models[0]!;
    return this.ollamaModel;
  }

  private buildStatus(
    ollama: { reachable: boolean; models: string[] },
    canManage: boolean,
  ): LlmProviderStatus {
    return {
      mode: this.mode,
      activeProvider: this.mode === 'ollama' ? 'ollama' : 'gemini',
      activeModel: this.mode === 'ollama' ? `ollama:${this.ollamaModel}` : this.options.geminiModel,
      geminiConfigured: this.options.geminiConfigured,
      geminiModel: this.options.geminiModel,
      ollamaReachable: ollama.reachable,
      ollamaBaseUrl: this.options.ollama.OLLAMA_BASE_URL,
      ollamaModel: this.ollamaModel,
      ollamaModels: ollama.models,
      canManage,
    };
  }

  async status(canManage: boolean): Promise<LlmProviderStatus> {
    const ollama = await this.probe();
    if (ollama.reachable && ollama.models.length > 0 && !ollama.models.includes(this.ollamaModel)) {
      this.ollamaModel = ollama.models[0]!;
    }
    return this.buildStatus(ollama, canManage);
  }

  async configure(raw: GenerationProviderUpdate): Promise<LlmProviderStatus> {
    const update = generationProviderUpdateSchema.parse(raw);
    const ollama = await this.probe();
    const nextModel = ollama.reachable
      ? this.resolveOllamaModel(ollama.models, update.ollamaModel)
      : (update.ollamaModel ?? this.ollamaModel);
    if (update.mode === 'ollama') {
      invariant(
        ollama.reachable,
        'OllamaUnavailable',
        'Local Ollama server is not reachable. Start it with: docker compose --profile local-llm up -d ollama',
        503,
      );
      invariant(
        ollama.models.length > 0 && ollama.models.includes(nextModel),
        'OllamaModelNotFound',
        ollama.models.length === 0
          ? 'No Ollama models are pulled locally. Pull one with: docker compose exec -T ollama ollama pull qwen3:4b-instruct-2507-q4_K_M'
          : `Ollama model "${nextModel}" is not pulled locally`,
        422,
      );
    } else if (update.mode === 'auto' && update.ollamaModel && ollama.reachable) {
      invariant(
        ollama.models.includes(nextModel),
        'OllamaModelNotFound',
        `Ollama model "${nextModel}" is not pulled locally`,
        422,
      );
    }
    this.mode = update.mode;
    this.ollamaModel = nextModel;
    return this.buildStatus(ollama, true);
  }
}

export function createRuntimeProvider(config: Config): RuntimeGenerationProvider {
  const gemini = new GeminiAdapter(
    config.GEMINI_API_KEY,
    config.GENERATION_MODEL,
    config.EMBEDDING_MODEL,
    config.EMBEDDING_DIMENSIONS,
  );
  return new RuntimeGenerationProvider(gemini, {
    geminiConfigured: config.GEMINI_API_KEY.trim().length > 0,
    geminiModel: config.GENERATION_MODEL,
    ollama: {
      OLLAMA_BASE_URL: config.OLLAMA_BASE_URL,
      OLLAMA_MODEL: config.OLLAMA_MODEL,
      OLLAMA_TIMEOUT_MS: config.OLLAMA_TIMEOUT_MS,
    },
    initialMode: config.OLLAMA_FALLBACK_ENABLED ? 'auto' : 'gemini',
  });
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
