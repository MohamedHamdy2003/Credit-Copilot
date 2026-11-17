import { answerPolicyQuestion, REFUSAL } from '../packages/application/src/questions.js';
import { FakeGeneration } from './helpers/fake-provider.js';
import type { Chunk } from '../packages/contracts/src/documents.js';
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
