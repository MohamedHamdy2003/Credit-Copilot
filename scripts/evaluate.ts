import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { configSchema } from '../packages/contracts/src/config.js';
import {
  evaluationSetSchema,
  summarizeEvaluation,
  type EvaluationResult,
} from '../packages/application/src/evaluation.js';
import { createDataSource } from '../packages/infrastructure/src/db/data-source.js';
import { GeminiAdapter } from '../packages/infrastructure/src/llm/gemini.js';
import { EvaluationMeter } from '../packages/infrastructure/src/evaluation-meter.js';
import { hybridRanking } from '../packages/infrastructure/src/knowledge/hybrid-search.js';
import { CoreEvaluation } from './evaluation/runner.js';
import {
  IngestionService,
  type ManifestEntry,
} from '../packages/infrastructure/src/knowledge/ingestion.js';
import {
  OfflineEvaluationProvider,
  offlineEvaluationSearch,
} from '../tests/helpers/evaluation-provider.js';
import { invariant } from '../packages/domain/src/errors.js';
const args = process.argv.slice(2);
const mode = args.includes('--offline') ? 'offline' : 'live';
invariant(
  args.length <= 1 && args.every((arg) => ['--offline', '--vector', '--hybrid'].includes(arg)),
  'InvalidEvaluationArguments',
  'Use at most one of --offline, --vector or --hybrid',
);
const config = configSchema.parse({
  ...process.env,
  RETRIEVAL_STRATEGY:
    args[0] === '--vector'
      ? 'vector'
      : args[0] === '--hybrid'
        ? 'hybrid'
        : process.env.RETRIEVAL_STRATEGY,
});
const hybrid = mode === 'live' && config.RETRIEVAL_STRATEGY === 'hybrid';
const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const path = `artifacts/evaluation/${mode}-${id}.json`;
const dataset = evaluationSetSchema.parse(
  JSON.parse(await readFile('data/evaluation/cases.json', 'utf8')),
);
const url = new URL(
  mode === 'live'
    ? (config.EVALUATION_DATABASE_URL ?? config.DATABASE_URL)
    : (process.env.TEST_DATABASE_URL ?? config.DATABASE_URL),
);
if (mode === 'live' && !config.EVALUATION_DATABASE_URL && !url.pathname.endsWith('_eval'))
  url.pathname += '_eval';
if (mode === 'offline' && !url.pathname.endsWith('_test')) url.pathname += '_test';
invariant(
  new RegExp(mode === 'live' ? '_eval$' : '_test$').test(url.pathname),
  'UnsafeEvaluationDatabase',
  'Use a dedicated _eval (live) or _test (offline) database',
);
const name = decodeURIComponent(url.pathname.slice(1));
invariant(
  /^[a-z][a-z0-9_]{0,62}$/.test(name),
  'InvalidDatabaseName',
  'Evaluation database name must be a simple identifier',
);
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = await createDataSource(adminUrl.toString()).initialize();
try {
  const existing = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
    name,
  ])) as unknown[];
  if (!existing.length) await admin.query(`CREATE DATABASE "${name}"`);
} finally {
  await admin.destroy();
}
const db = await createDataSource(url.toString()).initialize();
let source: ReturnType<typeof createDataSource> | undefined, runner: CoreEvaluation | undefined;
const results: EvaluationResult[] = [];
const files = [
  'data/evaluation/cases.json',
  'data/config/policies.json',
  'data/config/personal-loan.json',
  'data/config/corpus-manifest.json',
  'prompts/extraction.txt',
  'prompts/questions.txt',
  'packages/application/src/questions.ts',
  'packages/application/src/document-assessment.ts',
  'packages/application/src/credit-memo.ts',
  'packages/application/src/extraction.ts',
  'packages/application/src/evidence-facts.ts',
  'packages/application/src/evaluation.ts',
  'packages/infrastructure/src/knowledge/retrieval.ts',
  'packages/infrastructure/src/knowledge/hybrid-search.ts',
  'packages/infrastructure/src/llm/gemini.ts',
  'packages/infrastructure/src/evaluation-meter.ts',
  'packages/domain/src/calculations.ts',
  'packages/domain/src/rules.ts',
  'scripts/evaluation/runner.ts',
];
const hashes: Record<string, string> = {};
for (const file of files)
  hashes[file] = createHash('sha256')
    .update((await readFile(file, 'utf8')).replace(/\r\n/g, '\n'))
    .digest('hex');
