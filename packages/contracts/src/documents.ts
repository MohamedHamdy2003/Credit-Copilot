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
