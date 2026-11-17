import { readFileSync } from 'node:fs';
import {
  affordability,
  installment,
  addMonths,
  validDate,
} from '../packages/domain/src/calculations.js';
import { selectPolicy, type Policy } from '../packages/domain/src/policy.js';

const policies = JSON.parse(readFileSync('data/config/policies.json', 'utf8')) as Policy[];
const example = {
  principal: '300000',
  annualRatePercent: '24',
  months: 60,
  income: '30000',
  obligations: '4000',
  productMaximum: '1000000',
};
describe('source-authoritative decimal calculations', () => {
  it.each([
    ['2024-12-01', 'CP-2024', '382000.00'],
    ['2025-03-01', 'CP-2025', '330000.00'],
  ])('uses applicable rules on %s', (date, edition, expected) => {
    const policy = selectPolicy(policies, date);
    const result = affordability({ ...example, maxDbr: policy.maxDbr });
    expect(policy.edition).toBe(edition);
    expect(result.monthlyInstallment).toBe('8630.39');
    expect(result.dbr).toBe('0.421013');
    expect(result.dbrPercent).toBe('42.10');
    expect(result.maximumEligibleAmount).toBe(expected);
  });
  it('does not round DBR before comparing', () => {
    expect(
      affordability({
        ...example,
        principal: '9500.01',
        annualRatePercent: '0',
        months: 1,
        maxDbr: '0.45',
      }).passes,
    ).toBe(false);
    expect(
      affordability({
        ...example,
        principal: '9500',
        annualRatePercent: '0',
        months: 1,
        maxDbr: '0.45',
      }).passes,
    ).toBe(true);
  });
  it('handles the over-limit example without changing the formula', () => {
    const result = affordability({ ...example, principal: '350000', maxDbr: '0.45' });
    expect(result.monthlyInstallment).toBe('10068.79');
    expect(result.dbrPercent).toBe('46.90');
    expect(result.passes).toBe(false);
  });
  it('supports zero interest and half-up rounding', () => {
    expect(installment('100.005', '0', 1)).toBe('100.01');
    expect(installment('12000', '0', 12)).toBe('1000.00');
  });
  it('supports zero obligations and caps capacity by product', () => {
    expect(
      affordability({ ...example, obligations: '0', maxDbr: '0.45', productMaximum: '20000' })
        .maximumEligibleAmount,
    ).toBe('20000.00');
    expect(
      affordability({ ...example, obligations: '20000', maxDbr: '0.45' }).maximumEligibleAmount,
    ).toBe('0.00');
  });
  it.each([0, -1, 1.5])('rejects invalid tenor %s', (months) =>
    expect(() => installment('100', '24', months)).toThrow(),
  );
  it('rejects zero income and negative inputs', () => {
    expect(() => affordability({ ...example, income: '0', maxDbr: '0.45' })).toThrow();
    expect(() => installment('-1', '24', 12)).toThrow();
    expect(() => installment('1', '-1', 12)).toThrow();
  });
  it('clamps end-of-month dates and rejects impossible dates', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(() => validDate('2025-02-29')).toThrow();
  });
  it('does not apply a future or ambiguous policy', () => {
    expect(() => selectPolicy(policies, '2023-12-31')).toThrow();
    expect(selectPolicy(policies, '2025-02-28').edition).toBe('CP-2024');
    expect(() => selectPolicy([...policies, policies[1]!], '2025-04-01')).toThrow();
  });
});
