import type { AssessmentResult } from './assessment-record.js';
import type { ApplicationForm } from './application-form.js';
/** Plain, stable source/calculate-filled summary. No free model prose or arithmetic. */
export function creditMemo(result: AssessmentResult, form?: ApplicationForm) {
  return [
    `${result.reference}: ${result.recommendation}; ${result.status}; ${result.policyEdition ?? 'Policy unresolved'}`,
    `Mode ${result.mode}; fully evidence verified: ${result.evidence.fullyEvidenceVerified}`,
    ...(form
      ? [
          `Requested EGP ${form.amount}; ${form.months} months; application date ${form.applicationDate}`,
        ]
      : []),
    ...(result.reason ? [`Referral reason: ${result.reason}`] : []),
    ...(result.evidence.missing.length
      ? [`Missing evidence: ${result.evidence.missing.join(', ')}`]
      : []),
    ...result.evidence.assumptions.map(
      (a) => `Assumption: ${a.reason}; actual ${a.actualEvidence}; verified=false`,
    ),
    ...(result.pricing
      ? [
          `Annual rate ${result.pricing.annualRatePercent}%; source ${result.pricing.sourceFile} row ${result.pricing.row}`,
        ]
      : []),
    ...(result.results ?? []).map((r) => `${r.citation}: ${r.result}; ${r.reason}`),
    ...(result.citations ?? result.evidence.referral?.citations ?? []).map((c) => `Source: ${c}`),
    ...(result.calculation
      ? [
          `EMI EGP ${result.calculation.monthlyInstallment}; DBR ${result.calculation.dbrPercent}%; maximum eligible EGP ${result.calculation.maximumEligibleAmount}`,
        ]
      : ['Affordability not calculated: unresolved evidence or eligibility.']),
    'Human decision required. This recommendation is not an issued offer.',
  ].join('\n');
}
