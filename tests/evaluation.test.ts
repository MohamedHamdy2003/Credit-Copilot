import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

type LiveReport = {
  workingTreeDirty: boolean;
  completed: boolean;
  configuration: Record<string, unknown>;
  hashes: Record<string, string>;
  strictChecks: { passed: boolean }[];
  results: EvaluationResult[];
};
const readLiveReport = (name: string) =>
  JSON.parse(readFileSync(`data/evaluation/results/${name}.json`, 'utf8')) as LiveReport;

it('preserves the original case file used by historical live reports', () => {
  const original = readFileSync('data/evaluation/cases-core-15-v1.json');
  const historical = readLiveReport('vector-core-baseline');
  expect(evaluationSetSchema.parse(JSON.parse(original.toString())).version).toBe('core-15-v1');
  expect(createHash('sha256').update(original).digest('hex')).toBe(
    historical.hashes['data/evaluation/cases.json'],
  );
  expect(set.version).toBe('core-15-v2');
});

it('verifies the clean live hybrid comparison and keeps both provider failures in the evidence', () => {
  const vector = readLiveReport('vector-core-baseline');
  const hybrid = readLiveReport('hybrid-core-evaluation');
  expect(vector).toMatchObject({ completed: true, workingTreeDirty: false });
  expect(hybrid).toMatchObject({ completed: true, workingTreeDirty: false });
  expect(hybrid.configuration).toMatchObject({
    retrieval: 'bm25-pgvector-rrf',
    generationModel: vector.configuration.generationModel,
    embeddingModel: vector.configuration.embeddingModel,
    dimensions: vector.configuration.dimensions,
    minimumSimilarity: vector.configuration.minimumSimilarity,
    k: vector.configuration.k,
    hybridRanking: { branchLimit: 20, k1: 1.2, b: 0.75, rrfK: 60 },
  });
  for (const [path, hash] of Object.entries(vector.hashes)) {
    if (path.endsWith('/knowledge/retrieval.ts') || path === 'scripts/evaluation/runner.ts')
      continue;
    expect(hybrid.hashes[path]).toBe(hash);
  }
  expect(hybrid.strictChecks).toHaveLength(5);
  expect(hybrid.strictChecks.every((check) => check.passed)).toBe(true);
  expect(summarizeEvaluation(hybrid.results, 'live')).toMatchObject({
    cases: { passed: 15, total: 15 },
    retrievalHitAt5: { passed: 4, total: 4 },
    criticalEvidenceCoverage: { passed: 8, total: 8 },
    liveQualityGate: 'passed',
  });
  for (const [name, id] of [
    ['hybrid-initial-failure', 'Q03'],
    ['hybrid-repeat-failure', 'Q02'],
  ] as const) {
    const failed = readLiveReport(name);
    expect(failed.results.filter((result) => !result.passed)).toMatchObject([
      { id, error: 'ProviderUnavailable' },
    ]);
    expect(summarizeEvaluation(failed.results, 'live').cases).toMatchObject({
      passed: 14,
      total: 15,
    });
  }
});
it('rechecks the live rewrite comparison and its original rankings against the hybrid evidence', () => {
  const baseline = readLiveReport('hybrid-core-evaluation');
  const rewritten = readLiveReport('query-rewrite-core-evaluation');
  expect(rewritten).toMatchObject({ completed: true, workingTreeDirty: false });
  expect(rewritten.configuration).toMatchObject({
    ...baseline.configuration,
    queryRewrite: { method: 'glossary', maxExpansions: 2 },
  });
  const rankingFiles = new Set([
    'packages/infrastructure/src/knowledge/retrieval.ts',
    'packages/infrastructure/src/knowledge/hybrid-search.ts',
    'scripts/evaluation/runner.ts',
  ]);
  for (const [path, hash] of Object.entries(baseline.hashes)) {
    if (!rankingFiles.has(path)) expect(rewritten.hashes[path]).toBe(hash);
  }
  expect(rewritten.strictChecks).toHaveLength(5);
  expect(rewritten.strictChecks.every((check) => check.passed)).toBe(true);
  expect(summarizeEvaluation(rewritten.results, 'live')).toMatchObject({
    cases: { passed: 15, total: 15 },
    retrievalHitAt5: { passed: 4, total: 4 },
    criticalEvidenceCoverage: { passed: 8, total: 8 },
    outOfCorpusRefusal: { passed: 3, total: 3 },
    liveQualityGate: 'passed',
  });

  const applied: string[] = [];
  for (const result of rewritten.results) {
    const trace = (
      result.observed as {
        rewrite?: { originalChunkIds: string[]; expansions: string[] };
      } | null
    )?.rewrite;
    if (!trace) continue;
    applied.push(result.id);
    const original = baseline.results.find((caseResult) => caseResult.id === result.id)
      ?.observed as { candidates: { id: string }[] };
    expect(trace.originalChunkIds).toEqual(original.candidates.map((candidate) => candidate.id));
    expect(trace.expansions).toHaveLength(1);
  }
  expect(applied).toEqual(['Q01', 'Q02', 'Q03']);
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
