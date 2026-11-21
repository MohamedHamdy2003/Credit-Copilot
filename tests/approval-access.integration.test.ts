import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createApi } from '../apps/api/src/app.js';
import { createDataSource } from '../packages/infrastructure/src/db/data-source.js';
import { PostgresAuthStore } from '../packages/infrastructure/src/auth/store.js';
import { ScryptCredentials } from '../packages/infrastructure/src/auth/passwords.js';
import { PostgresDecisionStore } from '../packages/infrastructure/src/db/decision-store.js';
import { AuthService } from '../packages/application/src/auth.js';
import { DecisionService } from '../packages/application/src/decisions.js';
import { createCaseReviews } from '../packages/infrastructure/src/db/case-review-store.js';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { evaluateEvidence } from '../packages/domain/src/evidence-mode.js';
import { affordability } from '../packages/domain/src/calculations.js';
import type { Actor } from '../packages/domain/src/access.js';
import type { Policy } from '../packages/domain/src/policy.js';
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://copilot:copilot_local@localhost:54329/credit_copilot_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
let db: DataSource, app: INestApplication, hash: string, policies: Policy[];
const password = `test-${randomUUID()}`;
const crypto = new ScryptCredentials();
beforeAll(async () => {
  db = await createDataSource(url).initialize();
  await db.runMigrations();
  hash = await crypto.hash(password);
  policies = JSON.parse(await readFile('data/config/policies.json', 'utf8'));
  app = await createApi({
    caseReviews: await createCaseReviews(db),
    auth: new AuthService(new PostgresAuthStore(db), crypto, 8),
    decisions: new DecisionService(new PostgresDecisionStore(db, policies)),
    webOrigin: 'http://localhost:5173',
    secureCookies: false,
    sessionHours: 8,
  });
  await app.init();
});
beforeEach(async () => {
  await db.query('DELETE FROM cases.login_attempts');
});
afterAll(async () => {
  await app?.close();
  if (db?.isInitialized) await db.destroy();
});
async function user(tier: Actor['tier'] = 'none') {
  const actor: Actor = {
    id: randomUUID(),
    username: randomUUID(),
    role: tier === 'none' ? 'loan_officer' : 'credit_officer',
    tier,
    canIngest: false,
  };
  await db.query(
    'INSERT INTO cases.users(id,username,password_hash,role,tier) VALUES($1,$2,$3,$4,$5)',
    [actor.id, actor.username, hash, actor.role, tier],
  );
  return actor;
}
async function login(actor: Actor) {
  const result = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username: actor.username, password })
    .expect(201);
  return {
    cookie: result.headers['set-cookie'] as unknown as string[],
    csrf: result.body.csrfToken as string,
  };
}
async function fixture(preparer: Actor, amount = '300000', alternative = false) {
  const id = randomUUID(),
    appId = randomUUID();
  const doc = await new ParserRegistry().extract(
    'APP-001.pdf',
    await readFile('data/corpus/evidence/APP-001.pdf'),
  );
  const result = {
    reference: 'APP-001',
    mode: 'demo',
    policyEdition: 'CP-2025',
    maxDbr: '0.45',
    evidence: evaluateEvidence(
      [{ requirement: 'national_id_copy', present: false, verified: false }],
      'demo',
      preparer.id,
      new Date().toISOString(),
    ),
    recommendation: alternative ? 'OFFER_ALTERNATIVE' : 'APPROVE',
    recommendedAmount: amount,
    calculation: affordability({
      principal: alternative ? '300000' : amount,
      income: '30000',
      obligations: '4000',
      annualRatePercent: '24',
      months: 60,
      maxDbr: '0.45',
      productMaximum: '1000000',
    }),
    pricing: { annualRatePercent: '24.00', sourceFile: 'pricing-table.csv', row: 3 },
    steps: [],
    removedFields: [],
    fraudReferral: false,
  };
  await db.query(
    'INSERT INTO cases.applications(id,reference,preparer_id,filename,hash,normalized,synthetic) VALUES($1,$2,$3,$4,$5,$6,true)',
    [appId, 'APP-001', preparer.id, doc.filename, doc.hash, doc],
  );
  await db.query(
    'INSERT INTO cases.assessment_runs(id,application_id,mode,recommendation,status,result) VALUES($1,$2,$3,$4,$5,$6)',
    [
      id,
      appId,
      'demo',
      result.recommendation,
      alternative ? 'pending_customer_acceptance' : 'pending_approval',
      result,
    ],
  );
  return id;
}
const post = (
  id: string,
  session: { cookie: string[]; csrf: string },
  body: Record<string, unknown>,
) =>
  request(app.getHttpServer())
    .post(`/api/v1/assessments/${id}/decisions`)
    .set('Cookie', session.cookie)
    .set('x-csrf-token', session.csrf)
    .send(body);
