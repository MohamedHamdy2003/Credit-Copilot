import { readFile } from 'node:fs/promises';
import { assessmentAgents } from '../packages/infrastructure/src/workflows/assessment-agents.js';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { chunkDocument } from '../packages/infrastructure/src/parsers/chunker.js';
import { extractPricing } from '../packages/infrastructure/src/parsers/pricing.js';
import { createDocumentAssessmentWorkflow } from '../packages/infrastructure/src/workflows/document-assessment.js';
import {
  ASSESSMENT_STAGES,
  documentAssessmentInputSchema,
  type DocumentAssessmentDependencies,
} from '../packages/application/src/document-assessment.js';
import { sanitizeEvidence } from '../packages/application/src/extraction.js';
import { deriveEvidenceFacts } from '../packages/application/src/evidence-facts.js';
import { DomainError } from '../packages/domain/src/errors.js';
import type { AssessmentRecord } from '../packages/application/src/assessment-record.js';
import { FakeGeneration } from './helpers/fake-provider.js';
import type { Completion, GenerationPort } from '../packages/application/src/ports.js';
import type { ManifestEntry } from '../packages/infrastructure/src/knowledge/ingestion.js';

const parser = new ParserRegistry();
let deps: DocumentAssessmentDependencies;
const records: AssessmentRecord[] = [];
// Fake model still has to return quotes that the production verifier accepts.
const provider: GenerationPort = {
  completeStructured: async (_system, data): Promise<Completion> => {
    const evidence = JSON.parse(data).evidence as ReturnType<typeof sanitizeEvidence>['lines'];
    const get = (label: string) => evidence.find((x) => x.text.startsWith(label))!;
    const money = (label: string) => {
      const e = get(label);
      return {
        value: e.text.slice(label.length).trim().replace(/,/g, ''),
        quote: e.text,
        section: e.section,
      };
    };
    const employment = get('Employment start');
    const dates: Record<string, string> = {
      '1 September 2019': '2019-09-01',
      '1 February 2021': '2021-02-01',
      '15 March 2005': '2005-03-15',
      '1 January 2023': '2023-01-01',
    };
    return {
      model: 'fake',
      usage: { inputTokens: 12, outputTokens: 8 },
      value: {
        income: money('Net monthly income'),
        obligations: money('Total monthly instalments'),
        bureauScore: { ...money('Bureau score'), value: Number(money('Bureau score').value) },
        employmentStart: {
          value: dates[employment.text.slice('Employment start '.length)],
          quote: employment.text,
          section: 'salary',
        },
      },
    };
  },
};
beforeAll(async () => {
  const manifest = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  ) as ManifestEntry[];
  const clauses = (
    await Promise.all(
      manifest
        .filter((entry) => ['CP-2025', 'C-2025-02', 'PS-PL-100'].includes(entry.id))
        .map(async (entry) =>
          chunkDocument(
            await parser.extract(
              entry.filename,
              await readFile(`data/corpus/policy/${entry.filename}`),
            ),
            entry,
          ),
        ),
    )
  ).flat();
  deps = {
    provider,
    prompt: await readFile('prompts/extraction.txt', 'utf8'),
    policies: JSON.parse(await readFile('data/config/policies.json', 'utf8')),
    product: JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')),
    pricing: extractPricing(
      await parser.extract(
        'pricing-table.csv',
        await readFile('data/corpus/policy/pricing-table.csv'),
      ),
    ),
    settings: { allowDemo: true },
    clauses: { loadRequired: async () => clauses },
    persistence: {
      runId: 'run',
      applicationId: 'application',
      requestId: 'request',
      repository: {
        save: async (r) => {
          records.push(structuredClone(r));
        },
      },
    },
  };
});
beforeEach(() => {
  records.length = 0;
});
const load = async (id: string) =>
  parser.extract(`${id}.pdf`, await readFile(`data/corpus/evidence/${id}.pdf`));
