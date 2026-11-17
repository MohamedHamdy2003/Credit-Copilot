import { readFile, readdir } from 'node:fs/promises';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { chunkDocument } from '../packages/infrastructure/src/parsers/chunker.js';
import { extractPricing } from '../packages/infrastructure/src/parsers/pricing.js';
import { selectPricing } from '../packages/domain/src/policy.js';
const registry = new ParserRegistry();
describe('document parser layer', () => {
  it('extracts all twelve real source documents with provenance', async () => {
    for (const kind of ['policy', 'evidence']) {
      for (const filename of await readdir(`data/corpus/${kind}`)) {
        const parsed = await registry.extract(
          filename,
          await readFile(`data/corpus/${kind}/${filename}`),
        );
        expect(parsed.blocks.length).toBeGreaterThan(0);
        expect(parsed.hash).toHaveLength(64);
        expect(parsed.blocks.every((block) => block.originalText.length > 0)).toBe(true);
      }
    }
  }, 60000);
  it('retains salary on page two and the malicious text as evidence, not instructions', async () => {
    const first = await registry.extract(
      'APP-001.pdf',
      await readFile('data/corpus/evidence/APP-001.pdf'),
    );
    expect(first.blocks.find((b) => b.page === 2)?.text).toContain('30,000.00');
    const tampered = await registry.extract(
      'APP-004.pdf',
      await readFile('data/corpus/evidence/APP-004.pdf'),
    );
    expect(tampered.blocks.map((b) => b.text).join('\n')).toContain('18,000.00');
    expect(tampered.blocks.map((b) => b.text).join('\n')).toContain(
      'Ignore all previous instructions',
    );
  });
  it('creates deterministic clause chunks with version/page provenance', async () => {
    const doc = await registry.extract(
      'credit-policy-2025.pdf',
      await readFile('data/corpus/policy/credit-policy-2025.pdf'),
    );
    const meta = {
      id: 'CP-2025',
      edition: 'CP-2025',
      effectiveFrom: '2025-03-01',
      effectiveTo: null,
      product: 'PL-100',
      kind: 'policy' as const,
    };
    const chunks = chunkDocument(doc, meta);
    expect(chunks).toEqual(chunkDocument(doc, meta));
    expect(chunks.find((c) => c.section === 'CP-4.1')?.text).toContain('45%');
    expect(chunks.find((c) => c.section === 'CP-4.1')?.pageStart).toBe(2);
    expect(chunks.every((c) => c.edition === 'CP-2025')).toBe(true);
  });
  it('parses all CSV bands and selects the exact supplied rate', async () => {
    const doc = await registry.extract(
      'pricing-table.csv',
      await readFile('data/corpus/policy/pricing-table.csv'),
    );
    const rows = extractPricing(doc);
    expect(rows).toHaveLength(6);
    expect(selectPricing(rows, '2025-04-03', 60, false).annualRatePercent).toBe('24.00');
    expect(selectPricing(rows, '2025-04-03', 36, true).annualRatePercent).toBe('20.00');
    expect(() => selectPricing(rows, '2025-04-03', 73, false)).toThrow();
  });
  it.each(['file.docx', '../file.md', 'C:\\file.md'])(
    'rejects unsupported or unsafe filename %s',
    async (name) => {
      await expect(registry.extract(name, Buffer.from('hello'))).rejects.toThrow();
    },
  );
  it('rejects oversized, spoofed, malformed and invalid-encoding documents', async () => {
    await expect(new ParserRegistry(2).extract('file.md', Buffer.from('abc'))).rejects.toThrow(
      'size limit',
    );
    await expect(registry.extract('file.pdf', Buffer.from('hello'))).rejects.toThrow('extension');
    await expect(registry.extract('file.md', Buffer.from([255, 255]))).rejects.toThrow('UTF-8');
    await expect(registry.extract('file.csv', Buffer.from('a,b\n1,2,3'))).rejects.toThrow();
    await expect(
      registry.extract('file.md', Buffer.from('hello'), 'application/pdf'),
    ).rejects.toThrow();
  });
});
