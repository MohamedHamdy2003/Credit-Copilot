import { GeminiAdapter } from '../packages/infrastructure/src/llm/gemini.js';
it('retains reported token counts on invalid generated JSON without exposing raw provider text', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'not JSON: private provider data' }] } }],
        usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 3 },
      }),
    );
  try {
    await expect(
      new GeminiAdapter('test-only-key', 'test-model', 'test-embedding', 64).completeStructured(
        'system',
        'data',
      ),
    ).rejects.toMatchObject({
      code: 'InvalidLLMOutput',
      details: { model: 'test-model', inputTokens: 17, outputTokens: 3 },
    });
  } finally {
    globalThis.fetch = original;
  }
});
