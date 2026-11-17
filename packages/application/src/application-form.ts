import { z } from 'zod';
import type { NormalizedDocument } from '../../contracts/src/documents.js';
import { invariant } from '../../domain/src/errors.js';
import { parseEnglishDate } from './extraction.js';

export const applicationFormSchema = z
  .object({
    reference: z.string().min(1),
    applicationDate: z.string(),
    birthDate: z.string(),
    amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    months: z.number().int().positive().max(1200),
    payrollTransfer: z.boolean(),
  })
  .strict();
export type ApplicationForm = z.infer<typeof applicationFormSchema>;

/** Explicit allowlist: protected form fields cannot enter returned application data. */
export function parseApplicationForm(document: NormalizedDocument): ApplicationForm {
  const text = document.blocks
    .map((b) => b.text)
    .join('\n')
    .split(/^Part 2\b/m)[0]!;
  const read = (label: string) => {
    const matches = text
      .split('\n')
      .filter((line) => line.startsWith(`${label} `))
      .map((line) => line.slice(label.length + 1).trim());
    invariant(matches.length === 1, 'InvalidApplication', `Exactly one ${label} field is required`);
    return matches[0]!;
  };
  const amount = read('Requested amount').match(/^EGP ([\d,]+(?:\.\d{2})?)$/);
  const months = read('Requested tenor').match(/^(\d+) months$/);
  const transfer = read('Salary transferred to Delta');
  invariant(
    amount && months && ['Yes', 'No'].includes(transfer),
    'InvalidApplication',
    'Invalid amount, tenor or salary-transfer field',
  );
  const result = applicationFormSchema.parse({
    reference: read('Application reference'),
    applicationDate: parseEnglishDate(read('Application date')),
    birthDate: parseEnglishDate(read('Date of birth')),
    amount: amount[1]!.replace(/,/g, ''),
    months: Number(months[1]),
    payrollTransfer: transfer === 'Yes',
  });
  invariant(
    result.birthDate < result.applicationDate,
    'InvalidApplication',
    'Birth date must precede application date',
  );
  return result;
}
