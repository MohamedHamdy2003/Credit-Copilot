import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Completion,
  EmbeddingPort,
  GenerationPort,
  Usage,
} from '../../../application/src/ports.js';
import { DomainError } from '../../../domain/src/errors.js';

export interface ProviderAttempt extends Usage {
  provider: 'gemini' | 'ollama' | 'unknown';
  model: string;
  kind: 'generation' | 'query_embedding' | 'document_embedding';
  outcome: 'succeeded' | 'failed';
  retry: boolean;
  fallbackFrom?: string;
}

interface AttemptScope {
  observer: (attempt: ProviderAttempt) => void;
  markHandled?: () => void;
  fallbackFrom?: string;
}

const scopes = new AsyncLocalStorage<AttemptScope>();

export function withProviderAttemptObserver<T>(
  observer: (attempt: ProviderAttempt) => void,
  work: () => Promise<T>,
): Promise<T> {
  return scopes.run({ observer }, work);
}

export function runProviderFallback<T>(fallbackFrom: string, work: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  return scope ? scopes.run({ ...scope, fallbackFrom }, work) : work();
}

export function markNativeProviderOperation() {
  scopes.getStore()?.markHandled?.();
}

export function recordProviderAttempt(attempt: ProviderAttempt) {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.markHandled?.();
  const fallbackFrom = attempt.fallbackFrom ?? scope.fallbackFrom;
  try {
    scope.observer(fallbackFrom ? { ...attempt, fallbackFrom } : attempt);
  } catch {
    // The observer is separate from provider success, failure, and retry decisions.
  }
}

export const providerTokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export const embeddingAttemptKind = (purpose: 'document' | 'query') =>
  purpose === 'document' ? 'document_embedding' : 'query_embedding';

function observeLogicalCall<T>(
  kind: ProviderAttempt['kind'],
  defaultModel: string,
  work: () => Promise<T>,
  reported: (value: T) => { model: string; usage: Usage; fallbackFrom?: string },
): Promise<T> {
  const scope = scopes.getStore();
  if (!scope) return work();
  let handled = false;
  const markHandled = () => {
    handled = true;
    scope.markHandled?.();
  };
  return scopes.run({ ...scope, markHandled }, async () => {
    function emit(
      model: string,
      outcome: ProviderAttempt['outcome'],
      inputTokens: unknown,
      outputTokens: unknown,
      fallbackFrom?: string,
    ) {
      if (fallbackFrom && fallbackFrom !== scope?.fallbackFrom) {
        recordProviderAttempt({
          provider: 'unknown',
          model: fallbackFrom,
          kind,
          outcome: 'failed',
          retry: false,
          inputTokens: null,
          outputTokens: kind === 'generation' ? null : 0,
        });
      }
      recordProviderAttempt({
        provider: 'unknown',
        model,
        kind,
        outcome,
        retry: false,
        inputTokens: providerTokenCount(inputTokens),
        outputTokens: kind === 'generation' ? providerTokenCount(outputTokens) : 0,
        ...(fallbackFrom ? { fallbackFrom } : {}),
      });
    }
    try {
      const value = await work();
      if (!handled) {
        const { model, usage, fallbackFrom } = reported(value);
        emit(model, 'succeeded', usage.inputTokens, usage.outputTokens, fallbackFrom);
      }
      return value;
    } catch (error) {
      if (!handled) {
        const { model, inputTokens, outputTokens, fallbackFrom } =
          error instanceof DomainError ? error.details : {};
        emit(
          typeof model === 'string' ? model : defaultModel,
          'failed',
          inputTokens,
          outputTokens,
          typeof fallbackFrom === 'string' ? fallbackFrom : undefined,
        );
      }
      throw error;
    }
  });
}

export function observeGeneration(work: () => Promise<Completion>): Promise<Completion> {
  return observeLogicalCall(
    'generation',
    'provider-not-reported',
    work,
    (completion) => completion,
  );
}

export function observeEmbedding(
  model: string,
  purpose: 'document' | 'query',
  work: () => Promise<number[]>,
): Promise<number[]> {
  return observeLogicalCall(embeddingAttemptKind(purpose), model, work, () => ({
    model,
    usage: { inputTokens: null, outputTokens: 0 },
  }));
}

/** Instrument injected providers while leaving native operation and retry counts authoritative. */
export function instrumentProvider(
  provider: GenerationPort & EmbeddingPort,
): GenerationPort & EmbeddingPort {
  return {
    get model() {
      return provider.model;
    },
    get dimensions() {
      return provider.dimensions;
    },
    completeStructured: (system, data, schema) =>
      observeGeneration(() => provider.completeStructured(system, data, schema)),
    embed: (text, purpose) =>
      observeEmbedding(provider.model, purpose, () => provider.embed(text, purpose)),
  };
}
