import { z } from 'zod';
import { affordability } from '../../domain/src/calculations.js';
import {
  selectPolicy,
  selectPricing,
  type Policy,
  type PricingRow,
  type Product,
} from '../../domain/src/policy.js';
import { invariant } from '../../domain/src/errors.js';

const schema = z
  .object({
    principal: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    income: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    obligations: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    months: z.number().int().positive(),
    date: z.string(),
    payroll: z.boolean().default(false),
  })
  .strict();
/** Structured numeric question; thresholds/rates never accepted from the caller. */
export function answerCalculationQuestion(
  raw: unknown,
  sources: { policies: Policy[]; pricing: PricingRow[]; product: Product },
) {
  const input = schema.parse(raw);
  const policy = selectPolicy(sources.policies, input.date);
  invariant(
    input.months >= sources.product.minimumMonths && input.months <= sources.product.maximumMonths,
    'InvalidCalculation',
    'Tenor exceeds product limits',
  );
  const rate = selectPricing(sources.pricing, input.date, input.months, input.payroll);
  return {
    policyEdition: policy.edition,
    maxDbr: policy.maxDbr,
    annualRatePercent: rate.annualRatePercent,
    calculation: affordability({
      principal: input.principal,
      income: input.income,
      obligations: input.obligations,
      months: input.months,
      annualRatePercent: rate.annualRatePercent,
      maxDbr: policy.maxDbr,
      productMaximum: sources.product.maximumAmount,
    }),
    citations: [
      { sourceFile: policy.sourceFile, section: 'CP-4.1' },
      { sourceFile: policy.sourceFile, section: 'CP-4.2' },
      { sourceFile: policy.sourceFile, section: 'CP-4.3' },
      { sourceFile: rate.sourceFile, row: rate.row },
    ],
    note: 'Calculation only; eligibility and human approval still required.',
  };
}
