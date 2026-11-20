import { validDate } from './calculations.js';
import { invariant } from './errors.js';

export interface Policy {
  productId?: string;
  edition: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  maxDbr: string;
  minimumIncome: string;
  minimumEmploymentMonths: number;
  minimumAge: number;
  maximumAgeAtMaturity: number;
  minimumScore: number;
  sourceFile: string;
}
export interface Product {
  id: string;
  minimumAmount: string;
  maximumAmount: string;
  minimumMonths: number;
  maximumMonths: number;
  sourceFile: string;
  auto?: { minimumDownPaymentPercent: string };
}
export interface PricingRow {
  documentId: string;
  version: string;
  effectiveFrom: string;
  fromMonths: number;
  toMonths: number;
  segment: 'standard' | 'payroll_transfer';
  annualRatePercent: string;
  sourceFile: string;
  row: number;
}
export function selectPolicy(policies: readonly Policy[], date: string): Policy {
  validDate(date);
  const matches = policies.filter(
    (policy) => date >= policy.effectiveFrom && (!policy.effectiveTo || date < policy.effectiveTo),
  );
  invariant(matches.length > 0, 'PolicyEditionNotFound', 'No policy covers the application date');
  invariant(
    matches.length === 1,
    'AmbiguousPolicyEdition',
    'Multiple policies cover the application date',
  );
  return matches[0]!;
}
export function selectPricing(
  rows: readonly PricingRow[],
  date: string,
  months: number,
  payroll: boolean,
): PricingRow {
  validDate(date);
  const eligible = rows.filter(
    (row) =>
      row.effectiveFrom <= date &&
      row.segment === (payroll ? 'payroll_transfer' : 'standard') &&
      months >= row.fromMonths &&
      months <= row.toMonths,
  );
  const latest = eligible.reduce(
    (value, row) => (row.effectiveFrom > value ? row.effectiveFrom : value),
    '',
  );
  const matches = eligible.filter((row) => row.effectiveFrom === latest);
  invariant(
    matches.length === 1,
    'PricingNotFound',
    'Exactly one applicable pricing row is required',
  );
  return matches[0]!;
}
