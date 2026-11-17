import type { NormalizedDocument } from '../../contracts/src/documents.js';
import type { GenerationPort } from './ports.js';
import { parseApplicationForm } from './application-form.js';
import { extractVerified, sanitizeEvidence } from './extraction.js';
import {
  evaluateEvidence,
  resolveMode,
  type AssessmentMode,
  type EvidenceItem,
} from '../../domain/src/evidence-mode.js';
import {
  selectPolicy,
  selectPricing,
  type Policy,
  type PricingRow,
  type Product,
} from '../../domain/src/policy.js';
import { assessRules, type ApplicantFacts } from '../../domain/src/rules.js';
import { DomainError } from '../../domain/src/errors.js';

export interface AssessmentInput {
  document: NormalizedDocument;
  actorId: string;
  at: string;
  synthetic: boolean;
  requestedMode?: AssessmentMode;
  evidence: EvidenceItem[];
  // Verified non-LLM facts must be supplied by an evidence-verification service.
  verifiedFacts: Pick<
    ApplicantFacts,
    | 'certificateDate'
    | 'confirmed'
    | 'hasDefault'
    | 'bankEmployee'
    | 'purposeAllowed'
    | 'plannedDisbursement'
  >;
}
export interface AssessmentDependencies {
  provider: GenerationPort;
  prompt: string;
  policies: Policy[];
  product: Product;
  pricing: PricingRow[];
  settings: { allowDemo: boolean; defaultMode?: AssessmentMode };
}
export async function assessApplication(
  input: AssessmentInput,
  dependencies: AssessmentDependencies,
) {
  const steps: string[] = [];
  const form = parseApplicationForm(input.document);
  steps.push('load_application');
  const sanitized = sanitizeEvidence(input.document);
  steps.push('remove_protected_attributes');
  const mode = resolveMode(input.requestedMode, dependencies.settings, input.synthetic);
  const evidence = evaluateEvidence(input.evidence, mode, input.actorId, input.at);
  const policy = selectPolicy(dependencies.policies, form.applicationDate);
  steps.push('select_policy');
  const base = {
    reference: form.reference,
    mode,
    evidence,
    policyEdition: policy.edition,
    maxDbr: policy.maxDbr,
    removedFields: sanitized.removedFields,
    steps,
  };
  if (evidence.referral)
    return {
      ...base,
      recommendation: 'REFER_TO_HUMAN' as const,
      reason: evidence.referral.reason,
      citations: evidence.referral.citations,
      fraudReferral: sanitized.tampered,
      calculation: null,
      status: 'pending_review' as const,
    };
  try {
    steps.push('extract_data');
    const extraction = await extractVerified(
      input.document,
      dependencies.provider,
      dependencies.prompt,
    );
    const pricing = selectPricing(
      dependencies.pricing,
      form.applicationDate,
      form.months,
      form.payrollTransfer,
    );
    steps.push('load_applicable_rules');
    const result = assessRules(
      {
        ...input.verifiedFacts,
        applicationDate: form.applicationDate,
        birthDate: form.birthDate,
        amount: form.amount,
        months: form.months,
        income: extraction.fields.income.value,
        obligations: extraction.fields.obligations.value,
        employmentStart: extraction.fields.employmentStart.value,
        bureauScore: extraction.fields.bureauScore.value,
      },
      policy,
      dependencies.product,
      pricing,
    );
    steps.push('calculate_and_check_rules');
    // Canonical summary is code-filled: no model-generated numbers.
    const memo = `${result.recommendation}; ${policy.edition}; ${result.results.map((r) => `${r.rule}: ${r.result}`).join('; ')}${result.calculation ? `; EMI EGP ${result.calculation.monthlyInstallment}; DBR ${result.calculation.dbrPercent}%` : ''}`;
    steps.push('prepare_memo');
    return {
      ...base,
      ...result,
      extraction,
      memo,
      fraudReferral: false,
      status:
        result.recommendation === 'REFER_TO_HUMAN'
          ? ('pending_review' as const)
          : result.recommendation === 'OFFER_ALTERNATIVE'
            ? ('pending_customer_acceptance' as const)
            : ('pending_approval' as const),
    };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return {
      ...base,
      recommendation: 'REFER_TO_HUMAN' as const,
      reason: error.code,
      fraudReferral: error.code === 'SuspectedTampering',
      calculation: null,
      status: 'pending_review' as const,
    };
  }
}
