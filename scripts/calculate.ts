import { readFile } from 'node:fs/promises';
import { answerCalculationQuestion } from '../packages/application/src/calculation-question.js';
import type { Policy, Product } from '../packages/domain/src/policy.js';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { extractPricing } from '../packages/infrastructure/src/parsers/pricing.js';
const input: unknown = JSON.parse(
  await readFile(process.argv[2] ?? 'data/config/calculation-example.json', 'utf8'),
);
const policies = JSON.parse(await readFile('data/config/policies.json', 'utf8')) as Policy[];
const product = JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')) as Product;
const pricing = extractPricing(
  await new ParserRegistry().extract(
    'pricing-table.csv',
    await readFile('data/corpus/policy/pricing-table.csv'),
  ),
);
console.log(
  JSON.stringify(answerCalculationQuestion(input, { policies, product, pricing }), null, 2),
);
