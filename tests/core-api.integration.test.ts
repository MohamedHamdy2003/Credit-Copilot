import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { StreamFrame } from '../packages/contracts/src/streams.js';
import type { UsageEvent, UsageSummary } from '../packages/contracts/src/usage.js';
import { PostgresUsageStore } from '../packages/infrastructure/src/db/usage-store.js';
import { ModelUsageEvents1794916800008 } from '../packages/infrastructure/src/db/migrations/ModelUsageEvents.js';
import { priceAttempt } from '../packages/infrastructure/src/llm/pricing.js';
import { issuedOfferDocumentSchema } from '../packages/contracts/src/offers.js';
import type { DataSource } from 'typeorm';
import { createApi } from '../apps/api/src/app.js';
import { createDataSource } from '../packages/infrastructure/src/db/data-source.js';
import { PostgresAuthStore } from '../packages/infrastructure/src/auth/store.js';
import { ScryptCredentials } from '../packages/infrastructure/src/auth/passwords.js';
import { PostgresDecisionStore } from '../packages/infrastructure/src/db/decision-store.js';
import { AuthService } from '../packages/application/src/auth.js';
import { DecisionService } from '../packages/application/src/decisions.js';
import { createOperations } from '../packages/infrastructure/src/operations.js';
import { configSchema } from '../packages/contracts/src/config.js';
import { WorkflowTestProvider } from './helpers/workflow-provider.js';
import { DomainError } from '../packages/domain/src/errors.js';
import { GenerationFallback } from '../packages/infrastructure/src/llm/provider.js';
import { PostgresAssessmentRepository } from '../packages/infrastructure/src/db/assessment-repository.js';
import type { AssessmentResult } from '../packages/application/src/assessment-record.js';
import { loadProductCatalog } from '../packages/infrastructure/src/product-catalog.js';
import { RetrievalService } from '../packages/infrastructure/src/knowledge/retrieval.js';
import {
  IngestionService,
  type ManifestEntry,
} from '../packages/infrastructure/src/knowledge/ingestion.js';
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://copilot:copilot_local@localhost:54329/credit_copilot_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
let db: DataSource, app: INestApplication, hash: string;
let primaryUnavailable = false,
  localUnavailable = false,
  forgeCitation = false;
const localProvider = new WorkflowTestProvider();
const provider = new WorkflowTestProvider(),
  password = `test-${randomUUID()}`;
beforeAll(async () => {
  db = await createDataSource(url).initialize();
  await db.runMigrations();
  hash = await new ScryptCredentials().hash(password);
  const catalog = await loadProductCatalog();
  const policies = Object.values(catalog).flatMap((item) => item.policies);
  const manifest = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  ) as ManifestEntry[];
  const ingestion = new IngestionService(db, provider, manifest);
  for (const doc of manifest)
    await ingestion.ingest(doc.filename, await readFile(`data/corpus/policy/${doc.filename}`));
  const config = configSchema.parse({
    DATABASE_URL: url,
    ALLOW_DEMO_MODE: 'true',
    EMBEDDING_DIMENSIONS: '64',
    RETRIEVAL_MIN_SIMILARITY: '0',
  });
  app = await createApi({
    auth: new AuthService(new PostgresAuthStore(db), new ScryptCredentials(), 8),
    decisions: new DecisionService(new PostgresDecisionStore(db, policies)),
    operations: await createOperations(
      db,
      new GenerationFallback(
        {
          model: provider.model,
          dimensions: provider.dimensions,
          embed: provider.embed.bind(provider),
          completeStructured: async (system, data) => {
            if (primaryUnavailable)
              throw new DomainError('ProviderUnavailable', 'Fixture primary outage', 503, {
                model: 'gemini-test',
                retryable: true,
              });
            if (forgeCitation)
              return {
                model: 'fake',
                usage: { inputTokens: 1, outputTokens: 1 },
                value: { citations: [{ chunkId: 'unknown', quote: 'UNVERIFIED_TEXT' }] },
              };
            return provider.completeStructured(system, data);
          },
        },
        {
          completeStructured: async (system, data) => {
            if (localUnavailable)
              throw new DomainError('ProviderUnavailable', 'Fixture private provider detail', 503);
            return {
              ...(await localProvider.completeStructured(system, data)),
              model: 'ollama:test-local',
            };
          },
        },
      ),
      config,
      catalog,
    ),
    maxUploadBytes: 100000,
    webOrigin: 'http://localhost:5173',
    secureCookies: false,
    sessionHours: 8,
  });
  await app.listen(0, '127.0.0.1');
}, 60000);
beforeEach(async () => {
  await db.query('DELETE FROM cases.login_attempts');
  provider.texts = [];
  localProvider.texts = [];
  primaryUnavailable = false;
  localUnavailable = false;
  forgeCitation = false;
});
afterAll(async () => {
  await app?.close();
  if (db?.isInitialized) await db.destroy();
});
async function account(tier = 'none', canIngest = false) {
  const id = randomUUID(),
    username = randomUUID();
  await db.query(
    'INSERT INTO cases.users(id,username,password_hash,role,tier,can_ingest) VALUES($1,$2,$3,$4,$5,$6)',
    [id, username, hash, tier === 'none' ? 'loan_officer' : 'credit_officer', tier, canIngest],
  );
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username, password })
    .expect(201);
  return {
    id,
    cookie: login.headers['set-cookie'] as unknown as string[],
    csrf: login.body.csrfToken as string,
  };
}
const post = (path: string, s: { cookie: string[]; csrf: string }) =>
  request(app.getHttpServer())
    .post(`/api/v1/${path}`)
    .set('Cookie', s.cookie)
    .set('x-csrf-token', s.csrf);
