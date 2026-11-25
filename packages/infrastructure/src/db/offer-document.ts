import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ApplicationForm } from '../../../application/src/application-form.js';
import type { AssessmentResult } from '../../../application/src/assessment-record.js';
import {
  issuedOfferDocumentSchema,
  type IssuedOfferDocument,
} from '../../../contracts/src/offers.js';
import { addMonths, compareMoney } from '../../../domain/src/calculations.js';
import { DomainError, invariant } from '../../../domain/src/errors.js';
import { selectPricing } from '../../../domain/src/policy.js';
import { buildRepaymentSchedule } from '../../../domain/src/repayment-schedule.js';
import type { ManifestEntry } from '../knowledge/ingestion.js';
import { extractPricing } from '../parsers/pricing.js';
import { ParserRegistry } from '../parsers/registry.js';

// The clauses and fee values below were checked against these exact source revisions.
// A later source with the same filename cannot silently change a historic letter.
const reviewedTerms = {
  'PL-100': {
    sheet: 'PS-PL-100',
    sheetFile: 'product-sheet-personal-loan.md',
    sheetVersion: '3.1',
    sheetHash: 'c48471272ecceff2fb2ec1d19a91410e742297259c41664e77be83e2999603ac',
    pricing: 'PT-2025-01',
    pricingHash: '9edc05dc7dde2e1e2345dec29209294415164b71c55fb168a42aaecc1234c589',
    evidence:
      'Application form, salary certificate issued within 60 days, national ID copy and bank-obtained bureau report.',
  },
  'AL-200': {
    sheet: 'PS-AL-200',
    sheetFile: 'synthetic-auto-product.md',
    sheetVersion: '1.0',
    sheetHash: '1e419d2b0e64b154f07683b49b16df3d1cf29efeeaf79a8f7d987a01e7c898c2',
    pricing: 'PT-AL-200',
    pricingHash: '606fe7ad3bf14bfd862da9f276d8838b29c4432c34b0442296fe5d0f61369cba',
    evidence:
      'Application, national ID copy, current stamped salary certificate, bank-obtained bureau report and vehicle quotation with documented down payment.',
  },
};
const reviewedPolicies: Readonly<Record<string, { filename: string; sha256: string }>> = {
  'CP-2024': {
    filename: 'credit-policy-2024.pdf',
    sha256: 'bc835d292e81d99312fda3873045a65b954cda5ee3320d6dbc83bb4c39249016',
  },
  'CP-2025': {
    filename: 'credit-policy-2025.pdf',
    sha256: '7355ce3a7f59a9c45d56b2ee75d042c7bd3d503318482cbcc938d635a8b2dd76',
  },
  'AUTO-2025': {
    filename: 'synthetic-auto-policy-2025.md',
    sha256: '3c1255163f65aa83faf9ed73a6373056638a994a5f5561b6ef622d01c6e6e8da',
  },
};

function requireProvenance(value: unknown): asserts value {
  invariant(
    value,
    'OfferDocumentUnavailable',
    'Verified offer document provenance is incomplete',
    409,
  );
}

export interface OfferApprovalRow {
  id: string;
  amount: string;
  approver_id: string;
  created_at: Date;
  assessment_version: number;
}

const approvalAuthoritySchema = issuedOfferDocumentSchema.shape.approval.pick({
  approverTier: true,
  approverAuthorityLimit: true,
});
const issuerTierSchema = issuedOfferDocumentSchema.shape.issuance.shape.issuerTier;
export function recordedApprovalAuthority(details: unknown) {
  const authority = approvalAuthoritySchema.safeParse(details);
  return authority.success && authority.data.approverTier && authority.data.approverAuthorityLimit
    ? authority.data
    : {};
}
export function recordedIssuerTier(value: unknown) {
  const tier = issuerTierSchema.safeParse(value);
  return tier.success ? tier.data : undefined;
}

async function readReviewedSource(source: ManifestEntry, digest: string | undefined) {
  requireProvenance(
    digest &&
      source.sha256 === digest &&
      /^[a-zA-Z0-9 ._-]+\.(?:pdf|md|csv)$/.test(source.filename),
  );
  const bytes = await readFile(`data/corpus/policy/${source.filename}`);
  requireProvenance(createHash('sha256').update(bytes).digest('hex') === digest);
  return bytes;
}

function citation(source: ManifestEntry, clause: string, description: string) {
  return {
    sourceFile: source.filename,
    documentId: source.id,
    version: source.edition,
    clause,
    description,
  };
}

