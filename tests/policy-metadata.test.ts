import { readFile } from 'node:fs/promises';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import {
  extractPolicyMetadataFromDocument,
  parsePolicyHeaderDate,
} from '../packages/infrastructure/src/knowledge/policy-metadata.js';

describe('server-side policy header metadata extraction', () => {
  const parsers = new ParserRegistry();

  it('parses ISO and English calendar header dates cleanly', () => {
    expect(parsePolicyHeaderDate('2026-01-15')).toBe('2026-01-15');
    expect(parsePolicyHeaderDate('1 March 2025')).toBe('2025-03-01');
    expect(parsePolicyHeaderDate('3 July 2024')).toBe('2024-07-03');
    expect(parsePolicyHeaderDate('March 1, 2025')).toBe('2025-03-01');
    expect(parsePolicyHeaderDate('2025-02-31')).toBeNull();
    expect(parsePolicyHeaderDate('not a date')).toBeNull();
  });

  it('extracts metadata from real PDF, Markdown, and CSV policy documents', async () => {
    const cases: {
      filename: string;
      expected: {
        id: string;
        edition: string;
        effectiveFrom: string;
        effectiveTo?: string;
        product?: 'PL-100' | 'AL-200';
        kind: string;
      };
    }[] = [
      {
        filename: 'credit-policy-2024.pdf',
        expected: {
          id: 'CP-2024',
          edition: 'CP-2024',
          effectiveFrom: '2024-01-01',
          effectiveTo: '2025-03-01',
          product: 'PL-100',
          kind: 'policy',
        },
      },
      {
        filename: 'credit-policy-2025.pdf',
        expected: {
          id: 'CP-2025',
          edition: 'CP-2025',
          effectiveFrom: '2025-03-01',
          product: 'PL-100',
          kind: 'policy',
        },
      },
      {
        filename: 'credit-procedures-manual (1).pdf',
        expected: {
          id: 'PM-CC-2025',
          edition: '4.0',
          effectiveFrom: '2025-03-01',
          kind: 'procedure',
        },
      },
      {
        filename: 'product-sheet-personal-loan.md',
        expected: {
          id: 'PS-PL-100',
          edition: '3.1',
          effectiveFrom: '2024-01-01',
          product: 'PL-100',
          kind: 'product',
        },
      },
      {
        filename: 'circular-2025-02.md',
        expected: {
          id: 'C-2025-02',
          edition: '2025/02',
          effectiveFrom: '2025-03-01',
          kind: 'circular',
        },
      },
      {
        filename: 'circular-2024-07.md',
        expected: {
          id: 'C-2024-07',
          edition: '2024/07',
          effectiveFrom: '2024-07-03',
          effectiveTo: '2025-03-01',
          kind: 'circular',
        },
      },
      {
        filename: 'pricing-table.csv',
        expected: {
          id: 'PT-2025-01',
          edition: '1.0',
          effectiveFrom: '2024-01-01',
          kind: 'pricing',
        },
      },
      {
        filename: 'synthetic-auto-policy-2025.md',
        expected: {
          id: 'AUTO-2025',
          edition: 'AUTO-2025',
          effectiveFrom: '2025-03-01',
          product: 'AL-200',
          kind: 'policy',
        },
      },
      {
        filename: 'synthetic-auto-product.md',
        expected: {
          id: 'PS-AL-200',
          edition: '1.0',
          effectiveFrom: '2025-03-01',
          product: 'AL-200',
          kind: 'product',
        },
      },
      {
        filename: 'synthetic-auto-procedure.md',
        expected: {
          id: 'PM-AL-200',
          edition: '1.0',
          effectiveFrom: '2025-03-01',
          product: 'AL-200',
          kind: 'procedure',
        },
      },
      {
        filename: 'synthetic-auto-pricing.csv',
        expected: {
          id: 'PT-AL-200',
          edition: '1.0',
          effectiveFrom: '2025-03-01',
          product: 'AL-200',
          kind: 'pricing',
        },
      },
    ];

    for (const item of cases) {
      const bytes = await readFile(`data/corpus/policy/${item.filename}`);
      const doc = await parsers.extract(item.filename, bytes);
      const extracted = extractPolicyMetadataFromDocument(item.filename, doc);
      expect(extracted).toEqual(item.expected);
    }
  });

  it('extracts metadata from a brand-new custom policy header and leaves headerless files incomplete', async () => {
    const withHeader = await parsers.extract(
      'credit-policy-2026.md',
      Buffer.from(
        [
          '# Credit Policy — Personal Loans (PL-100)',
          '**Document ID:** CP-2026 | **Edition:** 2026 | **Effective from:** 1 January 2026 | **Effective to:** 31 December 2026',
          '',
          '## CP-99. Special Rule',
          'All digital applications require verified payroll.',
        ].join('\n'),
      ),
    );
    expect(extractPolicyMetadataFromDocument('credit-policy-2026.md', withHeader)).toEqual({
      id: 'CP-2026',
      edition: 'CP-2026',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      product: 'PL-100',
      kind: 'policy',
    });

    const headerless = await parsers.extract(
      'untagged-note.md',
      Buffer.from('# Random Note\n\nNo edition or effective date anywhere here.\n'),
    );
    const extracted = extractPolicyMetadataFromDocument('untagged-note.md', headerless);
    expect(extracted.edition).toBeUndefined();
    expect(extracted.effectiveFrom).toBeUndefined();
  });
});