async function run(
  id: string,
  overrides: Partial<DocumentAssessmentDependencies> = {},
  strict = false,
) {
  const r = await (
    await createDocumentAssessmentWorkflow({ ...deps, ...overrides }).createRun()
  ).start({
    inputData: {
      document: await load(id),
      actorId: 'actor',
      at: '2026-11-19T12:00:00Z',
      synthetic: true,
      ...(strict ? {} : { requestedMode: 'demo' as const }),
    },
  });
  expect(r.status).toBe('success');
  if (r.status !== 'success') throw new Error('Workflow failed');
  return r.result;
}
it('runs eight actual stages, persists sources/usage and leaves an approvable case pending', async () => {
  const state = await run('APP-001');
  expect(state.steps).toEqual(ASSESSMENT_STAGES);
  expect(state.result?.recommendation).toBe('APPROVE');
  expect(state.result?.calculation?.monthlyInstallment).toBe('8630.39');
  expect(state.result?.retrievedChunkIds?.length).toBeGreaterThan(0);
  expect(state.clauses).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ documentId: 'C-2025-02', section: 'C-2' }),
      expect.objectContaining({ documentId: 'PS-PL-100', section: 'PS-3' }),
    ]),
  );
  expect(records).toHaveLength(1);
  expect(state.result?.usageRecords?.[0]?.inputTokens).toBe(12);
});
it('defaults all five original packs to strict referral because no ID copy exists', async () => {
  for (const id of ['APP-001', 'APP-002', 'APP-003', 'APP-004', 'APP-005'])
    expect((await run(id, {}, true)).result?.recommendation).toBe('REFER_TO_HUMAN');
});
it('assesses APP-002 (S1 alternative), APP-003 (over-age decline), and APP-005 (CP-6 referral) in Demo', async () => {
  const app002 = (await run('APP-002')).result!;
  expect(app002.recommendation).toBe('OFFER_ALTERNATIVE');
  expect(app002.recommendedAmount).toBe('330000.00');
  expect(app002.calculation).toMatchObject({
    monthlyInstallment: '10068.79',
    dbrPercent: '46.90',
    maximumEligibleAmount: '330000.00',
    passes: false,
  });
  expect(app002.results).toEqual(
    expect.arrayContaining([expect.objectContaining({ rule: 'CP-4.1', result: 'fail' })]),
  );

  const app003 = (await run('APP-003')).result!;
  expect(app003.recommendation).toBe('DECLINE');
  expect(app003.calculation).toBeNull();
  expect(app003.results).toEqual(
    expect.arrayContaining([expect.objectContaining({ rule: 'CP-3.5', result: 'fail' })]),
  );

  const app005 = (await run('APP-005')).result!;
  expect(app005.recommendation).toBe('REFER_TO_HUMAN');
  expect(app005.calculation).toBeNull();
  expect(app005.approvalRequiredFrom).toBe('senior_credit_officer');
  expect(app005.results).toEqual(
    expect.arrayContaining([expect.objectContaining({ rule: 'CP-6', result: 'refer' })]),
  );
});
it('records a fraud referral without calling the model for APP-004', async () => {
  const fake = new FakeGeneration({});
  const state = await run('APP-004', { provider: fake });
  expect(state.result?.fraudReferral).toBe(true);
  expect(fake.calls).toHaveLength(0);
  expect(records[0]?.result.reason).toBe('SuspectedTampering');
  expect(records[0]?.result.policyEdition).toBe('CP-2025');
  expect(records[0]?.result.memo).toContain('Human decision required');
});
it('records reported failed-generation usage and builds a code-only referral memo', async () => {
  const state = await run('APP-001', {
    provider: {
      completeStructured: async () => {
        throw new DomainError('InvalidLLMOutput', 'Invalid JSON', 422, {
          model: 'fake',
          inputTokens: 23,
          outputTokens: 5,
        });
      },
    },
  });
  expect(state.result?.usageRecords).toEqual([{ model: 'fake', inputTokens: 23, outputTokens: 5 }]);
  expect(state.result?.memo).toContain('InvalidLLMOutput');
  expect(state.result?.calculation).toBeNull();
});
it('records invalid JSON and consumed tokens before validation failed', async () => {
  const result = (
    await run('APP-001', {
      provider: {
        completeStructured: async () => ({
          value: {},
          model: 'fake',
          usage: { inputTokens: 17, outputTokens: 3 },
        }),
      },
    })
  ).result;
  expect(result?.reason).toBe('InvalidLLMOutput');
  expect(records[0]?.result.usageRecords?.[0]?.inputTokens).toBe(17);
});
it('refers missing clauses or inconsistent source/configuration', async () => {
  expect((await run('APP-001', { clauses: { loadRequired: async () => [] } })).result?.reason).toBe(
    'MissingPolicyClause',
  );
  expect(
    (await run('APP-001', { policies: deps.policies.map((p) => ({ ...p, maxDbr: '0.99' })) }))
      .result?.reason,
  ).toBe('PolicyConfigurationMismatch');
  expect(
    (await run('APP-001', { policies: deps.policies.map((p) => ({ ...p, maxDbr: '0.50' })) }))
      .result?.reason,
  ).toBe('PolicyConfigurationMismatch');
});
it('rejects client verification flags and does not trust caller-supplied evidence', async () => {
  expect(
    documentAssessmentInputSchema.safeParse({
      document: await load('APP-001'),
      actorId: 'actor',
      at: '2026-11-19T12:00:00Z',
      synthetic: true,
      verifiedFacts: { confirmed: true },
    }).success,
  ).toBe(false);
});
it('derives real local facts rather than using requested values', async () => {
  expect(deriveEvidenceFacts(await load('APP-001')).facts.confirmed).toBe(true);
  expect(deriveEvidenceFacts(await load('APP-002')).facts.confirmed).toBe(true);
  expect(deriveEvidenceFacts(await load('APP-002')).provenance.employmentConfirmation).toBe(
    'permanent_employment_statement',
  );
  const doc = await load('APP-001');
  const unstatedEmployment = {
    ...doc,
    blocks: doc.blocks.map((b) => ({
      ...b,
      text: b.text.replace(
        'His employment is permanent and he has completed his probation',
        'His employment status is salaried',
      ),
    })),
  };
  expect(deriveEvidenceFacts(unstatedEmployment).facts.confirmed).toBeNull();
  expect(() =>
    deriveEvidenceFacts({
      ...doc,
      blocks: doc.blocks.map((b) => ({
        ...b,
        text: b.text.replace('completed his probation', 'not completed his probation'),
      })),
    }),
  ).toThrow('probation');
  expect(() =>
    deriveEvidenceFacts({
      ...doc,
      blocks: doc.blocks.map((b) => ({
        ...b,
        text: b.text.replace('Facilities in default None', 'Facilities in default Unknown'),
      })),
    }),
  ).toThrow('human verification');
});

