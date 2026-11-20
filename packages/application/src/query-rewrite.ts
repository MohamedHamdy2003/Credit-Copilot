import { MAX_QUERY_REWRITE_EXPANSIONS } from '../../contracts/src/config.js';

// Search aliases describe the same concepts as the source policies. The original
// question remains the only input for semantic retrieval and answer generation.
const glossary: readonly { match: RegExp; alias: string }[] = [
  { match: /\bdebt burden ratio\b/i, alias: 'DBR' },
  { match: /\bDBR\b/i, alias: 'debt burden ratio' },
  { match: /\bequated monthly instal[l]?ment\b/i, alias: 'EMI' },
  { match: /\bEMI\b/i, alias: 'equated monthly instalment' },
  { match: /\bloan duration\b|\brepayment period\b/i, alias: 'loan tenor' },
  { match: /\btenor\b/i, alias: 'loan duration' },
  { match: /\bminimum income\b/i, alias: 'income eligibility threshold' },
  { match: /\breason for (?:rejection|decline)\b/i, alias: 'written reasons' },
];

export function rewritePolicyQuery(
  question: string,
  budget: number,
): { query: string; expansions: string[] } | undefined {
  if (
    !question.trim() ||
    !Number.isInteger(budget) ||
    budget < 1 ||
    budget > MAX_QUERY_REWRITE_EXPANSIONS
  )
    return;
  const normalized = question.toLowerCase().replace(/\s+/g, ' ');
  const expansions: string[] = [];
  let query = question;
  for (const { match, alias } of glossary) {
    if (expansions.length === budget) break;
    if (!match.test(normalized) || normalized.includes(alias.toLowerCase())) continue;
    if (query.length + alias.length + 1 > 2000) continue;
    expansions.push(alias);
    query += ' ' + alias;
  }
  if (expansions.length) return { query, expansions };
}
