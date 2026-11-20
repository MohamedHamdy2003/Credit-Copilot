import { readFileSync } from 'node:fs';
import { assessRules, type ApplicantFacts } from '../packages/domain/src/rules.js';
import type { Policy, Product, PricingRow } from '../packages/domain/src/policy.js';
const policy = (JSON.parse(readFileSync('data/config/policies.json', 'utf8')) as Policy[])[1]!;
const product = JSON.parse(readFileSync('data/config/personal-loan.json', 'utf8')) as Product;
const pricing: PricingRow = {
  documentId: 'PT-2025-01',
  version: '1',
  effectiveFrom: '2024-01-01',
  fromMonths: 37,
  toMonths: 60,
  segment: 'standard',
  annualRatePercent: '24',
  sourceFile: 'pricing-table.csv',
  row: 3,
};
const facts: ApplicantFacts = {
  applicationDate: '2025-04-03',
  birthDate: '1987-04-12',
  employmentStart: '2019-09-01',
  certificateDate: '2025-03-28',
  income: '30000',
  obligations: '4000',
  bureauScore: 712,
  confirmed: true,
  hasDefault: false,
  bankEmployee: false,
  purposeAllowed: true,
  amount: '300000',
  months: 60,
  plannedDisbursement: '2025-04-03',
};
describe('eligibility before affordability', () => {
  it('recommends approval for an eligible complete case', () =>
    expect(assessRules(facts, policy, product, pricing).recommendation).toBe('APPROVE'));
  it('refers low score without calculating affordability', () => {
    const result = assessRules({ ...facts, bureauScore: 580 }, policy, product, pricing);
    expect(result.recommendation).toBe('REFER_TO_HUMAN');
    expect(result.calculation).toBeNull();
  });
  it('declines a documented default even when the bureau score also needs review', () => {
    const result = assessRules(
      { ...facts, bureauScore: 580, hasDefault: true },
      policy,
      product,
      pricing,
    );
    expect(result.recommendation).toBe('DECLINE');
    expect(result.results).toContainEqual(
      expect.objectContaining({ rule: 'CP-6 default', result: 'fail' }),
    );
  });
  it('resolves the verified product-tenor failure without looking up an inapplicable rate', () => {
    const result = assessRules({ ...facts, months: 84 }, policy, product, () => {
      throw new Error('Pricing should only be selected after eligibility passes');
    });
    expect(result.recommendation).toBe('DECLINE');
    expect(result.results).toContainEqual(
      expect.objectContaining({ rule: 'PS-3', result: 'fail' }),
    );
  });
  it('declines over-age and default cases without affordability', () => {
    expect(
      assessRules({ ...facts, birthDate: '1968-06-20' }, policy, product, pricing).recommendation,
    ).toBe('DECLINE');
    expect(
      assessRules({ ...facts, hasDefault: true }, policy, product, pricing).calculation,
    ).toBeNull();
  });
  it('allows maturity exactly at 60 but not one day after', () => {
    expect(
      assessRules({ ...facts, birthDate: '1970-04-03' }, policy, product, pricing).recommendation,
    ).toBe('APPROVE');
    expect(
      assessRules({ ...facts, birthDate: '1970-04-02' }, policy, product, pricing).recommendation,
    ).toBe('DECLINE');
  });
  it('refers uncertain probation in either operating mode', () =>
    expect(
      assessRules({ ...facts, confirmed: null }, policy, product, pricing).recommendation,
    ).toBe('REFER_TO_HUMAN'));
  it('offers affordable alternative rather than silently declining', () => {
    const result = assessRules({ ...facts, amount: '350000' }, policy, product, pricing);
    expect(result.recommendation).toBe('OFFER_ALTERNATIVE');
    expect(result.recommendedAmount).toBe('330000.00');
  });
  it.each(['20000', '1000000'])(
    'accepts product amount boundary %s independently of affordability',
    (amount) =>
      expect(
        assessRules({ ...facts, amount }, policy, product, pricing).results.find(
          (r) => r.rule === 'PS-3',
        )?.result,
      ).toBe('pass'),
  );
});