const manifest = JSON.parse(
  await readFile('data/config/corpus-manifest.json', 'utf8'),
) as ManifestEntry[];
for (const d of manifest)
  hashes[d.filename] = createHash('sha256')
    .update(await readFile(`data/corpus/policy/${d.filename}`))
    .digest('hex');
for (let n = 1; n <= 5; n++) {
  const name = `APP-00${n}.pdf`;
  hashes[`evidence/${name}`] = createHash('sha256')
    .update(await readFile(`data/corpus/evidence/${name}`))
    .digest('hex');
}
const report: { [key: string]: unknown } = {
  id,
  at: new Date().toISOString(),
  mode,
  dataset: dataset.version,
  scope:
    'Full15-case functional evaluation; standalone financial/rule checks never replace missing-evidence workflow outcomes.',
  configuration: {
    generationModel: mode === 'live' ? config.GENERATION_MODEL : 'test-only-evaluation',
    embeddingModel: mode === 'live' ? config.EMBEDDING_MODEL : 'test-only-hash-v1',
    dimensions: mode === 'live' ? config.EMBEDDING_DIMENSIONS : 64,
    minimumSimilarity: config.RETRIEVAL_MIN_SIMILARITY,
    k: 5,
    retrieval:
      mode === 'offline'
        ? 'deterministic-source-fixtures-NOT-semantic-quality'
        : hybrid
          ? 'bm25-pgvector-rrf'
          : 'vector-only',
    ...(hybrid ? { hybridRanking } : {}),
    answerContext:
      'Separate date/product-filtered operative source references and the read-only approval procedure. Citation coverage includes this context.',
    database: 'dedicated suffix only; credentials omitted',
  },
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty:
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  hashes,
  hashConvention:
    'SHA256; code/config text normalized to LF; supplied source-document bytes unchanged',
  completed: false,
  results,
};
await mkdir('artifacts/evaluation', { recursive: true });
const persist = () => writeFile(path, JSON.stringify(report, null, 2));
try {
  await db.runMigrations();
  if (mode === 'live') source = await createDataSource(config.DATABASE_URL).initialize();
  const provider =
    mode === 'live'
      ? new GeminiAdapter(
          config.GEMINI_API_KEY,
          config.GENERATION_MODEL,
          config.EMBEDDING_MODEL,
          config.EMBEDDING_DIMENSIONS,
        )
      : new OfflineEvaluationProvider();
  const meter = new EvaluationMeter(provider, source),
    ingestion = new IngestionService(db, meter, manifest);
  const ingested = [];
  for (const d of manifest)
    ingested.push(
      await ingestion.ingest(d.filename, await readFile(`data/corpus/policy/${d.filename}`)),
    );
  report.ingestion = {
    documents: ingested,
    documentEmbeddingCacheHits: meter.cacheHits,
    providerMetrics: meter.metrics(0),
  };
  runner = await CoreEvaluation.create(
    db,
    meter,
    config,
    mode === 'offline' ? offlineEvaluationSearch(db) : undefined,
  );
  report.strictChecks = await runner.strictChecks();
  for (const c of dataset.cases) {
    const result = await runner.run(c);
    results.push(result);
    await persist();
    console.log(
      `${c.id} ${result.passed ? 'PASS' : 'FAIL'} ${result.error ?? ''} ${result.latencyMs}ms`,
    );
    if (!result.passed)
      console.log(
        '  failed:',
        result.assertions
          .filter((a) => !a.passed)
          .map((a) => a.name)
          .join(', '),
      );
  }
  const summary = summarizeEvaluation(results, mode);
  const strictRows = report.strictChecks as { passed: boolean }[];
  const strict = strictRows.length === 5 && strictRows.every((s) => s.passed);
  report.summary = {
    ...summary,
    strictChecksPassed: strict,
    liveQualityGate:
      mode === 'live'
        ? summary.behaviorGatePassed && strict
          ? 'passed'
          : 'failed'
        : 'not_measured',
  };
  report.totalProviderMetrics = meter.metrics(0);
  report.completed = true;
  console.log(JSON.stringify(report.summary, null, 2));
  if (!summary.behaviorGatePassed || !strict) process.exitCode = 1;
} catch (error) {
  report.errorCode = error instanceof Error ? error.name : 'EvaluationInfrastructureFailure';
  report.completed = false;
  process.exitCode = 1;
  console.error('Evaluation failed; sanitized failure retained in report.');
} finally {
  await persist();
  console.log(`Report: ${path}`);
  if (runner) await runner.close();
  if (source?.isInitialized) await source.destroy();
  await db.destroy();
}
