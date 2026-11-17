import { readFile } from 'node:fs/promises';
import { answerCalculationQuestion } from '../packages/application/src/calculation-question.js';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { extractPricing } from '../packages/infrastructure/src/parsers/pricing.js';
import type { Policy, Product, PricingRow } from '../packages/domain/src/policy.js';
let sources: { policies: Policy[]; product: Product; pricing: PricingRow[] };
beforeAll(async () => {
  sources = {
    policies: JSON.parse(await readFile('data/config/policies.json', 'utf8')),
    product: JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')),
    pricing: extractPricing(
      await new ParserRegistry().extract(
        'pricing-table.csv',
        await readFile('data/corpus/policy/pricing-table.csv'),
      ),
    ),
  };
});
const input = {
  principal: '300000',
  income: '30000',
  obligations: '4000',
  months: 60,
  date: '2025-04-03',
};
it('routes a numeric question to pure code with policy and CSV citations', () => {
  const result = answerCalculationQuestion(input, sources);
  expect(result.calculation.maximumEligibleAmount).toBe('330000.00');
  expect(result.citations).toHaveLength(4);
  expect(
    answerCalculationQuestion({ ...input, date: '2024-12-01' }, sources).calculation
      .maximumEligibleAmount,
  ).toBe('382000.00');
});
it('rejects attempts to override policy or price and unsupported tenors', () => {
  expect(() => answerCalculationQuestion({ ...input, maxDbr: '0.9' }, sources)).toThrow();
  expect(() => answerCalculationQuestion({ ...input, months: 72 }, sources)).toThrow();
});