async function select(s: Awaited<ReturnType<typeof account>>, reference = 'APP-001') {
  const result = await post(`applications/fixtures/${reference}`, s).send({}).expect(201);
  return result.body.id as string;
}

function readFrames<T>(body: string): StreamFrame<T>[] {
  return [...body.matchAll(/^id: (\d+)\ndata: (.+)$/gm)].map(([, id, data]) => ({
    id: Number(id),
    data: JSON.parse(data!),
  }));
}
const readStream = (path: string, owner: Awaited<ReturnType<typeof account>>) =>
  request(app.getHttpServer()).get(`/api/v1/${path}`).set('Cookie', owner.cookie);

async function readUsage(owner: Awaited<ReturnType<typeof account>>, runId?: string) {
  const result = await readStream(runId ? `usage/me?runId=${runId}` : 'usage/me', owner)
    .expect('Cache-Control', 'private, no-store')
    .expect(200);
  return result.body as UsageSummary;
}

it('reports owned usage across assessment and question replays without counting them twice', async () => {
  const owner = await account();
  const reviewer = await account('senior');
  await request(app.getHttpServer()).get('/api/v1/usage/me').expect(401);
  await readStream(`usage/me?actorId=${owner.id}`, reviewer).expect(422);
  expect((await readUsage(owner)).totals).toMatchObject({
    calls: 0,
    inputTokens: { knownTotal: null, missingCalls: 0 },
    actualUsd: { knownTotal: null, missingCalls: 0 },
  });
  const id = await select(owner);
  const strict = await post(`applications/${id}/assessments`, owner).send({}).expect(201);
  expect((await readUsage(owner, strict.body.runId)).totals.calls).toBe(0);
  const assess = () =>
    post(`applications/${id}/assessments`, owner)
      .set('Idempotency-Key', 'accounting-assessment')
      .send({ mode: 'demo' })
      .expect(201);
  const assessment = await assess();
  expect((await assess()).body.runId).toBe(assessment.body.runId);
  const runId = assessment.body.runId as string;
  const start = () =>
    post('questions/streams', owner)
      .set('Idempotency-Key', 'accounting-question')
      .send({ question: 'Maximum DBR in CP-2025?' })
      .expect(202);
  const question = await start();
  const streamId = question.body.streamId as string;
  expect((await start()).body.streamId).toBe(streamId);
  const firstRead = await readStream(`question-streams/${streamId}`, owner).expect(200);
  expect(firstRead.text).toContain('"refused":false');
  await readStream(`question-streams/${streamId}`, owner).set('Last-Event-ID', '1').expect(200);

  const summary = await readUsage(owner);
  expect(summary.totals).toMatchObject({
    calls: 3,
    failedCalls: 0,
    retries: 0,
    fallbacks: 0,
    legacyCalls: 0,
    inputTokens: { knownTotal: 13, missingCalls: 1 },
    outputTokens: { knownTotal: 9, missingCalls: 0 },
    estimatedUsd: { knownTotal: null, missingCalls: 3 },
    actualUsd: { knownTotal: null, missingCalls: 3 },
  });
  expect(summary.groups.map((group) => group.step).sort()).toEqual([
    'answer',
    'extract_data',
    'retrieve',
  ]);
  expect(summary.recentRuns).toEqual([{ runId, lastRecordedAt: expect.any(String), calls: 1 }]);
  expect((await readUsage(owner, runId)).totals.calls).toBe(1);
  expect((await readUsage(reviewer)).totals.calls).toBe(0);
  expect((await readUsage(reviewer, runId)).groups).toEqual([]);
  const [observed] = await db.query(
    'SELECT request_id,step FROM cases.model_usage_events WHERE run_id=$1',
    [runId],
  );
  expect(observed).toEqual({
    request_id: assessment.headers['x-request-id'],
    step: 'extract_data',
  });
});

it('keeps decimal totals and rate snapshots when the same batch is submitted twice', async () => {
  const owner = await account();
  const store = new PostgresUsageStore(db);
  const usage = {
    model: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    kind: 'generation',
    outcome: 'succeeded',
    retry: true,
    inputTokens: 1000,
    outputTokens: 200,
  } as const;
  const base: UsageEvent = {
    ...usage,
    id: randomUUID(),
    actorId: owner.id,
    runId: randomUUID(),
    requestId: randomUUID(),
    operation: 'assessment',
    step: 'plan_extract_data',
    fallbackFrom: null,
    ...priceAttempt(usage, 'confirmed_free'),
    occurredAt: new Date().toISOString(),
  };
  const failed = {
    ...usage,
    outcome: 'failed',
    retry: false,
    inputTokens: null,
    outputTokens: null,
  } as const;
  const batch: UsageEvent[] = [
    base,
    { ...base, ...failed, ...priceAttempt(failed, 'unknown'), id: randomUUID() },
  ];
  await store.record(batch);
  await store.record(batch);
  const { totals } = await readUsage(owner, base.runId!);
  expect(totals).toMatchObject({
    calls: 2,
    failedCalls: 1,
    retries: 1,
    freeTierCalls: 1,
    inputTokens: { knownTotal: 1000, missingCalls: 1 },
    estimatedUsd: { knownTotal: '0.0008', missingCalls: 1 },
    actualUsd: { knownTotal: '0', missingCalls: 1 },
  });
  const [row] = await db.query('SELECT rate_snapshot FROM cases.model_usage_events WHERE id=$1', [
    base.id,
  ]);
  expect(row.rate_snapshot).toMatchObject({
    capturedOn: '2026-11-21',
    inputUsdPerMillion: '0.30',
    outputUsdPerMillion: '2.50',
  });
});

