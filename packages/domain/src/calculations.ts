import { Decimal } from 'decimal.js';
import { DomainError, invariant } from './errors.js';

// Isolated decimal context: another module cannot change lending precision/rounding.
const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
export type Money = string;

function nonnegative(value: Money, field: string) {
  let parsed: Decimal;
  try {
    parsed = new D(value);
  } catch {
    throw new DomainError('InvalidCalculation', `Invalid decimal: ${field}`);
  }
  invariant(
    parsed.isFinite() && parsed.gte(0),
    'InvalidCalculation',
    `${field} must be finite and nonnegative`,
  );
  return parsed;
}

function factor(annualRatePercent: Money, months: number) {
  invariant(
    Number.isInteger(months) && months >= 1 && months <= 1200,
    'InvalidCalculation',
    'Tenor must be an integer from 1 to 1200',
  );
  const rate = nonnegative(annualRatePercent, 'annualRatePercent').div(1200);
  return rate.isZero()
    ? new D(1).div(months)
    : rate.div(new D(1).minus(new D(1).plus(rate).pow(-months)));
}

export function installment(principal: Money, annualRatePercent: Money, months: number): Money {
  return nonnegative(principal, 'principal').mul(factor(annualRatePercent, months)).toFixed(2);
}

export function affordability(input: {
  principal: Money;
  annualRatePercent: Money;
  months: number;
  income: Money;
  obligations: Money;
  maxDbr: Money;
  productMaximum: Money;
}) {
  const income = nonnegative(input.income, 'income');
  invariant(income.gt(0), 'InvalidCalculation', 'Income must be greater than zero');
  const obligations = nonnegative(input.obligations, 'obligations');
  const limit = nonnegative(input.maxDbr, 'maxDbr');
  invariant(limit.lte(1), 'InvalidCalculation', 'DBR limit cannot exceed one');
  const emi = installment(input.principal, input.annualRatePercent, input.months);
  const numerator = obligations.plus(emi);
  const cap = D.max(0, income.mul(limit).minus(obligations));
  const capacity = D.min(
    cap.div(factor(input.annualRatePercent, input.months)),
    nonnegative(input.productMaximum, 'productMaximum'),
  );
  let maximum = capacity.div(1000).floor().mul(1000);
  // Check contractual cent rounding after flooring the inverse formula.
  while (
    maximum.gt(0) &&
    new D(installment(maximum.toString(), input.annualRatePercent, input.months)).gt(cap)
  )
    maximum = maximum.minus(1000);
  return {
    monthlyInstallment: emi,
    dbr: numerator.div(income).toString(),
    dbrNumerator: numerator.toFixed(2),
    dbrDenominator: income.toFixed(2),
    dbrPercent: numerator.div(income).mul(100).toFixed(2),
    passes: numerator.lte(income.mul(limit)),
    maximumEligibleAmount: maximum.toFixed(2),
    installmentCap: cap.toFixed(2),
  };
}

export function compareMoney(a: Money, b: Money): number {
  return new D(a).comparedTo(new D(b));
}

export function validDate(value: string): string {
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(value), 'InvalidDate', 'Expected ISO calendar date');
  const parsed = new Date(`${value}T00:00:00Z`);
  invariant(
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value,
    'InvalidDate',
    `Invalid calendar date: ${value}`,
  );
  return value;
}

export function addMonths(value: string, months: number): string {
  validDate(value);
  invariant(Number.isInteger(months), 'InvalidDate', 'Month offset must be an integer');
  const date = new Date(`${value}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, end));
  return date.toISOString().slice(0, 10);
}

export function daysBetween(earlier: string, later: string): number {
  return (Date.parse(validDate(later)) - Date.parse(validDate(earlier))) / 86400000;
}
