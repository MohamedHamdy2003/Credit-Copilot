import { z } from 'zod';
import type { NormalizedDocument } from '../../contracts/src/documents.js';
import type { GenerationPort } from './ports.js';
import { DomainError, invariant } from '../../domain/src/errors.js';
import { compareMoney, validDate } from '../../domain/src/calculations.js';

const money = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
const field = <T extends z.ZodType>(value: T) =>
  z.object({ value, quote: z.string().min(1), section: z.enum(['salary', 'bureau']) }).strict();
export const extractionSchema = z
  .object({
    income: field(money),
    obligations: field(money),
    employmentStart: field(z.string()),
    bureauScore: field(z.number().int().min(0).max(1000)),
  })
  .strict();

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export function parseEnglishDate(text: string): string {
  const match = text.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  invariant(match, 'InvalidDate', 'Expected day month year');
  const month = months.findIndex((m) => m.toLowerCase() === match[2]!.toLowerCase()) + 1;
  return validDate(`${match[3]}-${String(month).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`);
}

/** Model sees allowlisted evidence lines only, never raw applicant prose. */
export function sanitizeEvidence(document: NormalizedDocument) {
  let section: 'salary' | 'bureau' | null = null;
  const output: { text: string; section: 'salary' | 'bureau'; page: number | null }[] = [];
  const all = document.blocks.map((b) => b.text).join('\n');
  const tampered =
    /ignore\s+(?:all\s+)?previous\s+instructions|system\s+note\s+for\s+the\s+automated\s+reviewer/i.test(
      all,
    );
  for (const block of document.blocks) {
    for (const line of block.text.split('\n')) {
      if (/^Part 2\b/.test(line)) section = 'salary';
      if (/^Part 3\b/.test(line)) section = 'bureau';
      if (section === 'salary') {
        const income = line.match(/^Net monthly income\s+(?:EGP\s+)?([\d,]+\.\d{2})\s*$/i);
        if (income)
          output.push({ text: `Net monthly income ${income[1]}`, section, page: block.page });
        const employed = line.match(/\bsince (\d{1,2} [A-Za-z]+ \d{4})\b/);
        if (employed)
          output.push({ text: `Employment start ${employed[1]}`, section, page: block.page });
      }
      if (section === 'bureau') {
        const obligation = line.match(
          /^Total monthly instalments\s+(?:EGP\s+)?([\d,]+\.\d{2})\s*$/i,
        );
        const score = line.match(/^Bureau score\s+(\d+)\s*$/i);
        if (obligation)
          output.push({
            text: `Total monthly instalments ${obligation[1]}`,
            section,
            page: block.page,
          });
        if (score) output.push({ text: `Bureau score ${score[1]}`, section, page: block.page });
      }
    }
  }
  return {
    lines: output,
    tampered,
    removedFields: ['gender', 'religion', 'marital_status', 'nationality'],
    sourceFile: document.filename,
  };
}

const generationSchema = z.toJSONSchema(z.union([extractionSchema, z.strictObject({})]));

export async function extractVerified(
  document: NormalizedDocument,
  provider: GenerationPort,
  prompt: string,
) {
  return extractSanitized(sanitizeEvidence(document), provider, prompt);
}

export async function extractSanitized(
  sanitized: ReturnType<typeof sanitizeEvidence>,
  provider: GenerationPort,
  prompt: string,
) {
  if (sanitized.tampered)
    throw new DomainError(
      'SuspectedTampering',
      'Customer document contains suspected reviewer instructions; refer to Fraud Unit',
    );
  const response = await provider.completeStructured(
    prompt,
    JSON.stringify({
      source: /^(?:APP|AUTO)-\d{3}\.pdf$/.test(sanitized.sourceFile)
        ? sanitized.sourceFile
        : 'application-pack',
      evidence: sanitized.lines,
    }),
    generationSchema,
  );
  const parsed = extractionSchema.safeParse(response.value);
  if (!parsed.success)
    throw new DomainError('InvalidLLMOutput', 'Extraction JSON fails schema validation');
  const expected = {
    income: ['salary', 'Net monthly income'],
    obligations: ['bureau', 'Total monthly instalments'],
    employmentStart: ['salary', 'Employment start'],
    bureauScore: ['bureau', 'Bureau score'],
  } as const;
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    const extracted = parsed.data[key];
    const [section, label] = expected[key];
    const candidates = sanitized.lines.filter(
      (entry) => entry.section === section && entry.text.startsWith(`${label} `),
    );
    invariant(
      new Set(candidates.map((entry) => entry.text)).size === 1,
      'UnverifiedExtraction',
      `Missing or contradictory source values for ${key}`,
    );
    const line = sanitized.lines.find(
      (entry) =>
        entry.section === section &&
        entry.text === extracted.quote &&
        entry.text.startsWith(`${label} `),
    );
    invariant(
      line && extracted.section === section,
      'UnverifiedExtraction',
      `Unverified source quote for ${key}`,
    );
    const sourceValue = line.text.slice(label.length + 1);
    const canonical =
      key === 'employmentStart' ? parseEnglishDate(sourceValue) : sourceValue.replace(/,/g, '');
    invariant(
      key === 'employmentStart'
        ? canonical === extracted.value
        : compareMoney(canonical, String(extracted.value)) === 0,
      'UnverifiedExtraction',
      `Value does not match source field ${key}`,
    );
  }
  return { fields: parsed.data, sanitized, model: response.model, usage: response.usage };
}
