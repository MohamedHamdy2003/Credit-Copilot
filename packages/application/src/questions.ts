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
    citations: z
      .array(
        z.union([
          z.object({ chunkId: z.string(), quote: z.string().min(1) }).strict(),
          z
            .object({ chunkId: z.string(), text: z.string().min(1) })
            .strict()
            .transform(({ chunkId, text }) => ({ chunkId, quote: text })),
        ]),
      )
      .max(5),
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
  const question = input.question
    .replace(/\b\d{14}\b/g, '[MASKED_ID]')
    .replace(/\b01\d(?:[- ]?\d){8}\b/g, '[MASKED_PHONE]');
  const hits = (
    await dependencies.search.search(question, input.asOfDate, input.product ?? 'PL-100', 5)
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
      question,
      asOfDate: input.asOfDate,
      evidence: hits.map((hit) => ({ chunkId: hit.chunk.id, text: hit.chunk.text })),
    }),
  );
  const parsed = selectionSchema.safeParse(response.value);
  if (!parsed.success || !parsed.data.citations.length) return refuse();
  const citations = [];
  for (const selected of parsed.data.citations) {
    const hit = hits.find((item) => item.chunk.id === selected.chunkId);
    // Models may fold PDF line breaks into spaces. Match whitespace only, then
    // emit the original source span; never relax word/number/punctuation checks.
    const pattern = selected.quote
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    const sourceQuote = hit?.chunk.text.match(new RegExp(pattern))?.[0];
    if (!hit || !sourceQuote) return refuse();
    citations.push({
      chunkId: hit.chunk.id,
      quote: sourceQuote,
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
