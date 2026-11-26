import { z } from 'zod';
export const blockSchema = z.object({
  text: z.string().min(1),
  originalText: z.string().min(1),
  page: z.number().int().positive().nullable(),
  row: z.number().int().positive().nullable(),
  section: z.string(),
  startOffset: z.number().int().nonnegative(),
});
export const normalizedDocumentSchema = z.object({
  filename: z.string().min(1),
  hash: z.string().length(64),
  format: z.enum(['pdf', 'csv', 'md']),
  parserVersion: z.literal('1'),
  blocks: z.array(blockSchema).min(1),
  warnings: z.array(z.string()),
});
export type NormalizedDocument = z.infer<typeof normalizedDocumentSchema>;
export interface DocumentMetadata {
  id: string;
  edition: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  product: string;
  kind: 'policy' | 'product' | 'procedure' | 'circular' | 'pricing';
}
const policyDocumentIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{2,64}$/, 'Document ID must be 2–64 letters, digits, ., _, or -');

export const customPolicyMetadataSchema = z
  .object({
    id: policyDocumentIdSchema.optional(),
    edition: z.string().trim().min(1).max(40),
    effectiveFrom: z.iso.date(),
    effectiveTo: z.iso.date().nullable().optional(),
    product: z.enum(['PL-100', 'AL-200']),
    kind: z.enum(['policy', 'product', 'procedure', 'circular', 'pricing']),
  })
  .strict()
  .refine((value) => !value.effectiveTo || value.effectiveTo > value.effectiveFrom, {
    message: 'Effective-to date must be later than effective-from date',
    path: ['effectiveTo'],
  });
export type CustomPolicyMetadata = z.infer<typeof customPolicyMetadataSchema>;

export const policyMetadataOverrideSchema = z
  .object({
    id: policyDocumentIdSchema.optional(),
    edition: z.string().trim().min(1).max(40).optional(),
    effectiveFrom: z.iso.date().optional(),
    effectiveTo: z.iso.date().nullable().optional(),
    product: z.enum(['PL-100', 'AL-200']).optional(),
    kind: z.enum(['policy', 'product', 'procedure', 'circular', 'pricing']).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.effectiveFrom || !value.effectiveTo || value.effectiveTo > value.effectiveFrom,
    {
      message: 'Effective-to date must be later than effective-from date',
      path: ['effectiveTo'],
    },
  );
export type PolicyMetadataOverride = z.infer<typeof policyMetadataOverrideSchema>;
export interface Chunk {
  id: string;
  ordinal: number;
  sourceFile: string;
  text: string;
  section: string;
  pageStart: number | null;
  pageEnd: number | null;
  row: number | null;
  documentId: string;
  edition: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  product: string;
  contentHash: string;
}
