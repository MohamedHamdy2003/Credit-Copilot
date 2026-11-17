import { z } from 'zod';
import type { Chunk } from '../../contracts/src/documents.js';
import type { GenerationPort } from './ports.js';
import { validDate } from '../../domain/src/calculations.js';
import { invariant } from '../../domain/src/errors.js';

export interface PolicySearch {
  search(
    question: string,
    date: string,
    product?: string,
    limit?: number,
  ): Promise<{ chunk: Chunk; similarity: number }[]>;
}
const selectionSchema = z
  .object({
    citations: z.array(z.object({ chunkId: z.string(), quote: z.string().min(1) }).strict()).max(5),
  })
  .strict();
export const REFUSAL = 'The documents do not contain enough information to answer this question.';
export async function answerPolicyQuestion(
  input: { question: string; asOfDate: string; product?: string },
  dependencies: {
    search: PolicySearch;
    provider: GenerationPort;
    prompt: string;
    minimumSimilarity: number;
  },
) {
  invariant(
    input.question.trim().length > 0 && input.question.length <= 2000,
    'InvalidQuestion',
    'Question must contain 1–2000 characters',
  );
  validDate(input.asOfDate);
  const hits = (
    await dependencies.search.search(input.question, input.asOfDate, input.product ?? 'PL-100', 5)
  ).filter(
    (hit) => Number.isFinite(hit.similarity) && hit.similarity >= dependencies.minimumSimilarity,
  );
  const refuse = () => ({
    answer: REFUSAL,
    citations: [],
    refused: true,
    asOfDate: input.asOfDate,
  });
  if (!hits.length) return refuse();
  const response = await dependencies.provider.completeStructured(
    dependencies.prompt,
    JSON.stringify({
      question: input.question,
      asOfDate: input.asOfDate,
      evidence: hits.map((hit) => ({ chunkId: hit.chunk.id, text: hit.chunk.text })),
    }),
  );
  const parsed = selectionSchema.safeParse(response.value);
  if (!parsed.success || !parsed.data.citations.length) return refuse();
  const citations = [];
  for (const selected of parsed.data.citations) {
    const hit = hits.find((item) => item.chunk.id === selected.chunkId);
    if (!hit || !hit.chunk.text.includes(selected.quote)) return refuse();
    citations.push({
      chunkId: hit.chunk.id,
      quote: selected.quote,
      sourceFile: hit.chunk.sourceFile,
      section: hit.chunk.section,
      edition: hit.chunk.edition,
      pageStart: hit.chunk.pageStart,
      pageEnd: hit.chunk.pageEnd,
      row: hit.chunk.row,
      effectiveFrom: hit.chunk.effectiveFrom,
      effectiveTo: hit.chunk.effectiveTo,
    });
  }
  // Evidence-first baseline: only verified verbatim spans become answer text.
  return {
    answer: citations.map((citation) => citation.quote).join('\n\n'),
    citations,
    refused: false,
    asOfDate: input.asOfDate,
  };
}