it('refers an explicit employer discrepancy between salary and bureau evidence', async () => {
  const doc = await load('APP-001');
  const addBureauEmployer = (employer: string) => ({
    ...doc,
    blocks: doc.blocks.map((block) => ({
      ...block,
      text: block.text.replace(
        'Facilities in default None',
        `Facilities in default None\nEmployer: ${employer}`,
      ),
    })),
  });
  const employer = doc.blocks
    .map((block) => block.text)
    .join('\n')
    .match(/^Employer (.+)$/m)![1]!;
  expect(deriveEvidenceFacts(addBureauEmployer(employer.toUpperCase())).facts.confirmed).toBe(true);
  expect(() => deriveEvidenceFacts(addBureauEmployer(`${employer} Subsidiary`))).toThrow(
    'Reported employer disagrees',
  );
});

it('records skipped steps honestly and propagates persistence failure', async () => {
  const state = await run('APP-004');
  expect(state.result?.stageEvents?.find((x) => x.stage === 'extract_data')?.status).toBe(
    'skipped',
  );
  const workflow = createDocumentAssessmentWorkflow({
    ...deps,
    persistence: {
      ...deps.persistence,
      repository: {
        save: async () => {
          throw new Error('Simulated database failure');
        },
      },
    },
  });
  const result = await (
    await workflow.createRun()
  ).start({
    inputData: {
      document: await load('APP-001'),
      actorId: 'actor',
      at: '2026-11-19T12:00:00Z',
      synthetic: true,
      requestedMode: 'demo',
    },
  });
  expect(result.status).toBe('failed');
});
it('changing only protected fields leaves the recommendation and canonical memo unchanged', async () => {
  const doc = await load('APP-001');
  const altered = {
    ...doc,
    blocks: doc.blocks.map((b) => ({
      ...b,
      text: b.text
        .replace('Gender Male', 'Gender Female')
        .replace('Marital status Married', 'Marital status Single')
        .replace(
          'Religion (declared for statistics only) Muslim',
          'Religion (declared for statistics only) Christian',
        )
        .replace('Nationality Egyptian', 'Nationality Other'),
    })),
  };
  const alteredText = altered.blocks.map((b) => b.text).join('\n');
  expect(alteredText).toContain('Gender Female');
  expect(alteredText).toContain('Marital status Single');
  expect(alteredText).toContain('Religion (declared for statistics only) Christian');
  expect(alteredText).toContain('Nationality Other');
  const original = (await run('APP-001')).result;
  const r = await (
    await createDocumentAssessmentWorkflow(deps).createRun()
  ).start({
    inputData: {
      document: altered,
      actorId: 'actor',
      at: '2026-11-19T12:00:00Z',
      synthetic: true,
      requestedMode: 'demo',
    },
  });
  expect(r.status).toBe('success');
  if (r.status === 'success') {
    expect(r.result.result?.memo).toBe(original?.memo);
    expect(r.result.result?.calculation).toEqual(original?.calculation);
  }
});

