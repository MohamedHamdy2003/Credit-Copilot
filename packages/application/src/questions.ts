import { z } from 'zod';
import { QUESTION_REFUSAL } from '../../contracts/src/streams.js';
import type { Chunk } from '../../contracts/src/documents.js';
import type { GenerationPort, Usage } from './ports.js';
import { validDate } from '../../domain/src/calculations.js';
import { invariant } from '../../domain/src/errors.js';

export type PersonalLoanConflict = 'minimum-income' | 'maximum-tenor';
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
  ): Promise<{ chunks: Chunk[]; reason: string; conflict?: PersonalLoanConflict }>;
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
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

function generationSchema(candidates: Chunk[]) {
  // The local decoder selects source text it can reproduce exactly, including
  // the matching chunk ID. Cloud generation still uses the same input prompt.
  const choices = candidates.map((chunk) => {
    const spans = [
      chunk.text,
      ...chunk.text.split('\n'),
      ...Array.from(sentences.segment(chunk.text), ({ segment }) => segment),
    ]
      .map((span) => span.trim())
      .filter(Boolean);
    return quotedCitation.extend({
      chunkId: z.literal(chunk.id),
      quote: z.enum([...new Set(spans)]),
    });
  });
  return z.toJSONSchema(z.object({ citations: z.array(z.union(choices)).max(5) }).strict());
}
type FallbackAttribution = { generation?: { model: string; fallbackFrom: string; usage: Usage } };
export const REFUSAL = QUESTION_REFUSAL;
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

function explainPersonalLoanConflict(
  conflict: PersonalLoanConflict,
  citations: ReturnType<typeof citation>[],
) {
  if (conflict === 'minimum-income') {
    const income = citations.find(
      (c) => c.section === 'CP-3.3' && /^CP-20\d{2}$/.test(c.documentId),
    );
    const scope = citations.find(
      (c) => c.documentId === income?.documentId && c.section === 'CP-1',
    );
    const product = citations.find((c) => c.documentId === 'PS-PL-100' && c.section === 'PS-2');
    const policyAmounts = [...(income?.quote.matchAll(/\bEGP\s+([\d,]+)\b/g) ?? [])];
    const policyMinimum = policyAmounts[0]?.[1];
    const productMinimum = product?.quote.match(
      /Minimum net monthly income\s*\|\s*EGP\s+([\d,]+)/i,
    )?.[1];
    if (
      !income ||
      !policyMinimum ||
      !productMinimum ||
      policyAmounts.length !== 1 ||
      !/this policy governs[\s\S]+edition in force on the date/i.test(scope?.quote ?? '')
    )
      return undefined;
    if (policyMinimum === productMinimum) {
      return `The minimum net monthly income is EGP ${policyMinimum}. ${income.edition} CP-3.3 and the PL-100 product sheet (PS-2) set the same threshold.`;
    }
    if (Number(policyMinimum.replaceAll(',', '')) > Number(productMinimum.replaceAll(',', ''))) {
      return `The applicable minimum net monthly income is EGP ${policyMinimum} under ${income.edition} CP-3.3. CP-1 makes the credit policy in force on the application date govern eligibility, so the EGP ${productMinimum} figure in PS-2 does not satisfy the stricter policy threshold.`;
    }
    return undefined;
  }

  const policy = citations.find((c) => c.documentId === 'CP-2025' && c.section === 'CP-14');
  const product = citations.find((c) => c.documentId === 'PS-PL-100' && c.section === 'PS-3');
  const circular = citations.find((c) => c.documentId === 'C-2025-02' && c.section === 'C-1');
  const policyCap = policy?.quote.match(/\bremains\s+(\d{1,3})\s+months/i)?.[1];
  const productCap = product?.quote.match(
    /Maximum tenor\s*\|\s*(\d{1,3}) months[^\n]*whichever is lower/i,
  )?.[1];
  const circularCap = circular?.quote.match(/\braised to\s*\**(\d{1,3}) months/i)?.[1];
  if (
    !policyCap ||
    !productCap ||
    policyCap !== productCap ||
    !circularCap ||
    Number(productCap) >= Number(circularCap) ||
    !/only after updating their\s+product sheets and system controls/i.test(circular?.quote ?? '')
  )
    return undefined;
  return `PL-100 is capped at ${productCap} months under CP-14 and PS-3. Circular 2025/02 C-1 permits up to ${circularCap} months after product sheets and system controls are updated. The current product sheet keeps the lower limit.`;
}
export function maskPolicyQuestion(question: string) {
  return question
    .replace(
      /(?:(?<!\d)(?:\+?20|0020)[- ]?0?1[0125]|\b01[0125])(?:[- ]?\d){8}\b/g,
      '[MASKED_PHONE]',
    )
    .replace(/\b\d{14}\b/g, '[MASKED_ID]');
}

const FOLLOW_UP_PATTERN =
  /^(?:what|how|and|same|does|do|is|are|can|will)\s+(?:about|for|under|in|if|it|its|that|this|those|they|them)\b|\b(?:it|its|that|this|those|them|they|the same|above|previous)\b/i;

export function isFollowUpQuestion(question: string): boolean {
  return FOLLOW_UP_PATTERN.test(question.trim());
}

export async function answerPolicyQuestion(
  input: { question: string; asOfDate: string; product?: string; context?: string[] },
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
  const question = maskPolicyQuestion(input.question);
  const sanitizedContext = (input.context ?? [])
    .slice(-3)
    .map((previous) => maskPolicyQuestion(previous.trim()))
    .filter(Boolean);
  // Only carry prior turn context when the current question is an explicit follow-up,
  // preventing unrelated new questions (especially out-of-corpus ones) from inheriting prior hits.
  const priorQuestions =
    sanitizedContext.length > 0 && isFollowUpQuestion(question) ? sanitizedContext : [];
  const retrievalQuestion = priorQuestions.length
    ? `${priorQuestions.at(-1)!}\n${question}`
    : question;
  const hits = (
    await dependencies.search.search(
      retrievalQuestion,
      input.asOfDate,
      input.product ?? 'PL-100',
      5,
    )
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
    retrievalQuestion,
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
      const resolution =
        'Requested approval bypass rejected. The applicable human-approval procedure is quoted below.';
      return {
        answer: `${resolution}\n\n${citations.map((c) => c.quote).join('\n\n')}`,
        resolution,
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
      priorQuestions,
      product: input.product ?? 'PL-100',
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
    generationSchema(candidates),
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
  const resolution = related?.conflict && explainPersonalLoanConflict(related.conflict, citations);
  if (related?.conflict && !resolution) return refuse(attribution);
  // Only source-verified excerpts and code-derived resolutions become answer text.
  return {
    ...attribution,
    answer: [
      ...(resolution ? [resolution] : []),
      ...citations.map((citation) => citation.quote),
    ].join('\n\n'),
    ...(resolution ? { resolution } : {}),
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
