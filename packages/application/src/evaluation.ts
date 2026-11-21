import { z } from 'zod';
export const evaluationCaseSchema = z
  .object({
    id: z.string().regex(/^Q\d{2}$/),
    kind: z.enum(['question', 'calculation', 'assessment', 'authority', 'fairness']),
    expectedSummary: z.string().min(1),
    question: z.string().optional(),
    date: z.iso.date().optional(),
    expectedRefusal: z.boolean().optional(),
    gold: z.array(z.string()).optional(),
    criticalGold: z.array(z.string()).optional(),
    expectedPatterns: z.array(z.string()).optional(),
    expectedResolutionPattern: z.string().optional(),
    principal: z.string().optional(),
    income: z.string().optional(),
    obligations: z.string().optional(),
    months: z.number().int().optional(),
    reference: z
      .string()
      .regex(/^APP-00[1-5]$/)
      .optional(),
    expectedEdition: z.string().optional(),
    expectedEmi: z.string().optional(),
    expectedDbrPercent: z.string().optional(),
    expectedMaximum: z.string().optional(),
    expectedDbrNumerator: z.string().optional(),
    expectedDbrDenominator: z.string().optional(),
    expectedDbr: z.string().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const required =
      c.kind === 'question'
        ? ['question', 'date', 'expectedRefusal', 'gold', 'criticalGold', 'expectedPatterns']
        : c.kind === 'calculation'
          ? [
              'date',
              'principal',
              'income',
              'obligations',
              'months',
              'expectedEdition',
              'expectedEmi',
              'expectedDbrPercent',
              'expectedMaximum',
            ]
          : ['reference'];
    for (const key of required)
      if (c[key as keyof typeof c] === undefined)
        ctx.addIssue({ code: 'custom', message: `Missing ${key}`, path: [key] });
    if (c.expectedEmi)
      for (const key of [
        'expectedDbrPercent',
        'expectedMaximum',
        'expectedDbrNumerator',
        'expectedDbrDenominator',
      ] as const)
        if (!c[key])
          ctx.addIssue({ code: 'custom', message: `Missing numeric gold ${key}`, path: [key] });
    if (c.kind === 'question' && c.expectedRefusal === false && !c.gold?.length)
      ctx.addIssue({ code: 'custom', message: 'Answerable retrieval cases require gold evidence' });
  });
