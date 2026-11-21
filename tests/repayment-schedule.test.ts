import {
  buildRepaymentSchedule,
  type RepaymentScheduleInput,
} from '../packages/domain/src/repayment-schedule.js';

const input: RepaymentScheduleInput = {
  principal: '300000.00',
  annualRatePercent: '24.00',
  months: 60,
  disbursementDate: '2025-04-03',
  administrativeFeePercent: '1',
};
const cents = (money: string) => BigInt(money.replace('.', ''));

it('reconciles every booked row and adjusts the final instalment to clear the approved principal', () => {
  const schedule = buildRepaymentSchedule(input);
  expect(schedule).toMatchObject({
    installment: '8630.39',
    administrativeFee: '3000.00',
    netDisbursement: '297000.00',
    totalInterest: '217823.42',
    totalRepayment: '517823.42',
  });
  expect(schedule.rows).toHaveLength(60);
  expect(schedule.rows[0]).toEqual({
    number: 1,
    dueDate: '2025-05-03',
    installment: '8630.39',
    principal: '2630.39',
    interest: '6000.00',
    balance: '297369.61',
  });
  expect(schedule.rows.slice(0, -1).every((row) => row.installment === schedule.installment)).toBe(
    true,
  );
  expect(schedule.rows.at(-1)).toMatchObject({
    number: 60,
    dueDate: '2030-04-03',
    installment: '8630.41',
    balance: '0.00',
  });

  let remaining = cents(input.principal);
  let interest = 0n;
  let paid = 0n;
  for (const row of schedule.rows) {
    expect(cents(row.interest)).toBe((remaining * 24n + 600n) / 1200n);
    expect(cents(row.principal) + cents(row.interest)).toBe(cents(row.installment));
    remaining -= cents(row.principal);
    interest += cents(row.interest);
    paid += cents(row.installment);
    expect(cents(row.balance)).toBe(remaining);
    expect(remaining).toBeGreaterThanOrEqual(0n);
  }
  expect(remaining).toBe(0n);
  expect(interest).toBe(cents(schedule.totalInterest));
  expect(paid).toBe(cents(schedule.totalRepayment));
  expect(paid).toBe(cents(input.principal) + interest);
});

it('anchors all dates to the disbursement day across short months and supports zero interest', () => {
  const schedule = buildRepaymentSchedule({
    ...input,
    principal: '1000.00',
    annualRatePercent: '0',
    months: 3,
    disbursementDate: '2024-01-31',
  });
  expect(schedule.totalInterest).toBe('0.00');
  expect(schedule.totalRepayment).toBe('1000.00');
  expect(schedule.rows.map((row) => [row.dueDate, row.installment, row.balance])).toEqual([
    ['2024-02-29', '333.33', '666.67'],
    ['2024-03-31', '333.33', '333.34'],
    ['2024-04-30', '333.34', '0.00'],
  ]);
});

it('rounds interest and the upfront fee half up at half a cent', () => {
  const schedule = buildRepaymentSchedule({
    ...input,
    principal: '1.00',
    annualRatePercent: '6',
    administrativeFeePercent: '0.5',
    months: 2,
  });
  expect(schedule).toMatchObject({
    administrativeFee: '0.01',
    netDisbursement: '0.99',
    totalInterest: '0.01',
    totalRepayment: '1.01',
  });
  expect(schedule.rows.map((row) => row.installment)).toEqual(['0.50', '0.51']);
});

it('caps rounded payments once a tiny principal is paid off', () => {
  const schedule = buildRepaymentSchedule({
    ...input,
    principal: '0.02',
    annualRatePercent: '0',
    months: 3,
  });
  expect(schedule.rows.map((row) => row.installment)).toEqual(['0.01', '0.01', '0.00']);
  expect(schedule.totalRepayment).toBe('0.02');
});

it.each<Partial<RepaymentScheduleInput>>([
  { principal: '0' },
  { principal: '1.005' },
  { annualRatePercent: '-1' },
  { administrativeFeePercent: '101' },
  { administrativeFeePercent: 'not-a-rate' },
  { months: 0 },
  { disbursementDate: '2025-02-29' },
  { disbursementDate: '9999-12-31' },
])('rejects invalid schedule inputs %j', (invalid) => {
  expect(() => buildRepaymentSchedule({ ...input, ...invalid })).toThrow();
});
