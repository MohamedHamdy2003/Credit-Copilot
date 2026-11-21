import { GeminiAdapter } from '../packages/infrastructure/src/llm/gemini.js';
import {
  instrumentProvider,
  withProviderAttemptObserver,
  type ProviderAttempt,
} from '../packages/infrastructure/src/llm/attempt-meter.js';

const fetchBeforeTest = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchBeforeTest;
});

it('retains reported token counts on invalid generated JSON without exposing raw provider text', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'not JSON: private provider data' }] } }],
        usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 3, thoughtsTokenCount: 5 },
      }),
    );
  const model = new GeminiAdapter('test-only-key', 'test-model', 'test-embedding', 64);
  const attempts: ProviderAttempt[] = [];
  await expect(
    withProviderAttemptObserver(
      (attempt) => attempts.push(attempt),
      () => model.completeStructured('system', 'data'),
    ),
  ).rejects.toMatchObject({
    code: 'InvalidLLMOutput',
    details: { model: 'test-model', inputTokens: 17, outputTokens: 3 },
  });
  expect(attempts).toEqual([
    {
      kind: 'generation',
      provider: 'gemini',
      model: 'test-model',
      retry: false,
      outcome: 'failed',
      inputTokens: 17,
      outputTokens: 8,
    },
  ]);
});

it('keeps sent embedding operations distinct and preserves only reported input counts', async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { taskType: string };
    return Response.json({
      embedding: { values: [1, 0] },
      ...(body.taskType === 'RETRIEVAL_QUERY' ? { usageMetadata: { promptTokenCount: 0 } } : {}),
    });
  };
  const model = instrumentProvider(
    new GeminiAdapter('test-only-key', 'test-model', 'test-embedding', 2),
  );
  const attempts: ProviderAttempt[] = [];
  await withProviderAttemptObserver(
    (attempt) => attempts.push(attempt),
    async () => {
      await model.embed('question', 'query');
      await model.embed('policy', 'document');
    },
  );
  expect(attempts).toEqual([
    {
      kind: 'query_embedding',
      provider: 'gemini',
      model: 'test-embedding',
      retry: false,
      outcome: 'succeeded',
      inputTokens: 0,
      outputTokens: 0,
    },
    {
      kind: 'document_embedding',
      provider: 'gemini',
      model: 'test-embedding',
      retry: false,
      outcome: 'succeeded',
      inputTokens: null,
      outputTokens: 0,
    },
  ]);
});

it('does not report an attempt when native configuration rejects before sending', async () => {
  const model = instrumentProvider(new GeminiAdapter('', 'test-model', 'test-embedding', 2));
  const attempts: ProviderAttempt[] = [];
  await expect(
    withProviderAttemptObserver(
      (attempt) => attempts.push(attempt),
      () => model.completeStructured('system', 'data'),
    ),
  ).rejects.toMatchObject({ code: 'ProviderNotConfigured' });
  expect(attempts).toEqual([]);
});
