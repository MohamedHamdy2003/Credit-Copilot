import { readFile } from 'node:fs/promises';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { extractVerified, sanitizeEvidence } from '../packages/application/src/extraction.js';
import { FakeGeneration } from './helpers/fake-provider.js';
const value = {
  income: { value: '30000.00', quote: 'Net monthly income 30,000.00', section: 'salary' },
  obligations: { value: '4000.00', quote: 'Total monthly instalments 4,000.00', section: 'bureau' },
  employmentStart: {
    value: '2019-09-01',
    quote: 'Employment start 1 September 2019',
    section: 'salary',
  },
  bureauScore: { value: 712, quote: 'Bureau score 712', section: 'bureau' },
};
const load = async (id: string) =>
  new ParserRegistry().extract(`${id}.pdf`, await readFile(`data/corpus/evidence/${id}.pdf`));
it('verifies structured extraction against actual labeled source evidence', async () => {
  const provider = new FakeGeneration(value);
  const result = await extractVerified(await load('APP-001'), provider, 'test prompt');
  expect(result.fields.income.value).toBe('30000.00');
  const request = provider.calls[0]!.data;
  for (const forbidden of ['Kareem', 'Muslim', 'Married', '28704121234567', '010-0000-0001'])
    expect(request).not.toContain(forbidden);
});
it('refers invalid JSON and false numbers instead of trusting an apparent quote', async () => {
  const doc = await load('APP-001');
  await expect(extractVerified(doc, new FakeGeneration({}), 'test')).rejects.toThrow('schema');
  await expect(
    extractVerified(
      doc,
      new FakeGeneration({ ...value, income: { ...value.income, value: '200000' } }),
      'test',
    ),
  ).rejects.toThrow('source field');
});
it('blocks APP-004 tampering before any model call, preserving real salary evidence', async () => {
  const doc = await load('APP-004');
  const provider = new FakeGeneration(value);
  expect(
    sanitizeEvidence(doc).lines.some((line) => line.text === 'Net monthly income 18,000.00'),
  ).toBe(true);
  await expect(extractVerified(doc, provider, 'test')).rejects.toThrow('Fraud Unit');
  expect(provider.calls).toHaveLength(0);
});
it('protected field changes produce identical model-facing evidence', async () => {
  const doc = await load('APP-001');
  const altered = {
    ...doc,
    blocks: doc.blocks.map((b) => ({
      ...b,
      text: b.text
        .replace('Gender Male', 'Gender Female')
        .replace('Marital status Married', 'Marital status Single')
        .replace('Muslim', 'Christian')
        .replace('Nationality Egyptian', 'Nationality Other'),
    })),
  };
  expect(sanitizeEvidence(altered)).toEqual(sanitizeEvidence(doc));
});

it('refers contradictory labeled salary values rather than choosing a convenient quote', async () => {
  const doc = await load('APP-001');
  const contradictory = {
    ...doc,
    blocks: doc.blocks.map((b) => ({
      ...b,
      text: b.text.replace(
        'Net monthly income 30,000.00',
        'Net monthly income 30,000.00\nNet monthly income 200,000.00',
      ),
    })),
  };
  await expect(extractVerified(contradictory, new FakeGeneration(value), 'test')).rejects.toThrow(
    'contradictory',
  );
});