it('stores only session hashes, logs out, and rejects missing CSRF or injected roles', async () => {
  const actor = await user();
  const session = await login(actor);
  await request(app.getHttpServer())
    .get('/api/v1/auth/me')
    .set('Cookie', session.cookie)
    .expect(200);
  const rows = (await db.query('SELECT token_hash FROM cases.sessions WHERE user_id=$1', [
    actor.id,
  ])) as { token_hash: string }[];
  expect(session.cookie[0]).not.toContain(rows[0]!.token_hash);
  await request(app.getHttpServer())
    .post('/api/v1/auth/logout')
    .set('Cookie', session.cookie)
    .expect(403);
  await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username: actor.username, password, role: 'credit_officer' })
    .expect(422);
  await request(app.getHttpServer())
    .post('/api/v1/auth/logout')
    .set('Cookie', session.cookie)
    .set('x-csrf-token', session.csrf)
    .expect(201);
  await request(app.getHttpServer())
    .get('/api/v1/auth/me')
    .set('Cookie', session.cookie)
    .expect(401);
});
it('checks ownership and permissions on direct API access', async () => {
  const owner = await user(),
    other = await user();
  const id = await fixture(owner);
  const session = await login(other);
  await request(app.getHttpServer())
    .get(`/api/v1/assessments/${id}`)
    .set('Cookie', session.cookie)
    .expect(403);
  await request(app.getHttpServer())
    .get('/api/v1/reviews')
    .set('Cookie', session.cookie)
    .expect(403);
  await post(id, session, { action: 'approve', expectedVersion: 1, comment: 'Reviewed' }).expect(
    403,
  );
  await request(app.getHttpServer()).get('/api/v1/reviews').expect(401);
});
it('enforces recommended amount authority and human approval before unique issuance', async () => {
  const preparer = await user();
  const id = await fixture(preparer);
  const credit = await login(await user('credit')),
    senior = await login(await user('senior'));
  await post(id, credit, { action: 'approve', expectedVersion: 1, comment: 'Reviewed' }).expect(
    403,
  );
  await post(id, senior, {
    action: 'issue',
    expectedVersion: 1,
    comment: 'Issue',
    disbursementDate: '2025-04-03',
  }).expect(409);
  await post(id, senior, {
    action: 'approve',
    expectedVersion: 1,
    comment: 'Policy and calculations checked',
  }).expect(201);
  await post(id, senior, { action: 'approve', expectedVersion: 1, comment: 'Duplicate' }).expect(
    409,
  );
  await post(id, senior, {
    action: 'issue',
    expectedVersion: 2,
    comment: 'Approval verified',
    disbursementDate: '2025-04-03',
  }).expect(201);
  await post(id, senior, {
    action: 'issue',
    expectedVersion: 3,
    comment: 'Duplicate',
    disbursementDate: '2025-04-03',
  }).expect(409);
  expect(
    await db.query('SELECT count(*)::int AS n FROM cases.offers WHERE run_id=$1', [id]),
  ).toEqual([{ n: 1 }]);
});
it('blocks self approval and accepts exact authority boundary', async () => {
  const credit = await user('credit');
  const selfId = await fixture(credit, '250000'),
    self = await login(credit);
  await post(selfId, self, { action: 'approve', expectedVersion: 1, comment: 'Self' }).expect(403);
  const id = await fixture(await user(), '250000');
  await post(id, self, {
    action: 'approve',
    expectedVersion: 1,
    comment: 'Boundary verified',
  }).expect(201);
});
it('keeps an assessment approved without issuing if its recorded pricing row is inconsistent', async () => {
  const id = await fixture(await user());
  const reviewer = await login(await user('senior'));
  await post(id, reviewer, { action: 'approve', expectedVersion: 1, comment: 'Reviewed' }).expect(
    201,
  );
  await db.query(
    "UPDATE cases.assessment_runs SET result=jsonb_set(result,'{pricing,row}','4') WHERE id=$1",
    [id],
  );
  await post(id, reviewer, {
    action: 'issue',
    expectedVersion: 2,
    comment: 'Issue request',
    disbursementDate: '2025-04-03',
  })
    .expect(409)
    .expect(({ body }) => expect(body.error.code).toBe('OfferDocumentUnavailable'));
  expect(
    await db.query('SELECT status,version FROM cases.assessment_runs WHERE id=$1', [id]),
  ).toEqual([{ status: 'approved', version: 2 }]);
  expect(await db.query('SELECT id FROM cases.offers WHERE run_id=$1', [id])).toHaveLength(0);
});
it('serializes concurrent approvals so only one decision commits', async () => {
  const id = await fixture(await user(), '200000'),
    session = await login(await user('credit'));
  const responses = await Promise.all([
    post(id, session, { action: 'approve', expectedVersion: 1, comment: 'First' }),
    post(id, session, { action: 'approve', expectedVersion: 1, comment: 'Second' }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
});
it('requires recorded customer acceptance before approving an alternative', async () => {
  const preparer = await user(),
    id = await fixture(preparer, '200000', true);
  const loan = await login(preparer),
    credit = await login(await user('credit'));
  await post(id, credit, { action: 'approve', expectedVersion: 1, comment: 'Premature' }).expect(
    409,
  );
  await post(id, loan, {
    action: 'customer_response',
    expectedVersion: 1,
    accepted: true,
    comment: 'Customer accepted',
  }).expect(201);
  await post(id, credit, {
    action: 'approve',
    expectedVersion: 2,
    comment: 'Accepted amount reviewed',
  }).expect(201);
  await post(id, credit, {
    action: 'issue',
    expectedVersion: 3,
    comment: 'Issue the approved alternative',
    disbursementDate: '2025-04-03',
  }).expect(201);
  const [offer] = await db.query('SELECT data FROM cases.offers WHERE run_id=$1', [id]);
  expect(offer.data.document).toMatchObject({
    principal: '200000.00',
    schedule: {
      installment: '5753.59',
      administrativeFee: '2000.00',
      netDisbursement: '198000.00',
    },
  });
});
it('rejects expired sessions, hostile origins and repeated login attempts', async () => {
  const actor = await user(),
    session = await login(actor);
  await db.query(
    "UPDATE cases.sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",
    [actor.id],
  );
  await request(app.getHttpServer())
    .get('/api/v1/auth/me')
    .set('Cookie', session.cookie)
    .expect(401);
  await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', 'https://other.invalid')
    .send({ username: actor.username, password })
    .expect(403);
  for (let i = 0; i < 9; i++)
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: actor.username, password: 'wrong' })
      .expect(401);
  await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username: actor.username, password: 'wrong' })
    .expect(429);
});

