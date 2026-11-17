import { readFile } from 'node:fs/promises';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../packages/infrastructure/src/db/data-source.js';
import {
  IngestionService,
  type ManifestEntry,
} from '../packages/infrastructure/src/knowledge/ingestion.js';
import { RetrievalService } from '../packages/infrastructure/src/knowledge/retrieval.js';
import { FakeEmbedding } from './helpers/fake-provider.js';
import { FakeGeneration } from './helpers/fake-provider.js';
import { randomUUID } from 'node:crypto';
import { PostgresAssessmentRepository } from '../packages/infrastructure/src/db/assessment-repository.js';
import { assessAndRecord } from '../packages/application/src/assessment-record.js';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://copilot:copilot_local@localhost:54329/credit_copilot_test';
if (!new URL(url).pathname.endsWith('_test'))
  throw new Error('Integration tests require a dedicated *_test database');
let db: DataSource;
let manifest: ManifestEntry[];
beforeAll(async () => {
  db = await createDataSource(url).initialize();
  await db.runMigrations();
  manifest = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  ) as ManifestEntry[];
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE knowledge.documents,knowledge.chunks,knowledge.embeddings,knowledge.pricing,knowledge.ingestion_attempts CASCADE',
  );
});
afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
});

it('migrates idempotently and ingests/retrieves without duplicate or mixed evidence', async () => {
  expect(await db.runMigrations()).toHaveLength(0);
  const embedding = new FakeEmbedding();
  const ingestion = new IngestionService(db, embedding, manifest);
  for (const entry of manifest)
    await ingestion.ingest(entry.filename, await readFile(`data/corpus/policy/${entry.filename}`));
  const count = (await db.query('SELECT count(*)::int AS n FROM knowledge.chunks')) as {
    n: number;
  }[];
  const calls = embedding.calls;
  const first = manifest[0]!;
  expect(
    (await ingestion.ingest(first.filename, await readFile(`data/corpus/policy/${first.filename}`)))
      .status,
  ).toBe('skipped');
  expect(embedding.calls).toBe(calls);
  expect(await db.query('SELECT count(*)::int AS n FROM knowledge.chunks')).toEqual(count);
  const retrieval = new RetrievalService(db, embedding);
  const results = await retrieval.search('maximum debt burden ratio', '2025-04-01', 'PL-100', 20);
  expect(results.length).toBeGreaterThan(0);
  expect(results.every((r) => r.chunk.edition !== 'CP-2024' && r.chunk.edition !== '2024/07')).toBe(
    true,
  );
  expect(results.some((r) => r.chunk.section === 'CP-4.1')).toBe(true);
  await expect(
    ingestion.ingest('APP-001.pdf', await readFile('data/corpus/evidence/APP-001.pdf')),
  ).rejects.toThrow('manifest');
  const docs = (await db.query('SELECT count(*)::int AS n FROM knowledge.documents')) as {
    n: number;
  }[];
  expect(docs[0]?.n).toBe(7);
});

it('does not publish partial chunks when embedding fails', async () => {
  const good = new FakeEmbedding();
  let count = 0;
  const broken = {
    model: good.model,
    dimensions: good.dimensions,
    embed: async (text: string) => {
      if (++count === 2) throw new Error('Simulated provider outage');
      return good.embed(text);
    },
  };
  const ingestion = new IngestionService(db, broken, manifest);
  const first = manifest[0]!;
  await expect(
    ingestion.ingest(first.filename, await readFile(`data/corpus/policy/${first.filename}`)),
  ).rejects.toThrow();
  expect(await db.query('SELECT count(*)::int AS n FROM knowledge.chunks')).toEqual([{ n: 0 }]);
  expect(await db.query('SELECT status FROM knowledge.ingestion_attempts')).toEqual([
    { status: 'failed' },
  ]);
});

it('serializes concurrent duplicate imports', async () => {
  const ingestion = new IngestionService(db, new FakeEmbedding(), manifest);
  const entry = manifest.find((e) => e.kind === 'pricing')!;
  const bytes = await readFile(`data/corpus/policy/${entry.filename}`);
  await Promise.all([
    ingestion.ingest(entry.filename, bytes),
    ingestion.ingest(entry.filename, bytes),
  ]);
  expect(await db.query('SELECT count(*)::int AS n FROM knowledge.documents')).toEqual([{ n: 1 }]);
  expect(await db.query('SELECT count(*)::int AS n FROM knowledge.pricing')).toEqual([{ n: 6 }]);
});

