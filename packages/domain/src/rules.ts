import {
  addMonths,
  affordability,
  calculateVehicleFunding,
  compareMoney,
  daysBetween,
} from './calculations.js';
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
  vehiclePrice?: string;
  downPayment?: string;
}
export interface RuleResult {
  rule: string;
  result: 'pass' | 'fail' | 'refer';
  citation: string;
  reason: string;
}

export interface AutoFinance {
  vehiclePrice: string;
  downPayment: string;
  financedAmount: string;
  minimumDownPaymentPercent: string;
}

export function assessRules(
  facts: ApplicantFacts,
  policy: Policy,
  product: Product,
  price: PricingRow | (() => PricingRow),
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
  let autoFinance: AutoFinance | undefined;
  let financingAmount = facts.amount;
  let financingMaximum = product.maximumAmount;
  if (product.auto) {
    const { minimumDownPaymentPercent } = product.auto;
    const autoCheck = (result: RuleResult['result'], reason: string) =>
      results.push({ rule: 'PS-9', citation: `${product.sourceFile} PS-9`, result, reason });
    if (facts.vehiclePrice === undefined || facts.downPayment === undefined) {
      autoCheck('refer', 'Vehicle price and down payment require evidence');
    } else {
      const funding = calculateVehicleFunding(
        facts.vehiclePrice,
        facts.downPayment,
        minimumDownPaymentPercent,
        product.maximumAmount,
      );
      if (!funding) {
        autoCheck('fail', 'Vehicle price and resulting finance amount must be positive');
      } else {
        financingAmount = funding.financedAmount;
        financingMaximum = funding.maximumPrincipal;
        autoFinance = {
          vehiclePrice: funding.vehiclePrice,
          downPayment: funding.downPayment,
          financedAmount: financingAmount,
          minimumDownPaymentPercent,
        };
        if (compareMoney(financingAmount, facts.amount) !== 0) {
          autoCheck('refer', 'Requested amount disagrees with the vehicle price less down payment');
        } else {
          autoCheck(
            funding.meetsMinimum ? 'pass' : 'fail',
            `Evidence must show a down payment of at least ${minimumDownPaymentPercent}% of vehicle price`,
          );
        }
      }
    }
  }
  const finance = autoFinance ? { autoFinance } : {};
  results.push({
    rule: 'PS-3',
    citation: `${product.sourceFile} PS-3`,
    result:
      compareMoney(financingAmount, product.minimumAmount) >= 0 &&
      compareMoney(financingAmount, product.maximumAmount) <= 0 &&
      facts.months >= product.minimumMonths &&
      facts.months <= product.maximumMonths
        ? 'pass'
        : 'fail',
    reason: 'Product amount and tenor limits',
  });
  if (results.some((r) => r.result !== 'pass')) {
    // Under CP-8, any failed mandatory eligibility or product criterion requires DECLINE;
    // REFER_TO_HUMAN applies only when no mandatory criterion failed.
    const mandatoryDecline = results.some((r) => r.result === 'fail');
    return {
      recommendation: mandatoryDecline ? ('DECLINE' as const) : ('REFER_TO_HUMAN' as const),
      results,
      calculation: null,
      recommendedAmount: null,
      ...finance,
    };
  }
  const pricing = typeof price === 'function' ? price() : price;
  const calculation = affordability({
    principal: financingAmount,
    annualRatePercent: pricing.annualRatePercent,
    months: facts.months,
    income: facts.income,
    obligations: facts.obligations,
    maxDbr: policy.maxDbr,
    productMaximum: financingMaximum,
  });
  results.push({
    rule: 'CP-4.1',
    citation: `${policy.edition} CP-4.1`,
    result: calculation.passes ? 'pass' : 'fail',
    reason:
      product.auto && !calculation.passes
        ? 'Debt burden exceeds the policy limit. Review a revised down payment with verified evidence'
        : 'Exact debt burden compared against applicable policy limit',
  });
  const validAlternative =
    !product.auto && compareMoney(calculation.maximumEligibleAmount, product.minimumAmount) >= 0;
  return {
    recommendation: calculation.passes
      ? ('APPROVE' as const)
      : validAlternative
        ? ('OFFER_ALTERNATIVE' as const)
        : ('REFER_TO_HUMAN' as const),
    results,
    calculation,
    recommendedAmount: calculation.passes
      ? financingAmount
      : validAlternative
        ? calculation.maximumEligibleAmount
        : null,
    pricing,
    ...finance,
  };
}
