import { configSchema } from '../packages/contracts/src/config.js';
import {
  createProvider,
  RuntimeGenerationProvider,
} from '../packages/infrastructure/src/llm/provider.js';
import {
  instrumentProvider,
  withProviderAttemptObserver,
  type ProviderAttempt,
} from '../packages/infrastructure/src/llm/attempt-meter.js';

type RequestOptions = Parameters<typeof fetch>[1];
const requestFetch = globalThis.fetch;
const base = {
  DATABASE_URL: 'postgresql://localhost/copilot',
  GEMINI_API_KEY: 'test-provider-key',
  GENERATION_MODEL: 'gemini-test',
  EMBEDDING_MODEL: 'embedding-test',
  EMBEDDING_DIMENSIONS: '2',
  OLLAMA_MODEL: 'local-test',
  OLLAMA_FALLBACK_ENABLED: 'true',
};
const create = (config: Record<string, string> = {}) =>
  createProvider(configSchema.parse({ ...base, ...config }));
const ollamaReply = () =>
  Response.json({
    message: { content: '{"citations":[]}' },
    done: true,
    prompt_eval_count: 40,
    eval_count: 6,
  });

afterEach(() => {
  globalThis.fetch = requestFetch;
});

it('retries a Gemini quota error and sends the same prompt and schema to loopback only', async () => {
  const calls: { url: URL; init: RequestOptions }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return url.hostname === '127.0.0.1' ? ollamaReply() : new Response(null, { status: 429 });
  };
  const schema = { type: 'object', properties: { citations: { type: 'array' } } };
  const attempts: ProviderAttempt[] = [];
  await expect(
    withProviderAttemptObserver(
      (attempt) => attempts.push(attempt),
      () =>
        instrumentProvider(create()).completeStructured(
          'grounded system',
          'sanitized data',
          schema,
        ),
    ),
  ).resolves.toEqual({
    model: 'ollama:local-test',
    fallbackFrom: 'gemini-test',
    usage: { inputTokens: 40, outputTokens: 6 },
    value: { citations: [] },
  });
  expect(calls.map(({ url }) => url.hostname)).toEqual([
    'generativelanguage.googleapis.com',
    'generativelanguage.googleapis.com',
    'generativelanguage.googleapis.com',
    '127.0.0.1',
  ]);
  expect(attempts).toEqual([
    ...[false, true, true].map((retry) => ({
      provider: 'gemini',
      model: 'gemini-test',
      kind: 'generation',
      retry,
      outcome: 'failed',
      inputTokens: null,
      outputTokens: null,
    })),
    {
      provider: 'ollama',
      model: 'ollama:local-test',
      kind: 'generation',
      fallbackFrom: 'gemini-test',
      retry: false,
      outcome: 'succeeded',
      inputTokens: 40,
      outputTokens: 6,
    },
  ]);
  const local = calls.at(-1)!;
  expect(local.url.pathname).toBe('/api/chat');
  expect(local.init?.redirect).toBe('error');
  expect(new Headers(local.init?.headers).has('x-goog-api-key')).toBe(false);
  expect(JSON.parse(String(local.init?.body))).toMatchObject({
    model: 'local-test',
    format: schema,
    stream: false,
    messages: [
      { role: 'system', content: 'grounded system' },
      { role: 'user', content: 'sanitized data' },
    ],
  });
});

it('falls back on generation timeouts and keeps both query and document embeddings on Gemini', async () => {
  const targets: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    targets.push(url);
    if (url.hostname === '127.0.0.1') return ollamaReply();
    throw new DOMException('simulated transport timeout', 'TimeoutError');
  };
  const provider = create();
  expect(provider.model).toBe('embedding-test');
  expect(provider.dimensions).toBe(2);
  await expect(provider.completeStructured('system', 'data')).resolves.toMatchObject({
    model: 'ollama:local-test',
    fallbackFrom: 'gemini-test',
  });
  expect(targets.filter((url) => url.hostname === '127.0.0.1')).toHaveLength(1);
  targets.length = 0;
  await expect(provider.embed('policy text', 'document')).rejects.toMatchObject({
    code: 'ProviderUnavailable',
  });
  await expect(provider.embed('policy query', 'query')).rejects.toMatchObject({
    code: 'ProviderUnavailable',
  });
  expect(targets).toHaveLength(6);
  expect(targets.every((url) => url.pathname.endsWith('/embedding-test:embedContent'))).toBe(true);
});

