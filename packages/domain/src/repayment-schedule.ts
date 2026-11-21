import { Decimal } from 'decimal.js';
import { addMonths, installment, validDate, type Money } from './calculations.js';
import { DomainError, invariant } from './errors.js';

const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

export interface RepaymentScheduleInput {
  principal: Money;
  annualRatePercent: string;
  months: number;
  disbursementDate: string;
  administrativeFeePercent: string;
}

export interface RepaymentScheduleRow {
  number: number;
  dueDate: string;
  installment: Money;
  principal: Money;
  interest: Money;
  balance: Money;
}

export interface RepaymentSchedule {
  installment: Money;
  administrativeFee: Money;
  netDisbursement: Money;
  totalInterest: Money;
  totalRepayment: Money;
  rows: RepaymentScheduleRow[];
}

function parseFeePercent(value: string) {
  let fee: Decimal;
  try {
    fee = new D(value);
  } catch {
    throw new DomainError('InvalidCalculation', 'Invalid administrative fee percentage');
  }
  invariant(
    fee.isFinite() && fee.gte(0) && fee.lte(100),
    'InvalidCalculation',
    'Administrative fee percentage must be between 0 and 100',
  );
  return fee;
}

export function buildRepaymentSchedule(input: RepaymentScheduleInput): RepaymentSchedule {
  const payment = installment(input.principal, input.annualRatePercent, input.months);
  const principal = new D(input.principal);
  invariant(
    principal.gt(0) && principal.decimalPlaces() <= 2,
    'InvalidCalculation',
    'Approved principal must be a positive amount with cent precision',
  );
  validDate(addMonths(input.disbursementDate, input.months));
  const scheduledPayment = new D(payment);
  const monthlyRate = new D(input.annualRatePercent).div(1200);
  const fee = principal
    .mul(parseFeePercent(input.administrativeFeePercent))
    .div(100)
    .toDecimalPlaces(2);
  const rows: RepaymentScheduleRow[] = [];
  let balance = principal;
  let totalInterest = new D(0);

  for (let number = 1; number <= input.months; number++) {
    const interest = balance.mul(monthlyRate).toDecimalPlaces(2);
    // Adjust the final principal for accumulated cent rounding. Cap earlier principal
    // as well so a very small loan cannot overpay after rounding its regular payment.
    const repaid =
      number === input.months
        ? balance
        : D.min(balance, D.max(0, scheduledPayment.minus(interest)));
    balance = balance.minus(repaid);
    totalInterest = totalInterest.plus(interest);
    rows.push({
      number,
      dueDate: addMonths(input.disbursementDate, number),
      installment: repaid.plus(interest).toFixed(2),
      principal: repaid.toFixed(2),
      interest: interest.toFixed(2),
      balance: balance.toFixed(2),
    });
  }

  return {
    installment: payment,
    administrativeFee: fee.toFixed(2),
    netDisbursement: principal.minus(fee).toFixed(2),
    totalInterest: totalInterest.toFixed(2),
    totalRepayment: principal.plus(totalInterest).toFixed(2),
    rows,
  };
}