async function verifiedOfferSources(form: ApplicationForm, result: AssessmentResult) {
  const { pricing, policyEdition } = result;
  requireProvenance(pricing && policyEdition);
  const terms = reviewedTerms[form.productId];
  const manifest = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  ) as ManifestEntry[];
  const sources = manifest.filter(
    (source) =>
      source.product === form.productId &&
      source.effectiveFrom <= form.applicationDate &&
      (!source.effectiveTo || form.applicationDate < source.effectiveTo),
  );
  const sheet = sources.find(
    (source) =>
      source.kind === 'product' &&
      source.id === terms.sheet &&
      source.filename === terms.sheetFile &&
      source.edition === terms.sheetVersion,
  );
  const reviewedPolicy = reviewedPolicies[policyEdition];
  const policy = sources.find(
    (source) =>
      source.kind === 'policy' &&
      source.edition === policyEdition &&
      source.filename === reviewedPolicy?.filename,
  );
  const pricingSource = sources.find(
    (source) =>
      source.kind === 'pricing' &&
      source.id === terms.pricing &&
      source.filename === pricing.sourceFile,
  );
  requireProvenance(
    sheet &&
      policy &&
      pricingSource &&
      (!result.productSource || sheet.filename === result.productSource),
  );
  const [, , bytes] = await Promise.all([
    readReviewedSource(sheet, terms.sheetHash),
    readReviewedSource(policy, reviewedPolicy?.sha256),
    readReviewedSource(pricingSource, terms.pricingHash),
  ]);
  const rows = extractPricing(await new ParserRegistry().extract(pricing.sourceFile, bytes));
  const rate = selectPricing(rows, form.applicationDate, form.months, form.payrollTransfer);
  requireProvenance(
    rate.documentId === pricingSource.id &&
      rate.version === pricingSource.edition &&
      rate.row === pricing.row &&
      compareMoney(rate.annualRatePercent, pricing.annualRatePercent) === 0,
  );
  return { sheet, policy, pricingSource, pricing, policyEdition, terms };
}

export async function buildIssuedOfferDocument(input: {
  offerId: string;
  runId: string;
  form: ApplicationForm;
  result: AssessmentResult;
  preparerId: string;
  approval: OfferApprovalRow;
  approvalAuthority?: unknown;
  issuance: IssuedOfferDocument['issuance'];
  disbursementDate: string;
}): Promise<IssuedOfferDocument> {
  const { offerId, runId, form, result, preparerId, approval, issuance, disbursementDate } = input;
  try {
    const approvedReferral =
      result.recommendation === 'REFER_TO_HUMAN' &&
      !result.fraudReferral &&
      result.evidence.missing.length === 0 &&
      Boolean(result.results?.length) &&
      !result.results?.some((r) => r.result === 'fail') &&
      Boolean(
        result.results?.some((r) => r.result === 'refer' && ['CP-6', 'CP-8'].includes(r.rule)),
      );
    requireProvenance(
      form.reference === result.reference &&
        form.productId === (result.productId ?? 'PL-100') &&
        (['APPROVE', 'OFFER_ALTERNATIVE'].includes(result.recommendation) || approvedReferral) &&
        result.recommendedAmount &&
        compareMoney(result.recommendedAmount, approval.amount) === 0 &&
        result.calculation &&
        !result.fraudReferral &&
        result.evidence.missing.length === 0 &&
        approval.approver_id !== preparerId &&
        issuance.issuerId !== preparerId &&
        approval.created_at.getTime() <= Date.parse(issuance.issuedAt) &&
        disbursementDate >= form.applicationDate &&
        form.months >= 12 &&
        form.months <= 60 &&
        addMonths(disbursementDate, form.months) <= addMonths(form.birthDate, 60 * 12),
    );
    const { sheet, policy, pricingSource, pricing, policyEdition, terms } =
      await verifiedOfferSources(form, result);
    const administrativeFeePercent = '1';
    const schedule = buildRepaymentSchedule({
      principal: approval.amount,
      annualRatePercent: pricing.annualRatePercent,
      months: form.months,
      disbursementDate,
      administrativeFeePercent,
    });
    const conditions = [
      citation(sheet, 'PS-5', 'Monthly instalments start one month after disbursement.'),
      citation(
        sheet,
        'PS-6',
        `A 1% administrative fee is deducted at disbursement. Early settlement is 2% of the outstanding ${form.productId === 'AL-200' ? 'principal' : 'balance'}. Late fee is EGP 150 per missed instalment.`,
      ),
      citation(sheet, 'PS-7', terms.evidence),
      citation(policy, 'CP-3.5', 'Final instalment must fall on or before the 60th birthday.'),
      ...(approvedReferral
        ? [
            citation(
              policy,
              result.results?.some((r) => r.rule === 'CP-6' && r.result === 'refer')
                ? 'CP-6'
                : 'CP-8',
              'Referred application approved by Senior Credit Officer with recorded written justification under PM-4.',
            ),
          ]
        : []),
      ...(form.productId === 'AL-200'
        ? [
            citation(
              sheet,
              'PS-9',
              'Documented down payment must be at least 25% of verified vehicle price. Reassess revised funding before issuance.',
            ),
          ]
        : []),
    ];
    return issuedOfferDocumentSchema.parse({
      version: 1,
      offerId,
      runId,
      applicationReference: form.reference,
      productId: form.productId,
      policyEdition,
      mode: result.mode,
      fullyEvidenceVerified: result.evidence.fullyEvidenceVerified,
      principal: approval.amount,
      annualRatePercent: pricing.annualRatePercent,
      months: form.months,
      disbursementDate,
      administrativeFeePercent,
      earlySettlementFeePercent: '2',
      lateFee: '150.00',
      schedule,
      pricing: {
        sourceFile: pricing.sourceFile,
        row: pricing.row,
        documentId: pricingSource.id,
        version: pricingSource.edition,
      },
      conditions,
      approval: {
        id: approval.id,
        preparerId,
        approverId: approval.approver_id,
        approvedAt: approval.created_at.toISOString(),
        ...recordedApprovalAuthority(input.approvalAuthority),
      },
      issuance,
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'OfferDocumentUnavailable') throw error;
    throw new DomainError(
      'OfferDocumentUnavailable',
      'Verified offer document provenance is incomplete',
      409,
    );
  }
}