it('revokes access immediately when a user is disabled and rejects malformed JSON', async () => {
  const actor = await user();
  const session = await login(actor);
  await db.query('UPDATE cases.users SET active=false WHERE id=$1', [actor.id]);
  await request(app.getHttpServer())
    .get('/api/v1/auth/me')
    .set('Cookie', session.cookie)
    .expect(401);
  await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username: actor.username, password })
    .expect(401);
  await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Content-Type', 'application/json')
    .send('{broken')
    .expect(400);
});
it('requires clause-specific rejection and disallows issuing rejected cases', async () => {
  const id = await fixture(await user(), '200000'),
    credit = await login(await user('credit'));
  await db.query(
    "UPDATE cases.assessment_runs SET recommendation='DECLINE',result=jsonb_set(jsonb_set(result,'{recommendation}','\"DECLINE\"'),'{results}',$2::jsonb) WHERE id=$1",
    [
      id,
      JSON.stringify([
        {
          rule: 'CP-3.5',
          result: 'fail',
          citation: 'CP-2025 CP-3.5',
          reason: 'Age at maturity exceeds limit',
        },
      ]),
    ],
  );
  await post(id, credit, {
    action: 'reject',
    expectedVersion: 1,
    comment: 'Generic',
    clause: 'CP-99',
  }).expect(422);
  await post(id, credit, {
    action: 'reject',
    expectedVersion: 1,
    comment: 'Age at maturity exceeds the policy maximum',
    clause: 'CP-3.5',
  }).expect(201);
  await post(id, credit, {
    action: 'issue',
    expectedVersion: 2,
    comment: 'Issue',
    disbursementDate: '2025-04-03',
  }).expect(409);
});
it('blocks stale assessments and leaves unresolved referrals with senior review', async () => {
  const preparer = await user(),
    id = await fixture(preparer),
    senior = await login(await user('senior'));
  const rows = (await db.query('SELECT application_id FROM cases.assessment_runs WHERE id=$1', [
    id,
  ])) as { application_id: string }[];
  const newer = randomUUID();
  await db.query(
    'INSERT INTO cases.assessment_runs(id,application_id,mode,recommendation,status,result) SELECT $2,application_id,mode,recommendation,status,result FROM cases.assessment_runs WHERE id=$1',
    [id, newer],
  );
  await db.query('UPDATE cases.applications SET latest_assessment_id=$2 WHERE id=$1', [
    rows[0]!.application_id,
    newer,
  ]);
  await post(id, senior, { action: 'approve', expectedVersion: 1, comment: 'Old review' }).expect(
    409,
  );
  await db.query(
    "UPDATE cases.assessment_runs SET result=jsonb_set(result,'{recommendedAmount}','null'::jsonb),recommendation='REFER_TO_HUMAN',status='pending_review' WHERE id=$1",
    [newer],
  );
  await post(newer, senior, {
    action: 'approve',
    expectedVersion: 1,
    comment: 'Cannot waive missing evidence',
  }).expect(409);
});
async function rejection(owner: Actor) {
  const id = await fixture(owner, '200000');
  await db.query(
    "UPDATE cases.assessment_runs SET recommendation='DECLINE', result=result || $2::jsonb WHERE id=$1",
    [
      id,
      JSON.stringify({
        recommendation: 'DECLINE',
        results: [
          {
            rule: 'CP-3.5',
            result: 'fail',
            citation: 'CP-2025 CP-3.5',
            reason: 'Age exceeds maturity limit',
          },
        ],
      }),
    ],
  );
  const senior = await login(await user('senior'));
  await post(id, senior, {
    action: 'reject',
    expectedVersion: 1,
    clause: 'CP-3.5',
    comment: 'Age at maturity exceeds the recorded maximum.',
  }).expect(201);
  return id;
}
const reviewPost = (
  path: string,
  session: { cookie: string[]; csrf: string },
  body: Record<string, unknown>,
) =>
  request(app.getHttpServer())
    .post(`/api/v1/${path}`)
    .set('Cookie', session.cookie)
    .set('x-csrf-token', session.csrf)
    .send(body);
