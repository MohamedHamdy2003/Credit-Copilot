import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { affordability } from '../packages/domain/src/calculations.js';
import { selectPolicy, selectPricing, type Policy } from '../packages/domain/src/policy.js';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { extractPricing } from '../packages/infrastructure/src/parsers/pricing.js';
const input = z
  .object({
    principal: z.string(),
    income: z.string(),
    obligations: z.string(),
    months: z.number().int().positive(),
    date: z.string(),
    payroll: z.boolean().default(false),
  })
  .strict()
  .parse(JSON.parse(await readFile(process.argv[2] ?? 'data/config/calculation-example.json', 'utf8')));
const policies = JSON.parse(await readFile('data/config/policies.json', 'utf8')) as Policy[];
const product = JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')) as {
  maximumAmount: string;
};
const rows = extractPricing(
  await new ParserRegistry().extract(
    'pricing-table.csv',
    await readFile('data/corpus/policy/pricing-table.csv'),
  ),
);
const policy = selectPolicy(policies, input.date);
const price = selectPricing(rows, input.date, input.months, input.payroll);
console.log(
  JSON.stringify(
    {
      policyEdition: policy.edition,
      maxDbr: policy.maxDbr,
      annualRatePercent: price.annualRatePercent,
      pricingSource: { file: price.sourceFile, row: price.row },
      ...affordability({
        principal: input.principal,
        income: input.income,
        obligations: input.obligations,
        months: input.months,
        annualRatePercent: price.annualRatePercent,
        maxDbr: policy.maxDbr,
        productMaximum: product.maximumAmount,
      }),
      note: 'Financial calculation only, not a complete eligibility assessment or issued offer.',
    },
    null,
    2,
  ),
);
