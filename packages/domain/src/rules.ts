import { addMonths, affordability, compareMoney, daysBetween } from './calculations.js';
import type { Policy, Product, PricingRow } from './policy.js';

export interface ApplicantFacts {
  applicationDate: string;
  birthDate: string;
  employmentStart: string;
  certificateDate: string;
  income: string;
  obligations: string;
  bureauScore: number;
  confirmed: boolean | null;
  hasDefault: boolean;
  bankEmployee: boolean;
  purposeAllowed: boolean;
  amount: string;
  months: number;
  plannedDisbursement: string;
}
export interface RuleResult {
  rule: string;
  result: 'pass' | 'fail' | 'refer';
  citation: string;
  reason: string;
}
export function assessRules(
  facts: ApplicantFacts,
  policy: Policy,
  product: Product,
  pricing: PricingRow,
) {
  const results: RuleResult[] = [];
  const check = (rule: string, passes: boolean, reason: string, referral = false) =>
    results.push({
      rule,
      result: passes ? 'pass' : referral ? 'refer' : 'fail',
      citation: `${policy.edition} ${rule}`,
      reason,
    });
  check(
    'CP-3.1',
    facts.confirmed === true,
    'Confirmed employment and completed probation required',
    facts.confirmed === null,
  );
  check(
    'CP-3.2',
    addMonths(facts.employmentStart, policy.minimumEmploymentMonths) <= facts.applicationDate,
    'Minimum completed employment duration',
  );
  check('CP-3.3', compareMoney(facts.income, policy.minimumIncome) >= 0, 'Minimum net income');
  check(
    'CP-3.4',
    addMonths(facts.birthDate, policy.minimumAge * 12) <= facts.applicationDate,
    'Minimum application age',
  );
  check(
    'CP-3.5',
    addMonths(facts.plannedDisbursement, facts.months) <=
      addMonths(facts.birthDate, policy.maximumAgeAtMaturity * 12),
    'Final instalment on or before maximum-age birthday',
  );
  check(
    'CP-6',
    facts.bureauScore >= policy.minimumScore,
    'Below minimum score requires human review',
    true,
  );
  check('CP-6 default', !facts.hasDefault, 'A facility in default prohibits approval');
  check('CP-8', !facts.bankEmployee, 'Bank employees require referral', true);
  const age = daysBetween(facts.certificateDate, facts.applicationDate);
  check(
    'CP-5',
    age >= 0 && age <= 60,
    'Salary certificate must be issued within preceding 60 days',
    true,
  );
  check('CP-11', facts.purposeAllowed, 'Prohibited purposes are not eligible');
  results.push({
    rule: 'PS-3',
    citation: `${product.sourceFile} PS-3`,
    result:
      compareMoney(facts.amount, product.minimumAmount) >= 0 &&
      compareMoney(facts.amount, product.maximumAmount) <= 0 &&
      facts.months >= product.minimumMonths &&
      facts.months <= product.maximumMonths
        ? 'pass'
        : 'fail',
    reason: 'Product amount and tenor limits',
  });
  if (results.some((r) => r.result !== 'pass')) {
    return {
      recommendation: results.some((r) => r.result === 'refer')
        ? ('REFER_TO_HUMAN' as const)
        : ('DECLINE' as const),
      results,
      calculation: null,
      recommendedAmount: null,
    };
  }
  const calculation = affordability({
    principal: facts.amount,
    annualRatePercent: pricing.annualRatePercent,
    months: facts.months,
    income: facts.income,
    obligations: facts.obligations,
    maxDbr: policy.maxDbr,
    productMaximum: product.maximumAmount,
  });
  results.push({
    rule: 'CP-4.1',
    citation: `${policy.edition} CP-4.1`,
    result: calculation.passes ? 'pass' : 'fail',
    reason: 'Exact debt burden compared against applicable policy limit',
  });
  const validAlternative =
    compareMoney(calculation.maximumEligibleAmount, product.minimumAmount) >= 0;
  return {
    recommendation: calculation.passes
      ? ('APPROVE' as const)
      : validAlternative
        ? ('OFFER_ALTERNATIVE' as const)
        : ('REFER_TO_HUMAN' as const),
    results,
    calculation,
    recommendedAmount: calculation.passes
      ? facts.amount
      : validAlternative
        ? calculation.maximumEligibleAmount
        : null,
  };
}
