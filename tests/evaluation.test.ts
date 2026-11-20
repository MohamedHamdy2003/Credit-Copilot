import { readFileSync } from 'node:fs';
import {
  assertion,
  evaluationSetSchema,
  numericAssertions,
  summarizeEvaluation,
  type EvaluationResult,
} from '../packages/application/src/evaluation.js';
const set = evaluationSetSchema.parse(
  JSON.parse(readFileSync('data/evaluation/cases.json', 'utf8')),
);
it('recomputes the committed live evidence instead of trusting summary/pass flags', () => {
  const initial = JSON.parse(
    readFileSync('data/evaluation/results/vector-initial.json', 'utf8'),
  ) as { results: EvaluationResult[] };
  const baseline = JSON.parse(
    readFileSync('data/evaluation/results/vector-core-baseline.json', 'utf8'),
  ) as {
    results: EvaluationResult[];
    summary: { liveQualityGate: string };
    strictChecks: { passed: boolean }[];
  };
  expect(summarizeEvaluation(initial.results, 'live').cases).toMatchObject({
    passed: 11,
    total: 15,
  });
  expect(summarizeEvaluation(baseline.results, 'live').liveQualityGate).toBe('passed');
  expect(baseline.summary.liveQualityGate).toBe('passed');
  expect(baseline.strictChecks).toHaveLength(5);
  expect(baseline.strictChecks.every((c) => c.passed)).toBe(true);
});
function results(): EvaluationResult[] {
  return set.cases.map((c) => ({
    id: c.id,
    kind: c.kind,
    expectedSummary: c.expectedSummary,
    passed: true,
    latencyMs: 1,
    metrics: {
      generationCalls: 0,
      embeddingCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      unknownUsage: false,
    },
    observed: null,
    assertions: [
      assertion('behavior', 'behavior', true, true),
      ...(c.expectedEmi
        ? numericAssertions(c, {
            monthlyInstallment: c.expectedEmi,
            dbrPercent: c.expectedDbrPercent!,
            maximumEligibleAmount: c.expectedMaximum!,
            dbrNumerator: c.expectedDbrNumerator!,
            dbrDenominator: c.expectedDbrDenominator!,
            dbr: c.expectedDbr ?? '',
          })
        : []),
      ...(c.id === 'Q10' ? [assertion('security', 'security', true, true)] : []),
    ],
    ...(c.kind === 'question'
      ? {
          refusal: { expected: c.expectedRefusal!, actual: c.expectedRefusal! },
          retrieval: {
            hitAt5: c.expectedRefusal ? null : true,
            gold: c.gold!,
            critical: c.criticalGold!,
            candidateKeys: c.gold!,
            citationKeys: c.criticalGold!,
          },
        }
      : {}),
  }));
}
it('freezes fifteen unique scenarios with three OOC, three calculations, paired editions and both injection surfaces', () => {
  expect(set.cases).toHaveLength(15);
  expect(set.cases.filter((c) => c.expectedRefusal)).toHaveLength(3);
  expect(set.cases.filter((c) => c.expectedEmi)).toHaveLength(3);
  expect(set.cases.filter((c) => c.expectedEdition).map((c) => c.expectedEdition)).toEqual([
    'CP-2024',
    'CP-2025',
  ]);
  const duplicate = structuredClone(set);
  duplicate.cases[1]!.id = 'Q01';
  expect(evaluationSetSchema.safeParse(duplicate).success).toBe(false);
  const missing = structuredClone(set);
  delete missing.cases[3]!.expectedDbrDenominator;
  expect(evaluationSetSchema.safeParse(missing).success).toBe(false);
});
it('scores labeled denominators and never treats fake retrieval as measured semantic quality', () => {
  const live = summarizeEvaluation(results(), 'live');
  expect(live.liveQualityGate).toBe('passed');
  expect(live.calculationExactness).toMatchObject({ passed: 17, total: 17 });
  expect(live.retrievalHitAt5).toMatchObject({ passed: 4, total: 4 });
  expect(live.criticalEvidenceCoverage).toMatchObject({ passed: 8, total: 8 });
  const offline = summarizeEvaluation(results(), 'offline');
  expect(offline.liveQualityGate).toBe('not_measured');
  expect(offline.retrievalHitAt5.rate).toBeNull();
  expect(offline.cost).toBeNull();
});
it('counts provider failures as failed cases/refusals with fixed denominators, not successful OOC refusal', () => {
  const r = results();
  r[6]!.error = 'ProviderUnavailable';
  r[6]!.passed = false;
  const summary = summarizeEvaluation(r, 'live');
  expect(summary.cases).toMatchObject({ passed: 14, total: 15 });
  expect(summary.refusalCorrectness).toMatchObject({ passed: 6, total: 7 });
  expect(summary.outOfCorpusRefusal).toMatchObject({ passed: 2, total: 3 });
  expect(summary.liveQualityGate).toBe('failed');
});
it('fails closed on a manipulated pass flag, missing case, empty denominator or wrong exact cent', () => {
  const r = results();
  r[3]!.assertions.push(assertion('exact_cent', 'calculation', '8630.39', '8630.40'));
  expect(summarizeEvaluation(r, 'live').liveQualityGate).toBe('failed');
  expect(summarizeEvaluation(results().slice(1), 'live').liveQualityGate).toBe('failed');
  expect(summarizeEvaluation([], 'live').liveQualityGate).toBe('failed');
});