it('backfills attributable historical usage without assigning it a price or provider', async () => {
  const owner = await account();
  const legacyId = randomUUID();
  const migration = new ModelUsageEvents1794916800008();
  const tx = db.createQueryRunner();
  await tx.connect();
  await tx.startTransaction();
  try {
    // Exercise the upgrade in a rolled-back transaction on the dedicated test database.
    await migration.down(tx);
    await tx.query(
      "INSERT INTO cases.llm_usage(id,actor_id,model,operation,input_tokens) VALUES($1,$2,'older-model','extraction',17)",
      [legacyId, owner.id],
    );
    await migration.up(tx);
    const [entry] = await tx.query(
      'SELECT id,actor_id,step,provider,outcome,input_tokens,output_tokens,list_cost_usd,actual_cost_usd FROM cases.model_usage_events WHERE id=$1',
      [legacyId],
    );
    expect(entry).toEqual({
      id: legacyId,
      actor_id: owner.id,
      step: 'legacy_assessment',
      provider: 'unknown',
      outcome: 'unknown',
      input_tokens: '17',
      output_tokens: null,
      list_cost_usd: null,
      actual_cost_usd: null,
    });
  } finally {
    await tx.rollbackTransaction();
    await tx.release();
  }
});

async function extractOfferPdf(bytes: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
  });
  try {
    const document = await task.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const { items } = await page.getTextContent();
      pages.push(items.map((item) => ('str' in item ? item.str : '')).join(' '));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

it('streams owned assessment stages and resumes after disconnect without a duplicate job or approval', async () => {
  const owner = await account();
  const other = await account('senior');
  const application = await select(owner);
  const start = () =>
    post(`applications/${application}/assessment-streams`, owner)
      .set('Idempotency-Key', 'stream-review')
      .send({ mode: 'demo' })
      .expect(202);
  let release!: () => void;
  provider.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    provider.onGeneration = resolve;
  });
  const controller = new AbortController();
  const started = await start();
  const runId = started.body.runId as string;
  const path = `assessment-streams/${runId}`;
  let received = 0;
  try {
    await entered;
    await request(app.getHttpServer()).get(`/api/v1/${path}`).expect(401);
    await readStream(path, other).expect(404);
    await readStream(path, owner).set('Last-Event-ID', 'invalid').expect(422);
    expect((await start()).body).toEqual({ runId });
    const live = await fetch(`${await app.getUrl()}/api/v1/${path}`, {
      headers: { Cookie: owner.cookie.map((cookie) => cookie.split(';')[0]).join('; ') },
      signal: controller.signal,
    });
    expect(live.headers.get('content-type')).toContain('text/event-stream');
    expect(live.headers.get('cache-control')).toContain('no-store');
    expect(live.headers.get('x-accel-buffering')).toBe('no');
    const reader = live.body!.getReader();
    const decoder = new TextDecoder();
    let content = '';
    while (!content.includes('\n\n')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      content += decoder.decode(chunk.value, { stream: true });
    }
    const frames = readFrames<{ kind: string; stage: string }>(content);
    expect(frames[0]).toEqual({
      id: 1,
      data: { kind: 'stage', stage: 'load_application', status: 'executed' },
    });
    received = frames.at(-1)!.id;
    expect(frames.every(({ data }) => data.kind === 'stage')).toBe(true);
    controller.abort();
  } finally {
    controller.abort();
    release();
    provider.onGeneration = undefined;
    provider.gate = undefined;
  }
  const replay = await readStream(path, owner).set('Last-Event-ID', String(received)).expect(200);
  const remainder = readFrames(replay.text);
  expect(remainder.map((f) => f.id)).toEqual(
    Array.from({ length: 9 - received }, (_, i) => received + i + 1),
  );
  expect(remainder.at(-1)).toEqual({ id: 9, data: { kind: 'completed', runId } });
  expect((await start()).body).toEqual({ runId });
  const saved = await readStream(`assessments/${runId}`, owner).expect(200);
  expect(saved.body.status).toBe('pending_approval');
  expect(
    await db.query(
      'SELECT count(*)::int AS count FROM cases.assessment_jobs WHERE application_id=$1',
      [application],
    ),
  ).toEqual([{ count: 1 }]);
  expect(
    await db.query(
      'SELECT count(*)::int AS count FROM cases.assessment_runs WHERE application_id=$1',
      [application],
    ),
  ).toEqual([{ count: 1 }]);
  expect(provider.texts.filter((input) => input.startsWith('{'))).toHaveLength(1);
});

