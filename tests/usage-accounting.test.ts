import { priceAttempt } from '../packages/infrastructure/src/llm/pricing.js';
import { UsageTracker, withUsageStep } from '../packages/infrastructure/src/llm/usage-tracker.js';
import {
  instrumentProvider,
  recordProviderAttempt,
  type ProviderAttempt,
} from '../packages/infrastructure/src/llm/attempt-meter.js';
import type { UsageEvent } from '../packages/contracts/src/usage.js';
import { EvaluationMeter } from '../packages/infrastructure/src/evaluation-meter.js';

const generation: ProviderAttempt = {
  provider: 'gemini',
  model: 'gemini-3.5-flash-lite',
  kind: 'generation',
  retry: false,
  outcome: 'succeeded',
  inputTokens: 1000,
  outputTokens: 200,
};

it('freezes published list rates while leaving unconfirmed charges unknown', () => {
  expect(priceAttempt(generation, 'unknown')).toMatchObject({
    estimatedUsd: '0.00080000',
    actualUsd: null,
    chargeBasis: 'unknown',
    price: { inputUsdPerMillion: '0.30', outputUsdPerMillion: '2.50', currency: 'USD' },
  });
  expect(priceAttempt(generation, 'confirmed_free')).toMatchObject({
    estimatedUsd: '0.00080000',
    actualUsd: '0.00000000',
    chargeBasis: 'confirmed_free_tier',
  });
  expect(priceAttempt({ ...generation, inputTokens: null }, 'unknown')).toMatchObject({
    estimatedUsd: null,
    actualUsd: null,
    price: expect.any(Object),
  });
  expect(
    priceAttempt({ ...generation, provider: 'ollama', model: 'ollama:local' }, 'unknown'),
  ).toMatchObject({
    estimatedUsd: null,
    actualUsd: '0.00000000',
    chargeBasis: 'local',
  });
  expect(priceAttempt({ ...generation, provider: 'unknown' }, 'confirmed_free')).toMatchObject({
    estimatedUsd: null,
    actualUsd: null,
    price: null,
  });
});

it('prices embeddings only from their reported input tokens', () => {
  const embedding = {
    ...generation,
    kind: 'query_embedding' as const,
    model: 'gemini-embedding-001',
    outputTokens: 0,
  };
  expect(priceAttempt(embedding, 'unknown').estimatedUsd).toBe('0.00015000');
  expect(priceAttempt({ ...embedding, inputTokens: null }, 'unknown').estimatedUsd).toBeNull();
});

it('aggregates isolated evaluation attempts and retains known subtotals across missing counts', async () => {
  const evaluation = new EvaluationMeter(
    {
      model: 'gemini-embedding-001',
      dimensions: 1,
      async embed() {
        return [1];
      },
      async completeStructured() {
        recordProviderAttempt(generation);
        return {
          value: {},
          model: generation.model,
          usage: { inputTokens: 1000, outputTokens: 200 },
        };
      },
    },
    undefined,
    0,
    'confirmed_free',
  );
  await withUsageStep('plan_extract_data', () =>
    evaluation.completeStructured('system', 'synthetic'),
  );
  const nextCase = evaluation.events.length;
  await evaluation.embed('synthetic', 'query');
  expect(evaluation.metrics(0).providerAccounting).toMatchObject({
    calls: 2,
    inputTokens: { knownTotal: 1000, missingCalls: 1 },
    estimatedUsd: { knownTotal: '0.00080000', missingCalls: 1 },
    actualUsd: { knownTotal: '0.00000000', missingCalls: 1 },
    attempts: [
      expect.objectContaining({ step: 'plan_extract_data', provider: 'gemini' }),
      expect.objectContaining({ kind: 'query_embedding', provider: 'unknown' }),
    ],
  });
  expect(evaluation.metrics(nextCase).providerAccounting).toMatchObject({
    calls: 1,
    estimatedUsd: { knownTotal: null, missingCalls: 1 },
  });
});

it('retries an ambiguous save with identical event IDs and keeps concurrent attribution scoped', async () => {
  const batches: UsageEvent[][] = [];
  let firstWrite = true;
  const accounting = new UsageTracker(
    {
      record: async (events) => {
        batches.push([...events]);
        if (firstWrite) {
          firstWrite = false;
          throw new Error('Connection ended after writing');
        }
      },
      summarize: async () => {
        throw new Error('Not used');
      },
    },
    'unknown',
  );
  const model = instrumentProvider({
    model: 'fixture-vector',
    dimensions: 1,
    async embed() {
      return [1];
    },
    async completeStructured() {
      await Promise.resolve();
      return { model: 'fixture-text', value: {}, usage: { inputTokens: 12, outputTokens: 8 } };
    },
  });
  await Promise.all([
    accounting.track(
      { actorId: 'person-a', runId: 'run-a', requestId: 'request-a', operation: 'assessment' },
      () => withUsageStep('plan_extract_data', () => model.completeStructured('system', 'data')),
    ),
    accounting.track(
      { actorId: 'person-b', requestId: 'request-b', operation: 'policy_question' },
      () => model.embed('query', 'query'),
    ),
  ]);
  expect(batches).toHaveLength(3);
  expect(new Set(batches.flat().map((event) => event.id)).size).toBe(2);
  expect(batches.flat()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actorId: 'person-a',
        runId: 'run-a',
        requestId: 'request-a',
        step: 'plan_extract_data',
        inputTokens: 12,
      }),
      expect.objectContaining({
        actorId: 'person-b',
        runId: null,
        requestId: 'request-b',
        step: 'retrieve',
        inputTokens: null,
      }),
    ]),
  );
});
