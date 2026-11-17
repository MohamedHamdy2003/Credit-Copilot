import { z } from 'zod';
import { DomainError } from '../../../domain/src/errors.js';
import { validDate } from '../../../domain/src/calculations.js';
import type { PricingRow } from '../../../domain/src/policy.js';
import type { NormalizedDocument } from '../../../contracts/src/documents.js';

const rowSchema = z
  .object({
    document_id: z.string().min(1),
    version: z.string().min(1),
    effective_from: z.string().refine((s) => {
      try {
        validDate(s);
        return true;
      } catch {
        return false;
      }
    }),
    tenor_from_months: z.coerce.number().int().positive(),
    tenor_to_months: z.coerce.number().int().positive(),
    segment: z.enum(['standard', 'payroll_transfer']),
    annual_rate_percent: z.string().regex(/^\d+(?:\.\d+)?$/),
  })
  .refine((r) => r.tenor_from_months <= r.tenor_to_months);
export function extractPricing(document: NormalizedDocument): PricingRow[] {
  const rows = document.blocks.map((block) => {
    const values = Object.fromEntries(
      block.text.split('\n').map((line) => {
        const index = line.indexOf(':');
        return [line.slice(0, index), line.slice(index + 1).trim()];
      }),
    );
    const result = rowSchema.safeParse(values);
    if (!result.success)
      throw new DomainError('InvalidCSV', 'Pricing row fails schema validation', 422, {
        row: block.row,
      });
    const r = result.data;
    return {
      documentId: r.document_id,
      version: r.version,
      effectiveFrom: r.effective_from,
      fromMonths: r.tenor_from_months,
      toMonths: r.tenor_to_months,
      segment: r.segment,
      annualRatePercent: r.annual_rate_percent,
      sourceFile: document.filename,
      row: block.row!,
    };
  });
  for (const [i, a] of rows.entries())
    for (const b of rows.slice(i + 1)) {
      if (
        a.segment === b.segment &&
        a.effectiveFrom === b.effectiveFrom &&
        a.fromMonths <= b.toMonths &&
        b.fromMonths <= a.toMonths
      )
        throw new DomainError('InvalidCSV', 'Pricing bands overlap');
    }
  return rows;
}