it('streams only verified policy citations and emits refusal or failure as terminal events', async () => {
  const owner = await account();
  const other = await account();
  const body = {
    question: 'maximum debt burden ratio for 28704121234567 phone 010-0000-0001',
    asOfDate: '2025-04-03',
  };
  const start = (key: string) =>
    post('questions/streams', owner).set('Idempotency-Key', key).send(body).expect(202);
  await request(app.getHttpServer())
    .post('/api/v1/questions/streams')
    .set('Cookie', owner.cookie)
    .set('Idempotency-Key', 'no-csrf')
    .send(body)
    .expect(403);
  const { streamId } = (await start('citations')).body as { streamId: string };
  expect((await start('citations')).body).toEqual({ streamId });
  await post('questions/streams', owner)
    .set('Idempotency-Key', 'citations')
    .send({ ...body, question: 'a different question' })
    .expect(409);
  const path = `question-streams/${streamId}`;
  await readStream(path, other).expect(404);
  await request(app.getHttpServer()).get(`/api/v1/${path}`).expect(401);
  const answer = await readStream(path, owner).expect(200);
  const frames = readFrames<{ kind: string; citation?: { quote: string } }>(answer.text);
  expect(frames[0]?.data.citation?.quote).toMatch(/45/);
  expect(frames.at(-1)?.data).toEqual({
    kind: 'completed',
    asOfDate: '2025-04-03',
    refused: false,
  });
  const reconnected = await readStream(path, owner).set('Last-Event-ID', '1').expect(200);
  expect(readFrames(reconnected.text)).toEqual(frames.slice(1));
  expect(provider.texts.filter((input) => input.startsWith('{'))).toHaveLength(1);
  expect(answer.text + provider.texts.join(' ')).not.toMatch(/28704121234567|010-0000-0001/);
  forgeCitation = true;
  const forged = await start('forged');
  const refusal = await readStream(`question-streams/${forged.body.streamId}`, owner).expect(200);
  expect(refusal.text).not.toContain('UNVERIFIED_TEXT');
  expect(readFrames(refusal.text)).toEqual([
    { id: 1, data: { kind: 'completed', asOfDate: '2025-04-03', refused: true } },
  ]);
  primaryUnavailable = true;
  localUnavailable = true;
  const outage = await start('outage');
  const failed = await readStream(`question-streams/${outage.body.streamId}`, owner).expect(200);
  expect(failed.text).not.toContain('Fixture');
  expect(readFrames(failed.text)).toEqual([
    { id: 1, data: { kind: 'failed', code: 'QuestionUnavailable' } },
  ]);
});

it('closes an open question stream when its session is revoked', async () => {
  const owner = await account();
  let release!: () => void;
  provider.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    provider.onGeneration = resolve;
  });
  const { streamId } = (
    await post('questions/streams', owner)
      .set('Idempotency-Key', 'logout-stream')
      .send({ question: 'Maximum DBR in CP-2025?' })
      .expect(202)
  ).body;
  const path = `question-streams/${streamId}`;
  const controller = new AbortController();
  try {
    await entered;
    const response = await fetch(`${await app.getUrl()}/api/v1/${path}`, {
      headers: { Cookie: owner.cookie.map((cookie) => cookie.split(';')[0]).join('; ') },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await post('auth/logout', owner).send({}).expect(201);
    expect(await response.text()).toBe('');
    await readStream(path, owner).expect(401);
  } finally {
    controller.abort();
    release();
    provider.onGeneration = undefined;
    provider.gate = undefined;
  }
});

