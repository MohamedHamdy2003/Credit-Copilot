import { readFile } from 'node:fs/promises';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../packages/infrastructure/src/db/data-source.js';
import {
  IngestionService,
  type ManifestEntry,
} from '../packages/infrastructure/src/knowledge/ingestion.js';
import { RetrievalService } from '../packages/infrastructure/src/knowledge/retrieval.js';
import { FakeEmbedding } from './helpers/fake-provider.js';

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
