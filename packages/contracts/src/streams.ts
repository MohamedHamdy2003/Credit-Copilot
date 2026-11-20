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
    resolution: z.string().optional(),
  }),
  z.object({ kind: z.literal('failed'), code: z.literal('QuestionUnavailable') }),
]);
export const QUESTION_REFUSAL =
  'The documents do not contain enough information to answer this question.';
export type AssessmentStreamEvent = z.infer<typeof assessmentStreamEvent>;
export type QuestionStreamEvent = z.infer<typeof questionStreamEvent>;
export interface StreamFrame<T> {
  id: number;
  data: T;
}
