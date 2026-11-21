import { DomainError } from '../packages/domain/src/errors.js';
import {
  instrumentProvider,
  withProviderAttemptObserver,
  type ProviderAttempt,
} from '../packages/infrastructure/src/llm/attempt-meter.js';
import { GenerationFallback } from '../packages/infrastructure/src/llm/provider.js';

const injectable = {
  model: 'fake-embedding',
  dimensions: 2,
  embed: async () => [1, 0],
  completeStructured: async () => ({
    value: {},
    model: 'fake-generation',
    usage: { inputTokens: 7, outputTokens: 0 },
  }),
};

it('keeps concurrent calls in their respective request scopes and does not duplicate nested wrappers', async () => {
  const provider = instrumentProvider(instrumentProvider(injectable));
  const generation: ProviderAttempt[] = [];
  const embedding: ProviderAttempt[] = [];
  await Promise.all([
    withProviderAttemptObserver(
      (attempt) => generation.push(attempt),
      () => provider.completeStructured('private prompt', 'private data'),
    ),
    withProviderAttemptObserver(
      (attempt) => embedding.push(attempt),
      () => provider.embed('private query', 'query'),
    ),
  ]);
  expect(generation).toEqual([
    {
      provider: 'unknown',
      model: 'fake-generation',
      kind: 'generation',
      retry: false,
      outcome: 'succeeded',
      inputTokens: 7,
      outputTokens: 0,
    },
  ]);
  expect(embedding).toEqual([
    {
      provider: 'unknown',
      model: 'fake-embedding',
      kind: 'query_embedding',
      retry: false,
      outcome: 'succeeded',
      inputTokens: null,
      outputTokens: 0,
    },
  ]);
});

it('preserves injected fallback attribution without adding a synthetic duplicate of either attempt', async () => {
  const provider = instrumentProvider(
    new GenerationFallback(
      {
        ...injectable,
        completeStructured: async () => {
          throw new DomainError('ProviderUnavailable', 'Simulated retryable outage', 503, {
            model: 'gemini-fake',
            retryable: true,
          });
        },
      },
      {
        completeStructured: async () => ({
          ...(await injectable.completeStructured()),
          model: 'ollama:fake',
        }),
      },
    ),
  );
  const attempts: ProviderAttempt[] = [];
  await withProviderAttemptObserver(
    (attempt) => attempts.push(attempt),
    () => provider.completeStructured('private prompt', 'private data'),
  );
  expect(attempts).toEqual([
    {
      provider: 'unknown',
      model: 'gemini-fake',
      kind: 'generation',
      retry: false,
      outcome: 'failed',
      inputTokens: null,
      outputTokens: null,
    },
    {
      provider: 'unknown',
      model: 'ollama:fake',
      kind: 'generation',
      retry: false,
      outcome: 'succeeded',
      inputTokens: 7,
      outputTokens: 0,
      fallbackFrom: 'gemini-fake',
    },
  ]);
});

it('preserves the fallback pair returned by an injected provider that exposes a combined result', async () => {
  const provider = instrumentProvider({
    ...injectable,
    completeStructured: async () => ({
      ...(await injectable.completeStructured()),
      model: 'ollama:fake',
      fallbackFrom: 'gemini-fake',
    }),
  });
  const attempts: ProviderAttempt[] = [];
  await withProviderAttemptObserver(
    (attempt) => attempts.push(attempt),
    () => provider.completeStructured('system', 'data'),
  );
  expect(attempts.map((attempt) => [attempt.model, attempt.outcome, attempt.fallbackFrom])).toEqual(
    [
      ['gemini-fake', 'failed', undefined],
      ['ollama:fake', 'succeeded', 'gemini-fake'],
    ],
  );
});