it('refers invalid local extraction and keeps both generation attempts in the assessment audit data', async () => {
  const state = await run('APP-001', {
    provider: {
      completeStructured: async () => ({
        model: 'ollama:test-local',
        fallbackFrom: 'gemini-test',
        usage: { inputTokens: 21, outputTokens: 8 },
        value: { income: 'unverified' },
      }),
    },
  });
  expect(state.result).toMatchObject({
    recommendation: 'REFER_TO_HUMAN',
    reason: 'InvalidLLMOutput',
    calculation: null,
    usageRecords: [
      { model: 'gemini-test', inputTokens: null, outputTokens: null },
      { model: 'ollama:test-local', fallbackFrom: 'gemini-test', inputTokens: 21, outputTokens: 8 },
    ],
  });
});

it('keeps Strict and Demo assessment outcomes identical for all five original packs in agent mode', async () => {
  const plannerInputs: string[] = [];
  const routed: GenerationPort = {
    completeStructured: async (system, data, schema) => {
      const request = JSON.parse(data) as {
        assessmentAgent?: string;
        tool?: string;
        expectedArguments?: Record<string, unknown>;
      };
      if (!request.assessmentAgent) return deps.provider.completeStructured(system, data, schema);
      plannerInputs.push(data);
      return {
        value: { tool: request.tool, arguments: request.expectedArguments ?? {} },
        model: 'fixture-planner',
        usage: { inputTokens: 10, outputTokens: 3 },
      };
    },
  };
  for (const strict of [true, false]) {
    for (const reference of ['APP-001', 'APP-002', 'APP-003', 'APP-004', 'APP-005']) {
      const baseline = (await run(reference, {}, strict)).result!;
      const actual = (
        await run(reference, { provider: routed, agents: assessmentAgents('agents') }, strict)
      ).result!;
      const { agentToolCalls, usageRecords, ...outcome } = actual;
      expect({
        ...outcome,
        usageRecords: usageRecords?.filter((record) => !record.operation),
      }).toEqual(baseline);
      if (strict || reference === 'APP-004') {
        expect(agentToolCalls).toBeUndefined();
        expect(usageRecords).toEqual([]);
      } else {
        expect(agentToolCalls?.map(({ agent, tool, status }) => ({ agent, tool, status }))).toEqual(
          [
            { agent: 'evidence', tool: 'extract_verified_evidence', status: 'executed' },
            { agent: 'policy', tool: 'read_operative_policy_clauses', status: 'executed' },
            { agent: 'memo', tool: 'render_credit_memo', status: 'executed' },
          ],
        );
        expect(agentToolCalls?.every((call) => call.input && call.output?.completed)).toBe(true);
        expect(
          usageRecords?.filter((record) => record.operation === 'assessment_agent_planning'),
        ).toHaveLength(3);
      }
    }
  }
  expect(plannerInputs).toHaveLength(12);
  for (const input of plannerInputs)
    expect(Object.keys(JSON.parse(input)).sort()).toEqual([
      'assessmentAgent',
      'expectedArguments',
      'task',
      'tool',
    ]);
}, 30000);
