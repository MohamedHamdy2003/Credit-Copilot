import { readFile } from 'node:fs/promises';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import {
  assessAndRecord,
  type AssessmentRecord,
} from '../packages/application/src/assessment-record.js';
import type {
  AssessmentInput,
  AssessmentDependencies,
} from '../packages/application/src/assessment.js';
import { FakeGeneration } from './helpers/fake-provider.js';
let input: AssessmentInput;
let dependencies: AssessmentDependencies;
beforeAll(async () => {
  input = {
    document: await new ParserRegistry().extract(
      'APP-004.pdf',
      await readFile('data/corpus/evidence/APP-004.pdf'),
    ),
    actorId: 'actor',
    at: '2026-11-17T12:00:00Z',
    synthetic: true,
    evidence: [],
    verifiedFacts: {
      certificateDate: '2025-04-15',
      confirmed: true,
      hasDefault: false,
      bankEmployee: false,
      purposeAllowed: true,
      plannedDisbursement: '2025-04-22',
    },
  };
  dependencies = {
    provider: new FakeGeneration({}),
    prompt: 'test',
    policies: JSON.parse(await readFile('data/config/policies.json', 'utf8')),
    product: JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')),
    pricing: [],
    settings: { allowDemo: true },
  };
});
it('records strict missing evidence and fraud flags without model invocation', async () => {
  const records: AssessmentRecord[] = [];
  const result = await assessAndRecord(
    input,
    dependencies,
    {
      save: async (record) => {
        records.push(record);
      },
    },
    { runId: 'run', applicationId: 'app', requestId: 'request' },
  );
  expect(result.recommendation).toBe('REFER_TO_HUMAN');
  expect(result.fraudReferral).toBe(true);
  expect(result.evidence.missing).toContain('national_id_copy');
  expect(records).toHaveLength(1);
  expect(records[0]?.requestId).toBe('request');
});
it('persists policy-not-found as an explicit referral', async () => {
  const records: AssessmentRecord[] = [];
  const result = await assessAndRecord(
    input,
    { ...dependencies, policies: [] },
    {
      save: async (record) => {
        records.push(record);
      },
    },
    { runId: 'run', applicationId: 'app', requestId: 'request' },
  );
  expect('reason' in result && result.reason).toBe('PolicyEditionNotFound');
  expect(records[0]?.result.policyEdition).toBeNull();
});
it('does not report success when persistence fails', async () => {
  await expect(
    assessAndRecord(
      input,
      dependencies,
      {
        save: async () => {
          throw new Error('database unavailable');
        },
      },
      { runId: 'run', applicationId: 'app', requestId: 'request' },
    ),
  ).rejects.toThrow('database unavailable');
});
