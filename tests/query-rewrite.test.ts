import { rewritePolicyQuery } from '../packages/application/src/query-rewrite.js';

it('appends a fixed alias to the original question, preserving its references and negation', () => {
  const question = 'For PL-100 on 2025-04-01, show the EMI. Do not use CP-2024.';
  expect(rewritePolicyQuery(question, 2)).toEqual({
    query: question + ' equated monthly instalment',
    expansions: ['equated monthly instalment'],
  });
});

it('respects the alias budget and skips a term already present', () => {
  const question = 'What are the DBR and EMI for the loan duration?';
  expect(rewritePolicyQuery(question, 1)?.expansions).toEqual(['debt burden ratio']);
  expect(rewritePolicyQuery(question, 2)?.expansions).toEqual([
    'debt burden ratio',
    'equated monthly instalment',
  ]);
  expect(rewritePolicyQuery('DBR (debt burden ratio)', 4)).toBeUndefined();
});

it('falls back for disabled or invalid budgets, unknown wording, and a full-length question', () => {
  expect(rewritePolicyQuery('Minimum income?', 0)).toBeUndefined();
  expect(rewritePolicyQuery('Minimum income?', 1.5)).toBeUndefined();
  expect(rewritePolicyQuery('Minimum income?', 5)).toBeUndefined();
  expect(rewritePolicyQuery('   ', 2)).toBeUndefined();
  expect(rewritePolicyQuery('What are the crypto fees?', 2)).toBeUndefined();
  expect(rewritePolicyQuery('DBR ' + 'x'.repeat(1996), 2)).toBeUndefined();
});
