import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  ASSESSMENT_STAGES,
  documentAssessmentInputSchema,
  initialAssessmentState,
  executeAssessmentStage,
  type AssessmentState,
  type AssessmentStage,
  type DocumentAssessmentDependencies,
} from '../../../application/src/document-assessment.js';

const stateSchema = z.custom<AssessmentState>((state: unknown) => {
  if (typeof state !== 'object' || state === null) return false;
  const s = state as Partial<AssessmentState>;
  return (
    documentAssessmentInputSchema.safeParse(s.input).success &&
    Array.isArray(s.steps) &&
    s.steps.every((x) => ASSESSMENT_STAGES.includes(x as AssessmentStage)) &&
    Array.isArray(s.clauses) &&
    Array.isArray(s.usageRecords) &&
    (s.mode === 'strict' || s.mode === 'demo')
  );
});
/** No workflow storage configured: raw evidence is not persisted into Mastra snapshots. */
export function createDocumentAssessmentWorkflow(
  dependencies: DocumentAssessmentDependencies,
  observeStage?: (event: AssessmentState['stageEvents'][number]) => Promise<void>,
) {
  const execute = async (id: AssessmentStage, state: AssessmentState) => {
    const next = await executeAssessmentStage(id, state, dependencies);
    const event = next.stageEvents.at(-1);
    if (event && observeStage && id !== 'record_pending_review') {
      await observeStage(event).catch(() => undefined);
    }
    return next;
  };
  const load = createStep({
    id: ASSESSMENT_STAGES[0],
    inputSchema: documentAssessmentInputSchema,
    outputSchema: stateSchema,
    execute: async ({ inputData }) =>
      execute(ASSESSMENT_STAGES[0], initialAssessmentState(inputData, dependencies)),
  });
  const stage = (id: AssessmentStage) =>
    createStep({
      id,
      inputSchema: stateSchema,
      outputSchema: stateSchema,
      execute: async ({ inputData }) => execute(id, inputData),
    });
  return createWorkflow({
    id: 'document-assessment',
    inputSchema: documentAssessmentInputSchema,
    outputSchema: stateSchema,
  })
    .then(load)
    .then(stage('remove_protected_attributes'))
    .then(stage('select_policy'))
    .then(stage('extract_data'))
    .then(stage('retrieve_policy_clauses'))
    .then(stage('calculate_and_check_rules'))
    .then(stage('prepare_memo'))
    .then(stage('record_pending_review'))
    .commit();
}
