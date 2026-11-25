import { readFile } from 'node:fs/promises';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { chunkDocument } from '../packages/infrastructure/src/parsers/chunker.js';
import { extractPricing } from '../packages/infrastructure/src/parsers/pricing.js';
import { parseApplicationForm } from '../packages/application/src/application-form.js';
import type { DocumentAssessmentDependencies } from '../packages/application/src/document-assessment.js';
import type { ManifestEntry } from '../packages/infrastructure/src/knowledge/ingestion.js';
import { createDocumentAssessmentWorkflow } from '../packages/infrastructure/src/workflows/document-assessment.js';
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

const parser = new ParserRegistry();
let deps: DocumentAssessmentDependencies;
let app001: Awaited<ReturnType<ParserRegistry['extract']>>;

beforeAll(async () => {
  app001 = await parser.extract('APP-001.pdf', await readFile('data/corpus/evidence/APP-001.pdf'));
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
    clauses: { loadRequired: async () => clauses },
    persistence: {
      runId: 'run',
      applicationId: 'application',
      requestId: 'request',
      repository: { save: async () => undefined },
    },
  };
});

async function runWorkflow(
  overrides: Partial<DocumentAssessmentDependencies> = {},
  inputOverrides: {
    document?: typeof app001;
    requestedMode?: 'strict' | 'demo';
  } = {},
) {
  const workflow = createDocumentAssessmentWorkflow({ ...deps, ...overrides });
  const outcome = await (
    await workflow.createRun()
  ).start({
    inputData: {
      document: inputOverrides.document ?? app001,
      actorId: 'preparer',
      at: '2026-11-17T12:00:00Z',
      synthetic: true,
      ...(inputOverrides.requestedMode ? { requestedMode: inputOverrides.requestedMode } : {}),
    },
  });
  expect(outcome.status).toBe('success');
  if (outcome.status !== 'success') throw new Error('Workflow failed');
  return outcome.result.result!;
}

it('parses all five form layouts without retaining protected fields', async () => {
  for (let i = 1; i <= 5; i++) {
    const id = `APP-00${i}`;
    const doc = await parser.extract(`${id}.pdf`, await readFile(`data/corpus/evidence/${id}.pdf`));
    const form = parseApplicationForm(doc);
    expect(form.reference).toBe(id);
    expect(form.payrollTransfer).toBe(false);
    expect(Object.keys(form)).not.toContain('gender');
    expect(Object.keys(form)).not.toContain('religion');
    expect(Object.keys(form)).not.toContain('marital_status');
    expect(Object.keys(form)).not.toContain('nationality');
  }
});

it('computes the recommendation with source pricing, authority tier and demo assumptions', async () => {
  const result = await runWorkflow({}, { requestedMode: 'demo' });
  expect(result.recommendation).toBe('APPROVE');
  expect(result.approvalRequiredFrom).toBe('senior_credit_officer');
  expect(result.calculation?.monthlyInstallment).toBe('8630.39');
  expect(result.calculation?.maximumEligibleAmount).toBe('330000.00');
  expect(result.status).toBe('pending_approval');
  expect(result.evidence.assumptions).toHaveLength(1);
  expect(result.evidence.fullyEvidenceVerified).toBe(false);
});

it('defaults to strict and refers before calling the model when ID evidence is missing', async () => {
  const provider = new FakeGeneration(extracted);
  const result = await runWorkflow({ provider });
  expect(result.recommendation).toBe('REFER_TO_HUMAN');
  expect(provider.calls).toHaveLength(0);
});

it('converts invalid LLM JSON to a named referral', async () => {
  const result = await runWorkflow({ provider: new FakeGeneration({}) }, { requestedMode: 'demo' });
  expect(result.recommendation).toBe('REFER_TO_HUMAN');
  expect(result.reason).toBe('InvalidLLMOutput');
});

it('leaves over-age assessment without affordability calculation', async () => {
  const document = {
    ...app001,
    blocks: app001.blocks.map((b) => ({
      ...b,
      text: b.text.replace('Date of birth 12 April 1987', 'Date of birth 20 June 1968'),
    })),
  };
  const result = await runWorkflow({}, { document, requestedMode: 'demo' });
  expect(result.recommendation).toBe('DECLINE');
  expect(result.calculation).toBeNull();
});

it('executes the persistence stage after assessment and returns only after saving', async () => {
  const saved: string[] = [];
  const result = await runWorkflow(
    {
      persistence: {
        ...deps.persistence,
        repository: {
          save: async (record) => {
            saved.push(record.result.recommendation);
          },
        },
      },
    },
    { requestedMode: 'demo' },
  );
  expect(result.recommendation).toBe('APPROVE');
  expect(saved).toEqual(['APPROVE']);
});
