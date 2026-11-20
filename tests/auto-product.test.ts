import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parseApplicationForm } from '../packages/application/src/application-form.js';
import { deriveEvidenceFacts } from '../packages/application/src/evidence-facts.js';
import { sanitizeEvidence } from '../packages/application/src/extraction.js';
import { selectPolicy, selectPricing } from '../packages/domain/src/policy.js';
import { assessRules, type ApplicantFacts } from '../packages/domain/src/rules.js';
import type { ManifestEntry } from '../packages/infrastructure/src/knowledge/ingestion.js';
import { chunkDocument } from '../packages/infrastructure/src/parsers/chunker.js';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import {
  loadAssessmentFixtures,
  loadProductCatalog,
} from '../packages/infrastructure/src/product-catalog.js';

const registry = new ParserRegistry();
const supplemental = JSON.parse(readFileSync('data/evaluation/auto-loan-cases.json', 'utf8')) as {
  assessments: {
    id: string;
    fixture: string;
    form: { amount: string; vehiclePrice: string | null; downPayment: string };
  }[];
};

it('keeps the 12 original source hashes and excludes private packs from the policy manifest', async () => {
  const manifest: ManifestEntry[] = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  );
  const baseline = JSON.parse(
    await readFile('data/evaluation/results/vector-core-baseline.json', 'utf8'),
  ) as { hashes: Record<string, string> };
  const policyFiles = await readdir('data/corpus/policy');
  expect(policyFiles.toSorted()).toEqual(manifest.map(({ filename }) => filename).toSorted());
  const personal = manifest.filter(({ product }) => product === 'PL-100');
  expect(personal).toHaveLength(7);
  for (const entry of manifest) {
    const bytes = await readFile(`data/corpus/policy/${entry.filename}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    if (entry.product === 'PL-100') expect(entry.sha256).toBe(baseline.hashes[entry.filename]);
  }
  const fixtures = await loadAssessmentFixtures();
  const originalPacks = fixtures.filter(({ reference }) => reference.startsWith('APP-'));
  expect(originalPacks).toHaveLength(5);
  for (const fixture of originalPacks) {
    expect(fixture.hash).toBe(baseline.hashes[`evidence/${fixture.filename}`]);
  }
  expect(manifest.some((entry) => fixtures.some(({ hash }) => hash === entry.sha256))).toBe(false);
});

it('uses separate dated credit and pricing records with compatible source clauses', async () => {
  const { 'PL-100': personal, 'AL-200': auto } = await loadProductCatalog();
  const date = '2025-04-03';
  expect(selectPolicy(personal.policies, '2024-04-03')).toMatchObject({ maxDbr: '0.50' });
  expect(selectPolicy(personal.policies, date)).toMatchObject({ maxDbr: '0.45' });
  expect(selectPricing(personal.pricing, date, 60, false)).toMatchObject({
    documentId: 'PT-2025-01',
    annualRatePercent: '24.00',
    sourceFile: 'pricing-table.csv',
    row: 3,
  });
  const policy = selectPolicy(auto.policies, date);
  expect(policy).toMatchObject({ edition: 'AUTO-2025', productId: 'AL-200', maxDbr: '0.40' });
  expect(() => selectPolicy(auto.policies, '2025-02-28')).toThrow();
  expect(() => selectPricing(auto.pricing, '2025-02-28', 60, false)).toThrow();
  expect(selectPricing(auto.pricing, date, 60, false)).toMatchObject({
    documentId: 'PT-AL-200',
    annualRatePercent: '20.00',
    sourceFile: 'synthetic-auto-pricing.csv',
    row: 3,
  });
  expect(selectPricing(auto.pricing, date, 60, true).annualRatePercent).toBe('18.00');
  const manifest: ManifestEntry[] = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  );
  const autoEntries = manifest.filter(({ product }) => product === 'AL-200');
  expect(autoEntries.map(({ kind }) => kind).toSorted()).toEqual([
    'policy',
    'pricing',
    'procedure',
    'product',
  ]);
  const sourceChunks = await Promise.all(
    autoEntries.map(async (entry) =>
      chunkDocument(
        await registry.extract(
          entry.filename,
          await readFile(`data/corpus/policy/${entry.filename}`),
        ),
        entry,
      ),
    ),
  );
  expect(sourceChunks.flat()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        documentId: policy.edition,
        section: 'CP-4.1',
        text: expect.stringContaining('40%'),
      }),
      expect.objectContaining({
        documentId: 'PS-AL-200',
        section: 'PS-9',
        text: expect.stringContaining(`${auto.product.auto!.minimumDownPaymentPercent}%`),
      }),
      expect.objectContaining({ documentId: 'PM-AL-200', section: 'PM-2' }),
    ]),
  );
  expect(sourceChunks.flat().every(({ product }) => product === 'AL-200')).toBe(true);
});

it('parses dated synthetic auto PDFs without exposing vehicle or customer fields to the extractor', async () => {
  const fixtures = await loadAssessmentFixtures();
  const autoFixtures = fixtures.filter(({ reference }) => reference.startsWith('AUTO-'));
  expect(autoFixtures.map(({ reference }) => reference)).toEqual(
    supplemental.assessments.map(({ fixture }) => fixture),
  );
  for (const assessment of supplemental.assessments) {
    const { filename, bytes, hash } = autoFixtures.find(
      ({ reference }) => reference === assessment.fixture,
    )!;
    const document = await registry.extract(filename, bytes, 'application/pdf');
    expect(document.hash).toBe(hash);
    expect(document.blocks[0]?.text).toContain('CREDIT COPILOT SYNTHETIC TEST PACK');
    const form = parseApplicationForm(document);
    expect({ ...form, vehiclePrice: form.vehiclePrice ?? null }).toMatchObject({
      ...assessment.form,
      reference: assessment.fixture,
      productId: 'AL-200',
      applicationDate: '2025-04-03',
      months: 60,
    });
    const evidence = deriveEvidenceFacts(document);
    expect(evidence.evidence).toEqual(
      expect.arrayContaining([
        { requirement: 'national_id_copy', present: false, verified: false },
        {
          requirement: 'vehicle_quotation',
          present: assessment.form.vehiclePrice !== null,
          verified: false,
        },
      ]),
    );
    expect(sanitizeEvidence(document).lines.map(({ text }) => text)).toEqual([
      'Employment start 1 September 2019',
      'Net monthly income 30,000.00',
      'Bureau score 712',
      'Total monthly instalments 4,000.00',
    ]);
  }
  const first = fixtures.find(({ reference }) => reference === 'APP-001')!;
  expect(parseApplicationForm(await registry.extract(first.filename, first.bytes))).toMatchObject({
    reference: first.reference,
    productId: 'PL-100',
  });
});

it('checks down payment at the cent and refers unaffordable auto finance for new evidence', async () => {
  const { policies, pricing, product } = (await loadProductCatalog())['AL-200'];
  const facts: ApplicantFacts = {
    applicationDate: '2025-04-03',
    birthDate: '1990-06-07',
    employmentStart: '2019-09-01',
    certificateDate: '2025-03-20',
    income: '30000.00',
    obligations: '4000.00',
    bureauScore: 712,
    confirmed: true,
    hasDefault: false,
    bankEmployee: false,
    purposeAllowed: true,
    amount: '262500.00',
    months: 60,
    plannedDisbursement: '2025-04-03',
    vehiclePrice: '350000.00',
    downPayment: '87500.00',
  };
  const policy = selectPolicy(policies, facts.applicationDate);
  const rate = selectPricing(pricing, facts.applicationDate, facts.months, false);
  expect(assessRules(facts, policy, product, rate).recommendation).toBe('APPROVE');
  expect(
    assessRules({ ...facts, amount: '262500.01', downPayment: '87499.99' }, policy, product, rate),
  ).toMatchObject({
    recommendation: 'DECLINE',
    calculation: null,
    results: expect.arrayContaining([expect.objectContaining({ rule: 'PS-9', result: 'fail' })]),
  });
  expect(assessRules({ ...facts, income: '15000.00' }, policy, product, rate)).toMatchObject({
    recommendation: 'REFER_TO_HUMAN',
    recommendedAmount: null,
    calculation: { passes: false },
  });
});