it('uploads original synthetic bytes idempotently and enforces evidence ownership', async () => {
  const owner = await account(),
    other = await account();
  const bytes = await readFile('data/corpus/evidence/APP-001.pdf');
  const alias = 'customer-28704121234567-01000000001.pdf';
  const first = await post('applications', owner).attach('file', bytes, alias).expect(201);
  const repeat = await post('applications', owner).attach('file', bytes, 'APP-001.pdf').expect(201);
  expect(repeat.body.id).toBe(first.body.id);
  expect(repeat.body.duplicate).toBe(true);
  const meta = await request(app.getHttpServer())
    .get(`/api/v1/applications/${first.body.id}`)
    .set('Cookie', owner.cookie)
    .expect(200);
  expect(JSON.stringify(meta.body)).not.toContain('28704121234567');
  const download = await request(app.getHttpServer())
    .get(`/api/v1/applications/${first.body.id}/evidence`)
    .set('Cookie', owner.cookie)
    .expect(200);
  expect(Buffer.from(download.body)).toEqual(bytes);
  expect(download.headers['content-disposition']).toContain('APP-001.pdf');
  expect(download.headers['content-disposition']).not.toContain(alias);
  // Simulate an application registered before canonical names were enforced.
  await db.query(
    "UPDATE cases.applications SET normalized=jsonb_set(normalized, '{filename}', to_jsonb($1::text)) WHERE id=$2",
    [alias, first.body.id],
  );
  await post(`applications/${first.body.id}/assessments`, owner).send({ mode: 'demo' }).expect(201);
  expect(provider.texts.some((input) => input.includes('"source":"application-pack"'))).toBe(true);
  expect(provider.texts.join(' ')).not.toContain(alias);
  await request(app.getHttpServer())
    .get(`/api/v1/applications/${first.body.id}/evidence`)
    .set('Cookie', other.cookie)
    .expect(403);
  await post(`applications/${first.body.id}/assessments`, other).send({}).expect(403);
});
it('rejects unsupported, unrecognized, oversized or client-asserted synthetic uploads', async () => {
  const s = await account();
  const bytes = await readFile('data/corpus/evidence/APP-001.pdf');
  await post('applications', s).attach('file', bytes, 'application.docx').expect(415);
  await post('applications', s)
    .attach('file', bytes, { filename: 'APP-001.pdf', contentType: 'text/html' })
    .expect(415);
  await post('applications', s)
    .attach('file', Buffer.from('not reviewed synthetic data'), 'application.md')
    .expect(403);
  await post('applications', s).attach('file', Buffer.alloc(100001), 'large.pdf').expect(413);
  await post('applications', s)
    .field('synthetic', 'true')
    .attach('file', bytes, 'APP-001.pdf')
    .expect(400);
});
it('keeps policy ingestion permission and trust checks separate from customer evidence', async () => {
  const loan = await account(),
    head = await account('head', true);
  const bytes = await readFile('data/corpus/policy/circular-2025-02.md');
  await post('knowledge/ingestions', loan)
    .attach('files', bytes, 'circular-2025-02.md')
    .expect(403);
  const result = await post('knowledge/ingestions', head)
    .attach('files', bytes, 'circular-2025-02.md')
    .attach('files', await readFile('data/corpus/evidence/APP-001.pdf'), 'APP-001.pdf')
    .expect(201);
  expect(result.body.results[0].result.status).toBe('skipped');
  expect(result.body.results[1].code).toBe('UntrustedPolicyDocument');
  expect(
    (await db.query("SELECT id FROM knowledge.documents WHERE filename LIKE 'APP-%'")).length,
  ).toBe(0);
});
it('defaults to Strict, records a referral and replays idempotent requests without new runs', async () => {
  const s = await account(),
    id = await select(s);
  const key = randomUUID();
  const first = await post(`applications/${id}/assessments`, s)
    .set('Idempotency-Key', key)
    .send({})
    .expect(201);
  expect(first.body.result.mode).toBe('strict');
  expect(first.body.result.recommendation).toBe('REFER_TO_HUMAN');
  const second = await post(`applications/${id}/assessments`, s)
    .set('Idempotency-Key', key)
    .send({})
    .expect(201);
  expect(second.body.runId).toBe(first.body.runId);
  await post(`applications/${id}/assessments`, s)
    .set('Idempotency-Key', key)
    .send({ mode: 'demo' })
    .expect(409);
  await post(`applications/${id}/assessments`, s)
    .send({ verifiedFacts: { confirmed: true }, synthetic: true })
    .expect(422);
  expect(
    await db.query('SELECT count(*)::int AS n FROM cases.assessment_runs WHERE application_id=$1', [
      id,
    ]),
  ).toEqual([{ n: 1 }]);
});
it('runs upload→assessment→human approval→issue→authorized offer read with real HTTP/database', async () => {
  const owner = await account(),
    senior = await account('senior'),
    other = await account();
  const id = await select(owner);
  const assessment = await post(`applications/${id}/assessments`, owner)
    .send({ mode: 'demo' })
    .expect(201);
  const runId = assessment.body.runId;
  expect(assessment.body.result.recommendation).toBe('APPROVE');
  expect(assessment.body.result.calculation.monthlyInstallment).toBe('8630.39');
  await readStream(`offers/${runId}/document`, owner).expect(404);
  await db.query(
    "INSERT INTO cases.assessment_jobs(run_id,application_id,request_key,mode,status,created_at) VALUES($1,$2,'review-after-timeout','demo','running',now()-interval '16 minutes')",
    [randomUUID(), id],
  );
  await post(`assessments/${runId}/decisions`, senior)
    .send({
      action: 'approve',
      expectedVersion: 1,
      comment: 'Policy and evidence reviewed for synthetic demo',
    })
    .expect(201);
  await readStream(`offers/${runId}/document`, owner).expect(404);
  await post(`assessments/${runId}/decisions`, senior)
    .send({
      action: 'issue',
      expectedVersion: 2,
      comment: 'Authorized simulation',
      disbursementDate: '2025-04-03',
    })
    .expect(201);
  const offers = (await db.query('SELECT id FROM cases.offers WHERE run_id=$1', [runId])) as {
    id: string;
  }[];
  const offer = await request(app.getHttpServer())
    .get(`/api/v1/offers/${offers[0]!.id}`)
    .set('Cookie', owner.cookie)
    .expect(200);
  expect(offer.body.data.mode).toBe('demo');
  expect(offer.body.data.fullyEvidenceVerified).toBe(false);
  expect(offer.body.documentAvailable).toBe(true);
  expect(offer.body.data.document).toBeUndefined();
  const offerId = offers[0]!.id;
  const downloadPath = `offers/${offerId}/document`;
  await request(app.getHttpServer()).get(`/api/v1/${downloadPath}`).expect(401);
  await readStream(downloadPath, other).expect(403);
  const pdf = await readStream(downloadPath, owner)
    .expect('Content-Type', /application\/pdf/)
    .expect('Cache-Control', 'private, no-store')
    .expect('Content-Disposition', 'attachment; filename="credit-copilot-offer-APP-001.pdf"')
    .expect(200);
  const reviewerPdf = await readStream(downloadPath, senior).expect(200);
  expect(reviewerPdf.body).toEqual(pdf.body);
  const [record] = await db.query(
    'SELECT o.data, o.created_at, o.approval_id, ap.approver_id, ap.created_at AS approved_at FROM cases.offers o JOIN cases.approvals ap ON ap.id=o.approval_id WHERE o.id=$1',
    [offerId],
  );
  const snapshot = issuedOfferDocumentSchema.parse(record.data.document);
  expect(snapshot).toMatchObject({
    offerId,
    runId,
    principal: '300000.00',
    annualRatePercent: '24.00',
    policyEdition: 'CP-2025',
    fullyEvidenceVerified: false,
    approval: {
      id: record.approval_id,
      preparerId: owner.id,
      approverId: record.approver_id,
      approvedAt: record.approved_at.toISOString(),
      approverTier: 'senior',
      approverAuthorityLimit: '500000.00',
    },
    issuance: {
      issuedAt: record.created_at.toISOString(),
      issuerId: senior.id,
      issuerTier: 'senior',
    },
    schedule: {
      installment: '8630.39',
      administrativeFee: '3000.00',
      netDisbursement: '297000.00',
      totalInterest: '217823.42',
      totalRepayment: '517823.42',
    },
  });
  expect(snapshot.schedule.rows).toHaveLength(60);
  expect(snapshot.schedule.rows.at(-1)).toMatchObject({
    balance: '0.00',
    installment: '8630.41',
    dueDate: '2030-04-03',
  });
  const pages = await extractOfferPdf(pdf.body);
  expect(pages.length).toBeGreaterThanOrEqual(2);
  const text = pages.join(' ');
  for (const value of [
    '300,000.00',
    '8,630.39',
    '8,630.41',
    '297,000.00',
    'PS-5',
    '2030-04-03',
    snapshot.approval.id,
    owner.id,
    senior.id,
  ]) {
    expect(text).toContain(value);
  }
  expect(text).toMatch(/demo/i);
  expect(text).not.toContain('Policy and evidence reviewed for synthetic demo');
  await request(app.getHttpServer())
    .get(`/api/v1/offers/${offers[0]!.id}`)
    .set('Cookie', other.cookie)
    .expect(403);
  await post(`applications/${id}/assessments`, owner).send({ mode: 'demo' }).expect(409);
  // A pre-P16 offer can reuse its immutable assessment and audit records.
  await db.query("UPDATE cases.offers SET data=data-'document' WHERE id=$1", [offerId]);
  await readStream(downloadPath, owner).expect(200);
  await db.query(
    "UPDATE cases.audit_events SET details=details-'offerId' WHERE run_id=$1 AND event='OFFER_ISSUED'",
    [runId],
  );
  await readStream(`offers/${offerId}`, owner)
    .expect(200)
    .expect(({ body }) => expect(body.documentAvailable).toBe(false));
  await readStream(downloadPath, owner)
    .expect(409)
    .expect(({ body }) => expect(body.error.code).toBe('OfferDocumentUnavailable'));
  // Deny even a known offer id when its run is outside the issued lifecycle.
  await db.query('UPDATE cases.assessment_runs SET status=$2 WHERE id=$1', [runId, 'rejected']);
  await readStream(downloadPath, owner).expect(404);
});