it('provides an immutable PM-9 written reply once under concurrent requests and preserves the decision', async () => {
  const owner = await user(),
    id = await rejection(owner),
    s = await login(owner),
    other = await login(await user());
  await request(app.getHttpServer()).get(`/api/v1/assessments/${id}/written-reason`).expect(401);
  await request(app.getHttpServer())
    .get(`/api/v1/assessments/${id}/written-reason`)
    .set('Cookie', other.cookie)
    .expect(403);
  await reviewPost(`assessments/${id}/reason-requests`, other, {}).expect(403);
  await reviewPost(`assessments/${id}/reason-requests`, s, {
    date: '2025-01-01',
    message: 'request',
  }).expect(422);
  await request(app.getHttpServer())
    .post(`/api/v1/assessments/${id}/reason-requests`)
    .set('Cookie', s.cookie)
    .send({})
    .expect(403);
  const replies = await Promise.all([
    reviewPost(`assessments/${id}/reason-requests`, s, {
      message: 'Please provide the reason in writing.',
    }),
    reviewPost(`assessments/${id}/reason-requests`, s, {}),
  ]);
  expect(replies.map((r) => r.status)).toEqual([201, 201]);
  expect(replies[0]!.body.id).toBe(replies[1]!.body.id);
  expect(replies[0]!.body.reply).toMatchObject({
    clause: 'CP-3.5',
    policyEdition: 'CP-2025',
    sourceFile: 'credit-policy-2025.pdf',
    mode: 'demo',
    fullyEvidenceVerified: false,
  });
  expect(
    await db.query('SELECT status,version FROM cases.assessment_runs WHERE id=$1', [id]),
  ).toEqual([{ status: 'rejected', version: 2 }]);
  expect(
    await db.query(
      "SELECT event FROM cases.audit_events WHERE run_id=$1 AND event LIKE 'WRITTEN_REASON_%' ORDER BY event",
      [id],
    ),
  ).toEqual([{ event: 'WRITTEN_REASON_PROVIDED' }, { event: 'WRITTEN_REASON_REQUESTED' }]);
  await db.query(
    "UPDATE cases.rejection_notices SET decided_at=now()-interval '40 days' WHERE run_id=$1",
    [id],
  );
  const replay = await reviewPost(`assessments/${id}/reason-requests`, s, {}).expect(201);
  expect(replay.body.reply).toEqual(replies[0]!.body.reply);
});
it('enforces the thirty-day Cairo calendar boundary and rejects future or late first requests', async () => {
  for (const [days, expected] of [
    [30, 201],
    [31, 409],
    [-1, 409],
  ] as const) {
    const owner = await user(),
      id = await rejection(owner),
      s = await login(owner);
    await db.query(
      "UPDATE cases.rejection_notices SET decided_at=(((now() AT TIME ZONE 'Africa/Cairo')::date-$2::int)::timestamp AT TIME ZONE 'Africa/Cairo') WHERE run_id=$1",
      [id, days],
    );
    const result = await reviewPost(`assessments/${id}/reason-requests`, s, {}).expect(expected);
    if (expected === 409) expect(result.body.error.code).toBe('ReasonRequestWindowClosed');
    await db.query('DELETE FROM cases.login_attempts');
  }
});
it('routes referrals to Senior, records internal fraud review and never changes eligibility', async () => {
  const owner = await user(),
    id = await fixture(owner),
    senior = await login(await user('senior')),
    credit = await login(await user('credit'));
  await db.query(
    "UPDATE cases.assessment_runs SET recommendation='REFER_TO_HUMAN',status='pending_review',result=result || $2::jsonb WHERE id=$1",
    [
      id,
      JSON.stringify({
        recommendation: 'REFER_TO_HUMAN',
        fraudReferral: true,
        reason: 'SUSPECTED_TAMPERING',
      }),
    ],
  );
  await request(app.getHttpServer())
    .get('/api/v1/referrals')
    .set('Cookie', credit.cookie)
    .expect(403);
  const standard = await request(app.getHttpServer())
    .get('/api/v1/reviews')
    .set('Cookie', credit.cookie)
    .expect(200);
  expect(standard.body.some((r: { id: string }) => r.id === id)).toBe(false);
  const queue = await request(app.getHttpServer())
    .get('/api/v1/referrals')
    .set('Cookie', senior.cookie)
    .expect(200);
  expect(queue.body.find((r: { id: string }) => r.id === id)).toMatchObject({
    assignedTier: 'senior',
    destination: 'Fraud Unit (internal record)',
    fraud: true,
  });
  await reviewPost(`referrals/${id}/reviews`, credit, {
    expectedVersion: 1,
    action: 'fraud_recorded',
    comment: 'Review',
  }).expect(403);
  await reviewPost(`referrals/${id}/reviews`, senior, {
    expectedVersion: 9,
    action: 'fraud_recorded',
    comment: 'Review',
  }).expect(409);
  await reviewPost(`referrals/${id}/reviews`, senior, {
    expectedVersion: 1,
    action: 'approve',
    comment: 'Bypass',
  }).expect(422);
  await reviewPost(`referrals/${id}/reviews`, senior, {
    expectedVersion: 1,
    action: 'fraud_recorded',
    comment: 'Internal Fraud Unit record acknowledged; request fresh evidence.',
  }).expect(201);
  expect(
    await db.query('SELECT status,version FROM cases.assessment_runs WHERE id=$1', [id]),
  ).toEqual([{ status: 'pending_review', version: 1 }]);
  const history = await request(app.getHttpServer())
    .get(`/api/v1/referrals/${id}`)
    .set('Cookie', senior.cookie)
    .expect(200);
  expect(history.body.notes).toHaveLength(1);
  await post(id, senior, {
    action: 'reject',
    expectedVersion: 1,
    clause: 'CP-8',
    comment: 'Tampering is not a verified decline reason.',
  }).expect(409);
  await request(app.getHttpServer())
    .get(`/api/v1/assessments/${id}/written-reason`)
    .set('Cookie', senior.cookie)
    .expect(409);
});
it('prevents missing-evidence rejection and refuses reasons when no faithful legacy notice exists', async () => {
  const owner = await user('senior'),
    id = await fixture(owner),
    senior = await login(await user('senior')),
    self = await login(owner);
  await db.query(
    "UPDATE cases.assessment_runs SET recommendation='REFER_TO_HUMAN',status='pending_review',result=result || $2::jsonb WHERE id=$1",
    [
      id,
      JSON.stringify({
        recommendation: 'REFER_TO_HUMAN',
        evidence: {
          missing: ['national_id_copy'],
          referral: { citations: ['CP-8', 'PS-7'] },
          assumptions: [],
          fullyEvidenceVerified: false,
        },
      }),
    ],
  );
  await post(id, senior, {
    action: 'reject',
    expectedVersion: 1,
    clause: 'CP-8',
    comment: 'Missing ID should stay referred.',
  }).expect(409);
  await reviewPost(`referrals/${id}/reviews`, self, {
    expectedVersion: 1,
    action: 'awaiting_evidence',
    comment: 'Own review',
  }).expect(403);
  await reviewPost(`referrals/${id}/reviews`, senior, {
    expectedVersion: 1,
    action: 'fraud_recorded',
    comment: 'No fraud',
  }).expect(422);
  await db.query("UPDATE cases.assessment_runs SET status='rejected' WHERE id=$1", [id]);
  const unavailable = await request(app.getHttpServer())
    .get(`/api/v1/assessments/${id}/written-reason`)
    .set('Cookie', senior.cookie)
    .expect(409);
  expect(unavailable.body.error.code).toBe('ReasonUnavailable');
});
