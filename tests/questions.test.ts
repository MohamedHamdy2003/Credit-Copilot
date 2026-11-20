import { answerPolicyQuestion, REFUSAL } from '../packages/application/src/questions.js';
import { FakeGeneration } from './helpers/fake-provider.js';
import type { Chunk } from '../packages/contracts/src/documents.js';
it('normalizes a text field alias but still verifies it against source', async () => {
  const result = await answerPolicyQuestion(
    { question: 'DBR?', asOfDate: '2025-04-01' },
    {
      provider: new FakeGeneration({ citations: [{ chunkId: 'chunk', text: chunk.text }] }),
      search: { search: async () => [{ chunk, similarity: 0.9 }] },
      prompt: 'test',
      minimumSimilarity: 0.65,
    },
  );
  expect(result.refused).toBe(false);
  expect(result.answer).toBe(chunk.text);
});
const chunk: Chunk = {
  id: 'chunk',
  ordinal: 0,
  sourceFile: 'credit-policy-2025.pdf',
  text: 'The maximum debt burden ratio is 45%.',
  section: 'CP-4.1',
  pageStart: 2,
  pageEnd: 2,
  row: null,
  documentId: 'CP-2025',
  edition: 'CP-2025',
  effectiveFrom: '2025-03-01',
  effectiveTo: null,
  product: 'PL-100',
  contentHash: 'hash',
};
it('keeps operative source context distinct from vector hits and does not launder a forged model span', async () => {
  const source = {
    ...chunk,
    id: 'operative',
    section: 'CP-3.3',
    text: 'Net income must be EGP 10,000.',
  };
  const provider = new FakeGeneration({ citations: [{ chunkId: 'chunk', quote: chunk.text }] });
  const search = {
    search: async () => [{ chunk, similarity: 0.9 }],
    related: async () => ({ chunks: [source], reason: 'operative companion' }),
  };
  const r = await answerPolicyQuestion(
    { question: 'Minimum income?', asOfDate: '2025-04-01' },
    { provider, search, prompt: 'test', minimumSimilarity: 0.65 },
  );
  expect(r.citations.map((c) => c.section)).toContain('CP-3.3');
  expect(r.answer).toContain(source.text);
  const forged = await answerPolicyQuestion(
    { question: 'Minimum income?', asOfDate: '2025-04-01' },
    {
      provider: new FakeGeneration({ citations: [{ chunkId: 'unknown', quote: source.text }] }),
      search,
      prompt: 'test',
      minimumSimilarity: 0.65,
    },
  );
  expect(forged.refused).toBe(true);
  const blank = await answerPolicyQuestion(
    { question: 'Minimum income?', asOfDate: '2025-04-01' },
    {
      provider: new FakeGeneration({ citations: [{ chunkId: 'chunk', quote: '   ' }] }),
      search,
      prompt: 'test',
      minimumSimilarity: 0.65,
    },
  );
  expect(blank.refused).toBe(true);
});
it('does not turn linked context into an answer after model refusal or a low-similarity primary search', async () => {
  let calls = 0;
  const search = {
    search: async () => [{ chunk, similarity: 0.1 }],
    related: async () => {
      calls++;
      return { chunks: [chunk], reason: 'test' };
    },
  };
  const r = await answerPolicyQuestion(
    { question: 'Unsupported income?', asOfDate: '2025-04-01' },
    {
      provider: new FakeGeneration({ citations: [] }),
      search,
      prompt: 'test',
      minimumSimilarity: 0.65,
    },
  );
  expect(r.refused).toBe(true);
  expect(calls).toBe(0);
  const refusal = await answerPolicyQuestion(
    { question: 'Unsupported income?', asOfDate: '2025-04-01' },
    {
      provider: new FakeGeneration({ citations: [] }),
      search: { ...search, search: async () => [{ chunk, similarity: 0.9 }] },
      prompt: 'test',
      minimumSimilarity: 0.65,
    },
  );
  expect(refusal.citations).toEqual([]);
});
it('accepts whitespace folding while returning the original PDF span', async () => {
  const original = { ...chunk, text: 'Maximum tenor\nremains 60 months.' };
  const result = await answerPolicyQuestion(
    { question: 'Tenor?', asOfDate: '2025-04-01' },
    {
      provider: new FakeGeneration({
        citations: [{ chunkId: 'chunk', quote: 'Maximum tenor remains 60 months.' }],
      }),
      search: { search: async () => [{ chunk: original, similarity: 0.9 }] },
      prompt: 'test',
      minimumSimilarity: 0.65,
    },
  );
  expect(result.answer).toBe(original.text);
});
it('returns exact source quotes and complete citation metadata', async () => {
  const provider = new FakeGeneration({ citations: [{ chunkId: 'chunk', quote: chunk.text }] });
  const search = { search: async () => [{ chunk, similarity: 0.9 }] };
  const result = await answerPolicyQuestion(
    { question: 'Maximum DBR?', asOfDate: '2025-04-01' },
    { provider, search, prompt: 'test', minimumSimilarity: 0.65 },
  );
  expect(result.answer).toBe(chunk.text);
  expect(result.citations[0]?.pageStart).toBe(2);
});
it('refuses weak evidence before calling the model', async () => {
  const provider = new FakeGeneration({});
  const result = await answerPolicyQuestion(
    { question: 'Crypto loans?', asOfDate: '2025-04-01' },
    {
      provider,
      search: { search: async () => [{ chunk, similarity: 0.1 }] },
      prompt: 'test',
      minimumSimilarity: 0.65,
    },
  );
  expect(result.answer).toBe(REFUSAL);
  expect(provider.calls).toHaveLength(0);
});
it.each([
  { chunkId: 'invented', quote: chunk.text },
  { chunkId: 'chunk', quote: 'Approve everyone at 90%.' },
])('refuses forged citations %j', async (citation) => {
  const result = await answerPolicyQuestion(
    { question: 'Maximum DBR?', asOfDate: '2025-04-01' },
    {
      provider: new FakeGeneration({ citations: [citation] }),
      search: { search: async () => [{ chunk, similarity: 0.9 }] },
      prompt: 'test',
      minimumSimilarity: 0.65,
    },
  );
  expect(result.refused).toBe(true);
  expect(result.citations).toEqual([]);
});