it('evaluates all three auto packs and records product-scoped human decisions', async () => {
  const suite = JSON.parse(await readFile('data/evaluation/auto-loan-cases.json', 'utf8')) as {
    assessments: {
      fixture: string;
      mode: string;
      expected: { recommendation: string; [field: string]: unknown };
      downPaymentRule?: { rule: string; result: string; citation: string };
    }[];
  };
  const owner = await account();
  const reviewer = await account('senior');
  const strictId = await select(owner, 'AUTO-001');
  const strict = await post(`applications/${strictId}/assessments`, owner).send({}).expect(201);
  expect(strict.body.result).toMatchObject({
    mode: 'strict',
    productId: 'AL-200',
    policyEdition: 'AUTO-2025',
    recommendation: 'REFER_TO_HUMAN',
    evidence: { missing: ['national_id_copy'] },
  });
  for (const scenario of suite.assessments) {
    provider.texts = [];
    const applicationId = await select(owner, scenario.fixture);
    const response = await post(`applications/${applicationId}/assessments`, owner)
      .send({ mode: scenario.mode })
      .expect(201);
    const { runId, result } = response.body;
    expect(result).toMatchObject(scenario.expected);
    if (scenario.downPaymentRule) {
      expect(result.results).toEqual(
        expect.arrayContaining([expect.objectContaining(scenario.downPaymentRule)]),
      );
    } else {
      expect(provider.texts).toHaveLength(0);
    }
    const stored = await readStream(`assessments/${runId}`, owner).expect(200);
    expect(stored.body.result).toMatchObject(scenario.expected);
    if (result.recommendation === 'APPROVE') {
      await post(`assessments/${runId}/decisions`, reviewer)
        .send({
          action: 'approve',
          expectedVersion: 1,
          comment: 'Reviewed verified auto affordability and quotation.',
        })
        .expect(201);
      await post(`assessments/${runId}/decisions`, reviewer)
        .send({
          action: 'issue',
          expectedVersion: 2,
          comment: 'Issue after human approval.',
          disbursementDate: '2025-04-03',
        })
        .expect(201);
      expect(await db.query('SELECT data FROM cases.offers WHERE run_id=$1', [runId])).toEqual([
        {
          data: expect.objectContaining({
            productId: 'AL-200',
            policyEdition: 'AUTO-2025',
            fullyEvidenceVerified: false,
            amount: '250000.00',
            document: expect.objectContaining({
              principal: '250000.00',
              pricing: expect.objectContaining({
                sourceFile: 'synthetic-auto-pricing.csv',
                row: 3,
              }),
              schedule: expect.objectContaining({
                installment: '6623.47',
                administrativeFee: '2500.00',
                netDisbursement: '247500.00',
              }),
              conditions: expect.arrayContaining([
                expect.objectContaining({
                  sourceFile: 'synthetic-auto-product.md',
                  clause: 'PS-9',
                }),
              ]),
            }),
          }),
        },
      ]);
    } else if (result.recommendation === 'DECLINE') {
      await post(`assessments/${runId}/decisions`, reviewer)
        .send({
          action: 'reject',
          expectedVersion: 1,
          comment: 'Verified down payment below the product minimum.',
          clause: 'PS-9',
        })
        .expect(201);
      expect(
        await db.query(
          'SELECT clause, source_file, policy_edition FROM cases.rejection_notices WHERE run_id=$1',
          [runId],
        ),
      ).toEqual([
        { clause: 'PS-9', source_file: 'synthetic-auto-product.md', policy_edition: 'AUTO-2025' },
      ]);
    }
  }
});