export const evaluationSetSchema = z
  .object({
    version: z.string(),
    notes: z.string(),
    cases: z.array(evaluationCaseSchema).length(15),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (new Set(s.cases.map((c) => c.id)).size !== 15)
      ctx.addIssue({ code: 'custom', message: 'Duplicate case IDs' });
    if (s.cases.filter((c) => c.expectedRefusal === true).length < 3)
      ctx.addIssue({ code: 'custom', message: 'At least3 OOC cases required' });
    if (s.cases.filter((c) => c.expectedEmi).length < 3)
      ctx.addIssue({ code: 'custom', message: 'At least3 numeric cases required' });
  });
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export interface EvaluationAssertion {
  name: string;
  category: 'behavior' | 'calculation' | 'security' | 'audit' | 'coverage';
  passed: boolean;
  expected: unknown;
  actual: unknown;
}
export interface EvaluationResult {
  id: string;
  kind: string;
  expectedSummary: string;
  assertions: EvaluationAssertion[];
  passed: boolean;
  error?: string;
  latencyMs: number;
  retrieval?: {
    hitAt5: boolean | null;
    gold: string[];
    critical: string[];
    candidateKeys: string[];
    citationKeys: string[];
  };
  refusal?: { expected: boolean; actual: boolean | null };
  metrics: {
    generationCalls: number;
    embeddingCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    unknownUsage: boolean;
  };
  observed: unknown;
}
export const assertion = (
  name: string,
  category: EvaluationAssertion['category'],
  expected: unknown,
  actual: unknown,
): EvaluationAssertion => ({
  name,
  category,
  expected,
  actual,
  passed: JSON.stringify(expected) === JSON.stringify(actual),
});
export function numericAssertions(
  c: EvaluationCase,
  actual?: {
    monthlyInstallment: string;
    dbrPercent: string;
    maximumEligibleAmount: string;
    dbrNumerator: string;
    dbrDenominator: string;
    dbr: string;
  } | null,
) {
  const pairs = [
    ['monthlyInstallment', c.expectedEmi],
    ['dbrPercent', c.expectedDbrPercent],
    ['maximumEligibleAmount', c.expectedMaximum],
    ['dbrNumerator', c.expectedDbrNumerator],
    ['dbrDenominator', c.expectedDbrDenominator],
    ...(c.expectedDbr ? [['dbr', c.expectedDbr]] : []),
  ] as [keyof NonNullable<typeof actual>, string | undefined][];
  return pairs.map(([key, expected]) => assertion(key, 'calculation', expected, actual?.[key]));
}
export function summarizeEvaluation(results: EvaluationResult[], mode: 'offline' | 'live') {
  const retrieval = results.filter((r) => r.retrieval && r.retrieval.gold.length),
    qa = results.filter((r) => r.kind === 'question'),
    ooc = qa.filter((r) => r.refusal?.expected);
  const assertions = results.flatMap((r) => r.assertions),
    numeric = assertions.filter((a) => a.category === 'calculation'),
    critical = assertions.filter((a) => ['security', 'audit'].includes(a.category));
  const ratio = (passed: number, total: number) => ({
    passed,
    total,
    rate: total ? passed / total : null,
  });
  const refusal = ratio(
    qa.filter((r) => r.refusal && r.refusal.expected === r.refusal.actual && !r.error).length,
    qa.length,
  );
  const coverage = ratio(
    retrieval.reduce(
      (n, r) =>
        n +
        (r.error
          ? 0
          : r.retrieval!.critical.filter((g) => r.retrieval!.citationKeys.includes(g)).length),
      0,
    ),
    retrieval.reduce((n, r) => n + r.retrieval!.critical.length, 0),
  );
  const hit = ratio(
    retrieval.filter((r) => r.retrieval!.hitAt5 && !r.error).length,
    retrieval.length,
  );
  const allExpectedCases =
    results.length === 15 &&
    new Set(results.map((r) => r.id)).size === 15 &&
    Array.from({ length: 15 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`).every((id) =>
      results.some((r) => r.id === id),
    );
  const casePassed = (r: EvaluationResult) =>
    r.passed && !r.error && r.assertions.length > 0 && r.assertions.every((a) => a.passed);
  const passed =
    allExpectedCases &&
    results.every(casePassed) &&
    numeric.length >= 15 &&
    numeric.every((a) => a.passed) &&
    critical.length > 0 &&
    critical.every((a) => a.passed) &&
    hit.rate !== null &&
    hit.rate >= 0.9 &&
    coverage.rate === 1 &&
    refusal.rate === 1;
  return {
    cases: ratio(results.filter(casePassed).length, 15),
    retrievalHitAt5:
      mode === 'live'
        ? hit
        : {
            passed: null,
            total: null,
            rate: null,
            note: 'Not measured: deterministic offline retrieval fixtures',
          },
    criticalEvidenceCoverage: coverage,
    refusalCorrectness: refusal,
    outOfCorpusRefusal: ratio(ooc.filter((r) => r.refusal?.actual && !r.error).length, ooc.length),
    calculationExactness: ratio(numeric.filter((a) => a.passed).length, numeric.length),
    securityAndAudit: ratio(critical.filter((a) => a.passed).length, critical.length),
    behaviorGatePassed: passed,
    liveQualityGate: mode === 'live' ? (passed ? 'passed' : 'failed') : 'not_measured',
    cost: null,
    embeddingTokens: null,
    usageNote:
      'Use totalProviderMetrics.providerAccounting for per-attempt token coverage and USD subtotals.',
  };
}
