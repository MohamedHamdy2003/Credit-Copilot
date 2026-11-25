import { z } from 'zod';

export const ASSESSMENT_STAGES = [
  'load_application',
  'remove_protected_attributes',
  'select_policy',
  'extract_data',
  'retrieve_policy_clauses',
  'calculate_and_check_rules',
  'prepare_memo',
  'record_pending_review',
] as const;
export type AssessmentStage = (typeof ASSESSMENT_STAGES)[number];
export const assessmentStageEvent = z.object({
  stage: z.enum(ASSESSMENT_STAGES),
  status: z.enum(['executed', 'skipped', 'failed']),
});
export const assessmentStreamEvent = z.discriminatedUnion('kind', [
  assessmentStageEvent.extend({ kind: z.literal('stage') }),
  z.object({ kind: z.literal('completed'), runId: z.uuid() }),
  z.object({ kind: z.literal('failed'), code: z.literal('AssessmentFailed') }),
]);
export const questionStreamEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('citation'),
    asOfDate: z.iso.date(),
    citation: z.object({
      chunkId: z.string(),
      sourceFile: z.string(),
      section: z.string(),
      edition: z.string(),
      quote: z.string(),
      pageStart: z.number().nullable(),
      pageEnd: z.number().nullable(),
      row: z.number().nullable(),
      effectiveFrom: z.string(),
      effectiveTo: z.string().nullable(),
    }),
  }),
  z.object({
    kind: z.literal('completed'),
    asOfDate: z.iso.date(),
    refused: z.boolean(),
    answer: z.string().max(20000),
    resolution: z.string().optional(),
  }),
  z.object({ kind: z.literal('failed'), code: z.literal('QuestionUnavailable') }),
]);
export const QUESTION_REFUSAL =
  'The documents do not contain enough information to answer this question.';
export const INGESTION_STAGES = ['extract', 'chunk', 'embed', 'index'] as const;
export type IngestionStage = (typeof INGESTION_STAGES)[number];
export const ingestionStageEvent = z.object({
  kind: z.literal('stage'),
  fileIndex: z.number().int().nonnegative(),
  filename: z.string().min(1),
  stage: z.enum(INGESTION_STAGES),
  status: z.enum(['running', 'completed', 'skipped', 'failed']),
  detail: z.string().optional(),
  current: z.number().int().nonnegative().optional(),
  total: z.number().int().positive().optional(),
});
export const ingestionStreamEvent = z.discriminatedUnion('kind', [
  ingestionStageEvent,
  z.object({
    kind: z.literal('file_completed'),
    fileIndex: z.number().int().nonnegative(),
    filename: z.string().min(1),
    status: z.enum(['succeeded', 'skipped', 'failed']),
    documentId: z.string().optional(),
    chunks: z.number().int().nonnegative().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal('completed'),
    totalFiles: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('failed'), code: z.string() }),
]);
export type AssessmentStreamEvent = z.infer<typeof assessmentStreamEvent>;
export type QuestionStreamEvent = z.infer<typeof questionStreamEvent>;
export type IngestionStreamEvent = z.infer<typeof ingestionStreamEvent>;
export interface StreamFrame<T> {
  id: number;
  data: T;
}