it('isolates dated auto and personal sources through retrieval and policy Q&A', async () => {
  const { retrieval } = JSON.parse(await readFile('data/evaluation/auto-loan-cases.json', 'utf8'));
  const question = retrieval.question as string;
  const date = retrieval.asOfDate as string;
  for (const strategy of ['vector', 'hybrid'] as const) {
    const search = new RetrievalService(db, provider, strategy);
    const [auto, personal, preEffective] = await Promise.all([
      search.search(question, date, 'AL-200'),
      search.search(question, date, 'PL-100'),
      search.search(question, '2025-02-28', 'AL-200'),
    ]);
    expect(auto.length).toBeGreaterThan(0);
    expect(personal.length).toBeGreaterThan(0);
    expect(auto.every(({ chunk }) => chunk.product === 'AL-200')).toBe(true);
    expect(personal.every(({ chunk }) => chunk.product === 'PL-100')).toBe(true);
    expect(preEffective).toHaveLength(0);
  }
  const owner = await account();
  const answer = await post('questions', owner)
    .send({ product: 'AL-200', edition: 'AUTO-2025', question, asOfDate: date })
    .expect(201);
  expect(answer.body.refused).toBe(false);
  expect(answer.body.citations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        documentId: retrieval.auto.documentId,
        section: retrieval.auto.section,
      }),
    ]),
  );
  expect(
    answer.body.citations.every(({ sourceFile }: { sourceFile: string }) =>
      sourceFile.startsWith('synthetic-auto-'),
    ),
  ).toBe(true);
  await post('questions', owner)
    .send({ product: 'PL-100', edition: 'AUTO-2025', question })
    .expect(422);
  await post('questions', owner)
    .send({ product: 'AL-200', edition: 'CP-2025', question })
    .expect(422);
});
it('prevents concurrent assessment jobs and persists fraud referral without provider calls', async () => {
  const s = await account(),
    id = await select(s);
  const previous = await post(`applications/${id}/assessments`, s)
    .send({ mode: 'demo' })
    .expect(201);
  const senior = await account('senior');
  let release!: () => void;
  provider.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    provider.onGeneration = resolve;
  });
  const first = post(`applications/${id}/assessments`, s)
    .set('Idempotency-Key', 'first')
    .send({ mode: 'demo' })
    .then((response) => response);
  try {
    await started;
    await post(`applications/${id}/assessments`, s)
      .set('Idempotency-Key', 'second')
      .send({ mode: 'demo' })
      .expect(409);
    await post(`assessments/${previous.body.runId}/decisions`, senior)
      .send({ action: 'approve', expectedVersion: 1, comment: 'Review during reassessment' })
      .expect(409);
  } finally {
    release();
    provider.gate = undefined;
    provider.onGeneration = undefined;
  }
  expect((await first).status).toBe(201);
  const queue = await request(app.getHttpServer())
    .get('/api/v1/reviews')
    .set('Cookie', senior.cookie)
    .expect(200);
  expect(queue.body.some((run: { id: string }) => run.id === previous.body.runId)).toBe(false);
  provider.texts = [];
  const fraudId = await select(s, 'APP-004');
  const fraud = await post(`applications/${fraudId}/assessments`, s)
    .send({ mode: 'demo' })
    .expect(201);
  expect(fraud.body.result.fraudReferral).toBe(true);
  expect(provider.texts).toHaveLength(0);
});
it('protects questions/calculations and masks identifiers before embedding or generation', async () => {
  const s = await account();
  const preflight = await request(app.getHttpServer())
    .options('/api/v1/applications')
    .set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'idempotency-key,x-csrf-token')
    .expect(204);
  expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain(
    'idempotency-key',
  );
  await request(app.getHttpServer())
    .post('/api/v1/questions')
    .send({ question: 'DBR?' })
    .expect(401);
  const answer = await post('questions', s)
    .send({
      question: 'maximum debt burden ratio for 28704121234567 phone 010-0000-0001',
      asOfDate: '2025-04-03',
    })
    .expect(201);
  expect(answer.body.citations.length).toBeGreaterThan(0);
  expect(provider.texts.join(' ')).not.toContain('28704121234567');
  expect(provider.texts.join(' ')).not.toContain('010-0000-0001');
  const refusal = await post('questions', s)
    .send({ question: 'crypto policy?', asOfDate: '2025-04-03' })
    .expect(201);
  expect(refusal.body.refused).toBe(true);
  const historical = await post('questions', s)
    .send({ question: 'Maximum DBR in CP-2024?' })
    .expect(201);
  expect(historical.body.asOfDate).toBe('2024-01-01');
  await post('questions', s)
    .send({ question: 'CP-2024 maximum DBR?', asOfDate: '2025-04-03' })
    .expect(422);
  const calculation = await post('calculations', s)
    .send({
      principal: '300000',
      income: '30000',
      obligations: '4000',
      months: 60,
      date: '2025-04-03',
    })
    .expect(201);
  expect(calculation.body.calculation.maximumEligibleAmount).toBe('330000.00');
});

