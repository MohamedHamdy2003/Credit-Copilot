import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { runtime } from './runtime.js';
import { RetrievalService } from '../packages/infrastructure/src/knowledge/retrieval.js';
import { answerPolicyQuestion } from '../packages/application/src/questions.js';

const cases = [
  {
    id: 'live-dbr-2024',
    question: 'What is the maximum debt burden ratio?',
    date: '2024-12-01',
    gold: ['CP-2024:CP-4.1'],
    refuse: false,
  },
  {
    id: 'live-dbr-2025',
    question: 'What is the maximum debt burden ratio?',
    date: '2025-04-03',
    gold: ['CP-2025:CP-4.1'],
    refuse: false,
  },
  {
    id: 'live-tenor',
    question: 'Can PL-100 be offered for 72 months?',
    date: '2025-04-03',
    gold: ['CP-2025:CP-14', 'PS-PL-100:PS-3'],
    refuse: false,
  },
  {
    id: 'live-crypto',
    question: 'What is the policy for crypto-backed loans?',
    date: '2025-04-03',
    gold: [],
    refuse: true,
  },
  {
    id: 'live-sme',
    question: 'What fees apply to an SME revolving credit line?',
    date: '2025-04-03',
    gold: [],
    refuse: true,
  },
];
const { db, provider, config } = await runtime();
try {
  const search = new RetrievalService(db, provider);
  const prompt = await readFile('prompts/questions.txt', 'utf8');
  const results = [];
  for (const test of cases) {
    try {
      const hits = await search.search(test.question, test.date);
      // Replay retrieved candidates to avoid a second embedding request for the same query.
      const answer = await answerPolicyQuestion(
        { question: test.question, asOfDate: test.date },
        {
          search: { search: async () => hits },
          provider,
          prompt,
          minimumSimilarity: config.RETRIEVAL_MIN_SIMILARITY,
        },
      );
      const hit = test.gold.some((gold) =>
        hits.some((h) => `${h.chunk.documentId}:${h.chunk.section}` === gold),
      );
      results.push({
        id: test.id,
        expectedRefusal: test.refuse,
        hitAt5: test.refuse ? null : hit,
        refusalCorrect: answer.refused === test.refuse,
        candidates: hits.map((h) => ({
          id: h.chunk.id,
          source: h.chunk.documentId,
          section: h.chunk.section,
          similarity: h.similarity,
        })),
        answer,
      });
      console.log(test.id, 'refused:', answer.refused, 'hit@5:', test.refuse ? 'N/A' : hit);
    } catch (error) {
      results.push({
        id: test.id,
        error: error instanceof Error ? error.message : 'Unknown failure',
      });
      console.error(test.id, 'failed');
    }
  }
  const report = {
    scope: 'Five-case live vector smoke baseline, NOT the full fifteen-case FR-6 evaluation',
    at: new Date().toISOString(),
    model: config.GENERATION_MODEL,
    embedding: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
    minimumSimilarity: config.RETRIEVAL_MIN_SIMILARITY,
    k: 5,
    results,
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/live-vector-smoke.json', JSON.stringify(report, null, 2));
  if (results.some((r) => 'error' in r || ('refusalCorrect' in r && !r.refusalCorrect)))
    process.exitCode = 1;
} finally {
  await db.destroy();
}
