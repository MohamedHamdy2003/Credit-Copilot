/** Controlled synthetic age-failure fixture for browser tests, never part of production ingestion. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DataSource } from 'typeorm';
import type { Actor } from '../../packages/domain/src/access.js';
import type { Policy, Product } from '../../packages/domain/src/policy.js';
import { selectPolicy, selectPricing } from '../../packages/domain/src/policy.js';
import { assessRules } from '../../packages/domain/src/rules.js';
import { evaluateEvidence } from '../../packages/domain/src/evidence-mode.js';
import { ParserRegistry } from '../../packages/infrastructure/src/parsers/registry.js';
import { extractPricing } from '../../packages/infrastructure/src/parsers/pricing.js';
import { PostgresAssessmentRepository } from '../../packages/infrastructure/src/db/assessment-repository.js';
import { PostgresDecisionStore } from '../../packages/infrastructure/src/db/decision-store.js';
export async function seedRejection(db: DataSource, policies: Policy[]) {
  const owner = (await db.query("SELECT id FROM cases.users WHERE username='e2e-reasons'"))[0] as {
    id: string;
  };
  const head = (
    await db.query(
      'SELECT id,username,role,tier,can_ingest AS "canIngest" FROM cases.users WHERE username=\'e2e-head\'',
    )
  )[0] as Actor;
  const parser = new ParserRegistry();
  const content = [
    'Application reference TEST-DECLINE',
    'Application date 3 April 2025',
    'Date of birth 1 January 1960',
    'Requested amount EGP 300,000.00',
    'Requested tenor 60 months',
    'Salary transferred to Delta No',
  ].join('\n\n');
  const doc = await parser.extract('controlled-age-test.md', Buffer.from(content));
  const product = JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')) as Product;
  const pricing = extractPricing(
    await parser.extract(
      'pricing-table.csv',
      await readFile('data/corpus/policy/pricing-table.csv'),
    ),
  );
  const policy = selectPolicy(policies, '2025-04-03');
  const result = assessRules(
    {
      applicationDate: '2025-04-03',
      birthDate: '1960-01-01',
      employmentStart: '2019-09-01',
      certificateDate: '2025-03-31',
      income: '30000',
      obligations: '4000',
      bureauScore: 712,
      confirmed: true,
      hasDefault: false,
      bankEmployee: false,
      purposeAllowed: true,
      amount: '300000',
      months: 60,
      plannedDisbursement: '2025-04-03',
    },
    policy,
    product,
    selectPricing(pricing, '2025-04-03', 60, false),
  );
  const applicationId = randomUUID(),
    runId = randomUUID(),
    at = new Date().toISOString();
  await db.query(
    'INSERT INTO cases.applications(id,reference,preparer_id,filename,hash,normalized,synthetic) VALUES($1,$2,$3,$4,$5,$6,true)',
    [applicationId, 'TEST-DECLINE', owner.id, doc.filename, doc.hash, doc],
  );
  await db.query(
    'INSERT INTO cases.evidence_documents(id,application_id,requirement,original_bytes,hash) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), applicationId, 'application_pack', Buffer.from(content), doc.hash],
  );
  await new PostgresAssessmentRepository(db).save({
    id: runId,
    applicationId,
    actorId: owner.id,
    requestId: 'e2e-seed',
    at,
    result: {
      ...result,
      reference: 'TEST-DECLINE',
      mode: 'demo',
      policyEdition: policy.edition,
      maxDbr: policy.maxDbr,
      evidence: evaluateEvidence(
        [{ requirement: 'national_id_copy', present: false, verified: false }],
        'demo',
        owner.id,
        at,
      ),
      status: 'pending_review',
      removedFields: [],
      steps: [],
      fraudReferral: false,
      memo: 'Controlled test-only synthetic age failure; no ID supplied or verified.',
    },
  });
  await new PostgresDecisionStore(db, policies).execute(
    head,
    runId,
    {
      action: 'reject',
      expectedVersion: 1,
      clause: 'CP-3.5',
      comment: 'Controlled test: final maturity exceeds the maximum age under CP-3.5.',
    },
    'e2e-seed',
  );
}