it.each([401, 403, 404])('does not fall back on Gemini HTTP %d', async (status) => {
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    urls.push(new URL(String(input)));
    return new Response(null, { status });
  };
  await expect(create().completeStructured('system', 'data')).rejects.toMatchObject({
    code: 'ProviderUnavailable',
    details: { model: 'gemini-test', retryable: false },
  });
  expect(urls.map((url) => url.hostname)).toEqual(['generativelanguage.googleapis.com']);
});

it('keeps invalid Gemini output a validation error even with Ollama enabled', async () => {
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    urls.push(new URL(String(input)));
    return Response.json({ candidates: [{ content: { parts: [{ text: 'invalid' }] } }] });
  };
  await expect(create().completeStructured('system', 'data')).rejects.toMatchObject({
    code: 'InvalidLLMOutput',
    details: { model: 'gemini-test' },
  });
  expect(urls.map((url) => url.hostname)).toEqual(['generativelanguage.googleapis.com']);
});

it('records sanitized local validation failure and usage after a cloud outage', async () => {
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).hostname !== '127.0.0.1')
      throw new Error('simulated transport outage');
    return Response.json({
      done: true,
      message: { content: 'private response is not JSON' },
      prompt_eval_count: 17,
      eval_count: 4,
    });
  };
  const attempts: ProviderAttempt[] = [];
  await expect(
    withProviderAttemptObserver(
      (attempt) => attempts.push(attempt),
      () => create().completeStructured('system', 'data'),
    ),
  ).rejects.toMatchObject({
    code: 'InvalidLLMOutput',
    message: 'Local Ollama returned invalid generated JSON',
    details: {
      model: 'ollama:local-test',
      fallbackFrom: 'gemini-test',
      inputTokens: 17,
      outputTokens: 4,
    },
  });
  expect(attempts.at(-1)).toEqual({
    provider: 'ollama',
    model: 'ollama:local-test',
    kind: 'generation',
    retry: false,
    outcome: 'failed',
    fallbackFrom: 'gemini-test',
    inputTokens: 17,
    outputTokens: 4,
  });
});

it('reports both provider models when the optional local server is unavailable', async () => {
  globalThis.fetch = async () => {
    throw new Error('simulated transport outage');
  };
  await expect(create().completeStructured('system', 'data')).rejects.toMatchObject({
    code: 'ProviderUnavailable',
    details: { model: 'ollama:local-test', fallbackFrom: 'gemini-test' },
  });
  await expect(
    create({ OLLAMA_FALLBACK_ENABLED: 'false' }).completeStructured('system', 'data'),
  ).rejects.toMatchObject({
    code: 'ProviderUnavailable',
    details: { model: 'gemini-test' },
  });
});

