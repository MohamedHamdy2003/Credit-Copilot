import { readFile } from 'node:fs/promises';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { extractPricing } from '../packages/infrastructure/src/parsers/pricing.js';
import {
  assessApplication,
  type AssessmentDependencies,
  type AssessmentInput,
} from '../packages/application/src/assessment.js';
import { parseApplicationForm } from '../packages/application/src/application-form.js';
import { createAssessmentWorkflow } from '../packages/infrastructure/src/workflows/assessment.js';
import { FakeGeneration } from './helpers/fake-provider.js';
const extracted = {
  income: { value: '30000.00', quote: 'Net monthly income 30,000.00', section: 'salary' },
  obligations: { value: '4000.00', quote: 'Total monthly instalments 4,000.00', section: 'bureau' },
  employmentStart: {
    value: '2019-09-01',
    quote: 'Employment start 1 September 2019',
    section: 'salary',
  },
  bureauScore: { value: 712, quote: 'Bureau score 712', section: 'bureau' },
};
let input: AssessmentInput;
let deps: AssessmentDependencies;
beforeAll(async () => {
  const parser = new ParserRegistry();
  input = {
    document: await parser.extract(
      'APP-001.pdf',
      await readFile('data/corpus/evidence/APP-001.pdf'),
    ),
    actorId: 'preparer',
    at: '2026-11-17T12:00:00Z',
    synthetic: true,
    requestedMode: 'demo',
    evidence: [{ requirement: 'national_id_copy', present: false, verified: false }],
    verifiedFacts: {
      certificateDate: '2025-03-28',
      confirmed: true,
      hasDefault: false,
      bankEmployee: false,
      purposeAllowed: true,
      plannedDisbursement: '2025-04-03',
    },
  };
  deps = {
    provider: new FakeGeneration(extracted),
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
  };
});
it('parses all five form layouts without retaining protected fields', async () => {
  for (let i = 1; i <= 5; i++) {
    const id = `APP-00${i}`;
    const doc = await new ParserRegistry().extract(
      `${id}.pdf`,
      await readFile(`data/corpus/evidence/${id}.pdf`),
    );
    const form = parseApplicationForm(doc);
    expect(form.reference).toBe(id);
    expect(form.payrollTransfer).toBe(false);
    expect(Object.keys(form)).not.toContain('gender');
  }
});
it('computes the recommendation with source pricing and records demo assumptions', async () => {
  const result = await assessApplication(input, deps);
  expect(result.recommendation).toBe('APPROVE');
  expect(result.calculation?.monthlyInstallment).toBe('8630.39');
  expect(result.calculation?.maximumEligibleAmount).toBe('330000.00');
  expect(result.status).toBe('pending_approval');
  expect(result.evidence.assumptions).toHaveLength(1);
  expect(result.evidence.fullyEvidenceVerified).toBe(false);
});
it('defaults to strict and refers before calling the model when ID evidence is missing', async () => {
  const provider = new FakeGeneration(extracted);
  const result = await assessApplication(
    { ...input, requestedMode: undefined },
    { ...deps, provider },
  );
  expect(result.recommendation).toBe('REFER_TO_HUMAN');
  expect(provider.calls).toHaveLength(0);
});
it('converts invalid LLM JSON to a named referral', async () => {
  const result = await assessApplication(input, { ...deps, provider: new FakeGeneration({}) });
  expect(result.recommendation).toBe('REFER_TO_HUMAN');
  expect('reason' in result && result.reason).toBe('InvalidLLMOutput');
});
it('leaves over-age assessment without affordability calculation', async () => {
  const document = {
    ...input.document,
    blocks: input.document.blocks.map((b) => ({
      ...b,
      text: b.text.replace('Date of birth 12 April 1987', 'Date of birth 20 June 1968'),
    })),
  };
  const result = await assessApplication({ ...input, document }, deps);
  expect(result.recommendation).toBe('DECLINE');
  expect(result.calculation).toBeNull();
});
it('executes through the real Mastra workflow engine offline', async () => {
  const run = await createAssessmentWorkflow(deps).createRun();
  const result = await run.start({ inputData: input });
  expect(result.status).toBe('success');
  if (result.status === 'success') expect(result.result.recommendation).toBe('APPROVE');
});

it('executes the persistence stage after assessment and returns only after saving', async () => {
  const saved: string[] = [];
  const workflow = createAssessmentWorkflow(deps, {
    runId: 'run',
    applicationId: 'application',
    requestId: 'request',
    actorId: input.actorId,
    at: input.at,
    repository: {
      save: async (record) => {
        saved.push(record.result.recommendation);
      },
    },
  });
  const run = await workflow.createRun();
  const result = await run.start({ inputData: input });
  expect(result.status).toBe('success');
  expect(saved).toEqual(['APPROVE']);
});