it('recovers an abandoned job and prevents its late result from superseding the new run', async () => {
  const s = await account(),
    id = await select(s),
    oldRun = randomUUID();
  await db.query(
    "INSERT INTO cases.assessment_jobs(run_id,application_id,request_key,mode,status,created_at) VALUES($1,$2,'abandoned','demo','running',now()-interval '16 minutes')",
    [oldRun, id],
  );
  const interrupted = await readStream(`assessment-streams/${oldRun}`, s).expect(200);
  expect(readFrames(interrupted.text)).toEqual([
    { id: 9, data: { kind: 'failed', code: 'AssessmentFailed' } },
  ]);
  expect(
    await db.query('SELECT status FROM cases.assessment_jobs WHERE run_id=$1', [oldRun]),
  ).toEqual([{ status: 'running' }]);
  const response = await post(`applications/${id}/assessments`, s)
    .set('Idempotency-Key', 'recovered')
    .send({ mode: 'demo' })
    .expect(201);
  expect(
    await db.query('SELECT status FROM cases.assessment_jobs WHERE run_id=$1', [oldRun]),
  ).toEqual([{ status: 'failed' }]);
  await expect(
    new PostgresAssessmentRepository(db).save({
      id: oldRun,
      applicationId: id,
      actorId: s.id,
      requestId: 'late',
      at: new Date().toISOString(),
      result: response.body.result as AssessmentResult,
    }),
  ).rejects.toThrow('no longer active');
  expect(
    await db.query('SELECT latest_assessment_id FROM cases.applications WHERE id=$1', [id]),
  ).toEqual([{ latest_assessment_id: response.body.runId }]);
});

it('persists fallback usage and audit data from a sanitized authenticated assessment', async () => {
  const owner = await account();
  const application = await select(owner);
  primaryUnavailable = true;
  const response = await post('applications/' + application + '/assessments', owner)
    .set('Idempotency-Key', randomUUID())
    .send({ mode: 'demo' })
    .expect(201);
  expect(response.body.result).toMatchObject({
    status: 'pending_approval',
    recommendation: 'APPROVE',
    calculation: { monthlyInstallment: '8630.39' },
    usageRecords: [
      { model: 'gemini-test', inputTokens: null, outputTokens: null },
      { model: 'ollama:test-local', fallbackFrom: 'gemini-test', inputTokens: 12, outputTokens: 8 },
    ],
  });
  expect(localProvider.texts).toHaveLength(1);
  expect(Object.keys(JSON.parse(localProvider.texts[0]!)).sort()).toEqual(['evidence', 'source']);
  expect(localProvider.texts[0]).not.toMatch(/gender|religion|marital|nationality|28704121234567/i);
  expect(
    await db.query(
      "SELECT details FROM cases.audit_events WHERE run_id=$1 AND event='LLM_GENERATION_FALLBACK'",
      [response.body.runId],
    ),
  ).toEqual([{ details: { from: 'gemini-test', to: 'ollama:test-local' } }]);
  expect(
    await db.query(
      'SELECT model,input_tokens,output_tokens FROM cases.llm_usage WHERE run_id=$1 ORDER BY model',
      [response.body.runId],
    ),
  ).toEqual([
    { model: 'gemini-test', input_tokens: null, output_tokens: null },
    { model: 'ollama:test-local', input_tokens: 12, output_tokens: 8 },
  ]);

  const qa = await post('questions', owner)
    .send({
      question: 'maximum debt burden ratio for 28704121234567',
      asOfDate: '2025-04-03',
    })
    .expect(201);
  expect(qa.body).toMatchObject({
    refused: false,
    generation: { model: 'ollama:test-local', fallbackFrom: 'gemini-test' },
  });
  expect(localProvider.texts.at(-1)).toContain('[MASKED_ID]');
  expect(localProvider.texts.at(-1)).not.toContain('28704121234567');
});