it('switches generation dynamically between gemini, ollama, and auto while keeping embeddings on primary', async () => {
  let ollamaReachable = true;
  const localCalls: string[] = [];
  const primaryCalls: string[] = [];
  const runtime = new RuntimeGenerationProvider(
    {
      model: 'embedding-test',
      dimensions: 2,
      embed: async () => [1, 0],
      completeStructured: async () => {
        primaryCalls.push('gemini');
        return {
          model: 'gemini-test',
          usage: { inputTokens: 10, outputTokens: 5 },
          value: { from: 'gemini' },
        };
      },
    },
    {
      geminiConfigured: true,
      geminiModel: 'gemini-test',
      ollama: {
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
        OLLAMA_MODEL: 'qwen3:4b-instruct-2507-q4_K_M',
        OLLAMA_TIMEOUT_MS: 120000,
      },
      initialMode: 'gemini',
      localFactory: (settings) => ({
        completeStructured: async () => {
          localCalls.push(settings.OLLAMA_MODEL);
          return {
            model: `ollama:${settings.OLLAMA_MODEL}`,
            usage: { inputTokens: 20, outputTokens: 4 },
            value: { from: 'ollama' },
          };
        },
      }),
      probeOllama: async () =>
        ollamaReachable
          ? { reachable: true, models: ['qwen3:4b-instruct-2507-q4_K_M', 'llama3.2:3b'] }
          : { reachable: false, models: [] },
    },
  );

  await expect(runtime.completeStructured('s', 'd')).resolves.toMatchObject({
    model: 'gemini-test',
  });
  await expect(
    runtime.configure({ mode: 'ollama', ollamaModel: 'llama3.2:3b' }),
  ).resolves.toMatchObject({
    mode: 'ollama',
    activeProvider: 'ollama',
    activeModel: 'ollama:llama3.2:3b',
  });
  await expect(runtime.completeStructured('s', 'd')).resolves.toMatchObject({
    model: 'ollama:llama3.2:3b',
  });
  expect(primaryCalls).toHaveLength(1);
  expect(localCalls).toEqual(['llama3.2:3b']);
  await expect(runtime.embed('policy', 'query')).resolves.toEqual([1, 0]);

  await expect(
    runtime.configure({ mode: 'ollama', ollamaModel: 'missing-model' }),
  ).rejects.toMatchObject({ code: 'OllamaModelNotFound', status: 422 });

  ollamaReachable = false;
  await expect(runtime.configure({ mode: 'ollama' })).rejects.toMatchObject({
    code: 'OllamaUnavailable',
    status: 503,
  });
});

it('auto-selects the first pulled Ollama model when the configured default tag is not installed locally', async () => {
  const localCalls: string[] = [];
  const runtime = new RuntimeGenerationProvider(
    {
      model: 'embedding-test',
      dimensions: 2,
      embed: async () => [1, 0],
      completeStructured: async () => ({
        model: 'gemini-test',
        usage: { inputTokens: 5, outputTokens: 2 },
        value: { ok: true },
      }),
    },
    {
      geminiConfigured: true,
      geminiModel: 'gemini-test',
      ollama: {
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
        OLLAMA_MODEL: 'qwen3:1.7b',
        OLLAMA_TIMEOUT_MS: 120000,
      },
      initialMode: 'gemini',
      localFactory: (settings) => ({
        completeStructured: async () => {
          localCalls.push(settings.OLLAMA_MODEL);
          return {
            model: `ollama:${settings.OLLAMA_MODEL}`,
            usage: { inputTokens: 12, outputTokens: 3 },
            value: { ok: true },
          };
        },
      }),
      probeOllama: async () => ({
        reachable: true,
        models: ['qwen3:4b-instruct-2507-q4_K_M'],
      }),
    },
  );

  await expect(runtime.status(true)).resolves.toMatchObject({
    mode: 'gemini',
    ollamaModel: 'qwen3:4b-instruct-2507-q4_K_M',
    ollamaModels: ['qwen3:4b-instruct-2507-q4_K_M'],
  });
  await expect(runtime.configure({ mode: 'ollama' })).resolves.toMatchObject({
    mode: 'ollama',
    activeProvider: 'ollama',
    activeModel: 'ollama:qwen3:4b-instruct-2507-q4_K_M',
    ollamaModel: 'qwen3:4b-instruct-2507-q4_K_M',
  });
  await expect(runtime.completeStructured('s', 'd')).resolves.toMatchObject({
    model: 'ollama:qwen3:4b-instruct-2507-q4_K_M',
  });
  expect(localCalls).toEqual(['qwen3:4b-instruct-2507-q4_K_M']);

  // An explicit request for an unpulled tag still fails with 422.
  await expect(
    runtime.configure({ mode: 'ollama', ollamaModel: 'qwen3:1.7b' }),
  ).rejects.toMatchObject({ code: 'OllamaModelNotFound', status: 422 });
});
