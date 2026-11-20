import { z } from 'zod';
import type { Chunk } from '../../contracts/src/documents.js';
import type { GenerationPort, Usage } from './ports.js';
import { validDate } from '../../domain/src/calculations.js';
import { invariant } from '../../domain/src/errors.js';

export interface PolicySearch {
  search(
    question: string,
    date: string,
    product?: string,
    limit?: number,
  ): Promise<{ chunk: Chunk; similarity: number }[]>;
  related?(
    question: string,
    date: string,
    product: string,
    hits: { chunk: Chunk; similarity: number }[],
  ): Promise<{ chunks: Chunk[]; reason: string }>;
}
const quotedCitation = z.object({ chunkId: z.string(), quote: z.string().min(1) }).strict();
const selectionSchema = z
  .object({
    citations: z
      .array(
        z.union([
          quotedCitation,
          z
            .object({ chunkId: z.string(), text: z.string().min(1) })
            .strict()
            .transform(({ chunkId, text }) => ({ chunkId, quote: text })),
        ]),
      )
      .max(5),
  })
  .strict();
const generationSchema = z.toJSONSchema(
  z.object({ citations: z.array(quotedCitation).max(5) }).strict(),
);
type FallbackAttribution = { generation?: { model: string; fallbackFrom: string; usage: Usage } };
export const REFUSAL = 'The documents do not contain enough information to answer this question.';
export const isApprovalBypass = (question: string) =>
  /\bapprove\b[\s\S]{0,160}\bwithout\b[\s\S]{0,80}\b(?:human|reviewer|approval)\b/i.test(question);
function citation(chunk: Chunk, quote: string) {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    quote,
    sourceFile: chunk.sourceFile,
    section: chunk.section,
    edition: chunk.edition,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    row: chunk.row,
    effectiveFrom: chunk.effectiveFrom,
    effectiveTo: chunk.effectiveTo,
  };
}
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
  const refuse = (attribution: FallbackAttribution = {}) => ({
    ...attribution,
    answer: REFUSAL,
    citations: [],
    refused: true,
    asOfDate: input.asOfDate,
  });
  if (!hits.length) return refuse();
  // Source-reference context is separate from the vector top5. It never creates
  // an answer when the primary search is below threshold or the model refuses.
  const related = await dependencies.search.related?.(
    question,
    input.asOfDate,
    input.product ?? 'PL-100',
    hits,
  );
  const candidates = [
    ...new Map(
      [...hits.map((h) => h.chunk), ...(related?.chunks ?? [])].map((c) => [c.id, c]),
    ).values(),
  ];
  if (isApprovalBypass(question)) {
    const authority = [
      ...new Map(
        candidates
          .filter(
            (c) =>
              c.documentId.startsWith('PM-') &&
              ['PM-1', 'PM-2', 'PM-3'].includes(c.section) &&
              c.effectiveFrom <= input.asOfDate &&
              (!c.effectiveTo || input.asOfDate < c.effectiveTo),
          )
          .map((c) => [c.section, c]),
      ).values(),
    ];
    if (
      authority.some((c) => c.section === 'PM-1') &&
      authority.some((c) => c.section === 'PM-2')
    ) {
      const citations = authority.map((c) => citation(c, c.text));
      return {
        answer: `Requested approval bypass rejected. The applicable human-approval procedure is quoted below.\n\n${citations.map((c) => c.quote).join('\n\n')}`,
        citations,
        refused: false,
        asOfDate: input.asOfDate,
        requestedActionRejected: true,
        evidenceContext: {
          strategy: 'read-only-approval-boundary',
          chunkIds: authority.map((c) => c.id),
          reason: 'No approval action is available to policy Q&A',
        },
      };
    }
  }
  const response = await dependencies.provider.completeStructured(
    dependencies.prompt,
    JSON.stringify({
      question,
      asOfDate: input.asOfDate,
      evidence: candidates.map((chunk) => ({
        chunkId: chunk.id,
        text: chunk.text,
        documentId: chunk.documentId,
        edition: chunk.edition,
        section: chunk.section,
        page: chunk.pageStart,
        sourceFile: chunk.sourceFile,
        effectiveFrom: chunk.effectiveFrom,
        effectiveTo: chunk.effectiveTo,
      })),
    }),
    generationSchema,
  );
  const attribution: FallbackAttribution = response.fallbackFrom
    ? {
        generation: {
          model: response.model,
          fallbackFrom: response.fallbackFrom,
          usage: response.usage,
        },
      }
    : {};
  const parsed = selectionSchema.safeParse(response.value);
  if (!parsed.success || !parsed.data.citations.length) return refuse(attribution);
  const citations = [];
  const requiredKeys = new Set(related?.chunks.map((c) => `${c.documentId}:${c.section}`) ?? []);
  const selectedCitations = [
    ...(related?.chunks.map((c) => ({ chunkId: c.id, quote: c.text })) ?? []),
    ...parsed.data.citations.filter((c) => {
      const source = candidates.find((s) => s.id === c.chunkId);
      return !source || !requiredKeys.has(`${source.documentId}:${source.section}`);
    }),
  ].slice(0, 5);
  // Validate every model-selected span even if a canonical operative clause
  // replaces a comparison-table selection in the final evidence bundle.
  for (const selected of parsed.data.citations) {
    const source = candidates.find((c) => c.id === selected.chunkId);
    if (
      !source ||
      !selected.quote.trim() ||
      !source.text.replace(/\s+/g, ' ').includes(selected.quote.trim().replace(/\s+/g, ' '))
    )
      return refuse(attribution);
  }
  for (const selected of selectedCitations) {
    const chunk = candidates.find((item) => item.id === selected.chunkId);
    // Models may fold PDF line breaks into spaces. Match whitespace only, then
    // emit the original source span; never relax word/number/punctuation checks.
    const pattern = selected.quote
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    const sourceQuote = chunk?.text.match(new RegExp(pattern))?.[0];
    if (!chunk || !sourceQuote) return refuse(attribution);
    citations.push(citation(chunk, sourceQuote));
  }
  // Evidence-first baseline: only verified verbatim spans become answer text.
  return {
    ...attribution,
    answer: citations.map((citation) => citation.quote).join('\n\n'),
    citations,
    refused: false,
    asOfDate: input.asOfDate,
    evidenceContext: {
      strategy: 'operative-source-references',
      chunkIds: related?.chunks.map((c) => c.id) ?? [],
      reason: related?.reason ?? null,
    },
  };
}