it('keeps historical citation chunks while atomically activating a new pipeline revision', async () => {
  const embedding = new FakeEmbedding();
  const service = new IngestionService(db, embedding, manifest);
  const entry = manifest.find((e) => e.kind === 'pricing')!;
  const bytes = await readFile(`data/corpus/policy/${entry.filename}`);
  await service.ingest(entry.filename, bytes);
  // Simulate a previous pipeline's retained chunks without changing source bytes.
  // Create a retained historical chunk without mutating existing citation ids.
  await db.query(
    "INSERT INTO knowledge.chunks(id,document_id,ordinal,text,metadata,edition,product,effective_from,pipeline_version,active) SELECT 'historic',document_id,0,text,metadata,edition,product,effective_from,'previous',true FROM knowledge.chunks WHERE document_id=$1 LIMIT 1",
    [entry.id],
  );
  await db.query("UPDATE knowledge.documents SET pipeline_version='previous' WHERE id=$1", [
    entry.id,
  ]);
  await service.ingest(entry.filename, bytes);
  expect(await db.query("SELECT active FROM knowledge.chunks WHERE id='historic'")).toEqual([
    { active: false },
  ]);
  expect(
    await db.query(
      'SELECT count(*)::int AS n FROM knowledge.index_revisions WHERE document_id=$1',
      [entry.id],
    ),
  ).toEqual([{ n: 1 }]);
  expect(
    await db.query(
      'SELECT count(*)::int AS n FROM knowledge.chunks WHERE document_id=$1 AND active',
      [entry.id],
    ),
  ).toEqual([{ n: 6 }]);
});

it('atomically preserves immutable assessment, demo assumptions and fraud referrals', async () => {
  const actorId = randomUUID(),
    applicationId = randomUUID(),
    runId = randomUUID();
  const doc = await new ParserRegistry().extract(
    'APP-004.pdf',
    await readFile('data/corpus/evidence/APP-004.pdf'),
  );
  await db.query(
    'INSERT INTO cases.users(id,username,password_hash,role,tier) VALUES($1,$2,$3,$4,$5)',
    [actorId, actorId, 'test-hash', 'loan_officer', 'none'],
  );
  await db.query(
    'INSERT INTO cases.applications(id,reference,preparer_id,filename,hash,normalized,synthetic) VALUES($1,$2,$3,$4,$5,$6,true)',
    [applicationId, 'APP-004', actorId, doc.filename, doc.hash, doc],
  );
  const input = {
    document: doc,
    actorId,
    at: '2026-11-17T12:00:00Z',
    synthetic: true,
    requestedMode: 'demo' as const,
    evidence: [{ requirement: 'national_id_copy', present: false, verified: false }],
    verifiedFacts: {
      certificateDate: '2025-04-15',
      confirmed: true,
      hasDefault: false,
      bankEmployee: false,
      purposeAllowed: true,
      plannedDisbursement: '2025-04-22',
    },
  };
  const dependencies = {
    provider: new FakeGeneration({}),
    prompt: 'test',
    policies: JSON.parse(await readFile('data/config/policies.json', 'utf8')),
    product: JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')),
    pricing: [],
    settings: { allowDemo: true },
  };
  const repository = new PostgresAssessmentRepository(db);
  const result = await assessAndRecord(input, dependencies, repository, {
    runId,
    applicationId,
    requestId: 'integration-request',
  });
  expect(result.recommendation).toBe('REFER_TO_HUMAN');
  const rows = (await db.query('SELECT event,details FROM cases.audit_events WHERE run_id=$1', [
    runId,
  ])) as { event: string; details: Record<string, unknown> }[];
  expect(rows.some((r) => r.event === 'FRAUD_UNIT_REFERRAL')).toBe(true);
  expect(rows.find((r) => r.event === 'DEMO_EVIDENCE_ASSUMPTION')?.details.verified).toBe(false);
  const count = rows.length;
  await expect(
    assessAndRecord(input, dependencies, repository, {
      runId,
      applicationId,
      requestId: 'duplicate',
    }),
  ).rejects.toThrow();
  expect(
    (await db.query('SELECT id FROM cases.audit_events WHERE run_id=$1', [runId])).length,
  ).toBe(count);
  const forbiddenRun = randomUUID();
  await expect(
    repository.save({
      id: forbiddenRun,
      applicationId,
      actorId: randomUUID(),
      requestId: 'forbidden',
      at: input.at,
      result,
    }),
  ).rejects.toThrow('preparer');
  expect(
    await db.query('SELECT id FROM cases.assessment_runs WHERE id=$1', [forbiddenRun]),
  ).toEqual([]);
});
