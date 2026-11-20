import { configSchema } from '../packages/contracts/src/config.js';
import { createProvider } from '../packages/infrastructure/src/llm/provider.js';

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
  await expect(
    create().completeStructured('grounded system', 'sanitized data', schema),
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
  await expect(create().completeStructured('system', 'data')).rejects.toMatchObject({
    code: 'InvalidLLMOutput',
    message: 'Local Ollama returned invalid generated JSON',
    details: {
      model: 'ollama:local-test',
      fallbackFrom: 'gemini-test',
      inputTokens: 17,
      outputTokens: 4,
    },
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
