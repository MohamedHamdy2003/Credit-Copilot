import { readFile } from 'node:fs/promises';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import type { AssessmentRecord } from '../packages/application/src/assessment-record.js';
import type { DocumentAssessmentDependencies } from '../packages/application/src/document-assessment.js';
import { createDocumentAssessmentWorkflow } from '../packages/infrastructure/src/workflows/document-assessment.js';
import { FakeGeneration } from './helpers/fake-provider.js';

let app004: Awaited<ReturnType<ParserRegistry['extract']>>;
let app001: Awaited<ReturnType<ParserRegistry['extract']>>;
let dependencies: DocumentAssessmentDependencies;

beforeAll(async () => {
  const parser = new ParserRegistry();
  app004 = await parser.extract('APP-004.pdf', await readFile('data/corpus/evidence/APP-004.pdf'));
  app001 = await parser.extract('APP-001.pdf', await readFile('data/corpus/evidence/APP-001.pdf'));
  dependencies = {
    provider: new FakeGeneration({}),
    prompt: 'test',
    policies: JSON.parse(await readFile('data/config/policies.json', 'utf8')),
    product: JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')),
    pricing: [],
    settings: { allowDemo: true },
    clauses: { loadRequired: async () => [] },
    persistence: {
      runId: 'run',
      applicationId: 'app',
      requestId: 'request',
      repository: { save: async () => undefined },
    },
  };
});

it('records strict missing evidence and fraud flags without model invocation', async () => {
  const records: AssessmentRecord[] = [];
  const provider = new FakeGeneration({});
  const workflow = createDocumentAssessmentWorkflow({
    ...dependencies,
    provider,
    persistence: {
      ...dependencies.persistence,
      repository: {
        save: async (record) => {
          records.push(record);
        },
      },
    },
  });
  const outcome = await (
    await workflow.createRun()
  ).start({
    inputData: {
      document: app004,
      actorId: 'actor',
      at: '2026-11-17T12:00:00Z',
      synthetic: true,
    },
  });
  expect(outcome.status).toBe('success');
  if (outcome.status !== 'success') throw new Error('Workflow failed');
  const result = outcome.result.result!;
  expect(result.recommendation).toBe('REFER_TO_HUMAN');
  expect(result.fraudReferral).toBe(true);
  expect(result.evidence.missing).toContain('national_id_copy');
  expect(provider.calls).toHaveLength(0);
  expect(records).toHaveLength(1);
  expect(records[0]?.requestId).toBe('request');
});

it('persists policy-not-found as an explicit referral', async () => {
  const records: AssessmentRecord[] = [];
  const workflow = createDocumentAssessmentWorkflow({
    ...dependencies,
    policies: [],
    persistence: {
      ...dependencies.persistence,
      repository: {
        save: async (record) => {
          records.push(record);
        },
      },
    },
  });
  const outcome = await (
    await workflow.createRun()
  ).start({
    inputData: {
      document: app001,
      actorId: 'actor',
      at: '2026-11-17T12:00:00Z',
      synthetic: true,
    },
  });
  expect(outcome.status).toBe('success');
  if (outcome.status !== 'success') throw new Error('Workflow failed');
  expect(outcome.result.result?.reason).toBe('PolicyEditionNotFound');
  expect(records[0]?.result.policyEdition).toBeNull();
});

it('does not report success when persistence fails', async () => {
  const workflow = createDocumentAssessmentWorkflow({
    ...dependencies,
    persistence: {
      ...dependencies.persistence,
      repository: {
        save: async () => {
          throw new Error('database unavailable');
        },
      },
    },
  });
  const outcome = await (
    await workflow.createRun()
  ).start({
    inputData: {
      document: app004,
      actorId: 'actor',
      at: '2026-11-17T12:00:00Z',
      synthetic: true,
    },
  });
  expect(outcome.status).toBe('failed');
});
