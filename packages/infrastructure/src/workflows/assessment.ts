import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { normalizedDocumentSchema } from '../../../contracts/src/documents.js';
import {
  assessApplication,
  type AssessmentDependencies,
} from '../../../application/src/assessment.js';
import type { AssessmentRepository } from '../../../application/src/assessment-record.js';

const inputSchema = z
  .object({
    document: normalizedDocumentSchema,
    actorId: z.string().min(1),
    at: z.iso.datetime(),
    synthetic: z.boolean(),
    requestedMode: z.enum(['strict', 'demo']).optional(),
    evidence: z
      .array(z.object({ requirement: z.string(), present: z.boolean(), verified: z.boolean() }))
      .min(1),
    verifiedFacts: z
      .object({
        certificateDate: z.iso.date(),
        confirmed: z.boolean().nullable(),
        hasDefault: z.boolean(),
        bankEmployee: z.boolean(),
        purposeAllowed: z.boolean(),
        plannedDisbursement: z.iso.date(),
      })
      .strict(),
  })
  .strict();
const outputSchema = z.custom<Awaited<ReturnType<typeof assessApplication>>>(
  (value) =>
    typeof value === 'object' && value !== null && 'recommendation' in value && 'status' in value,
);

/** Infrastructure wrapper; persistence/human approval are separate use cases. */
export function createAssessmentWorkflow(
  dependencies: AssessmentDependencies,
  persistence?: {
    repository: AssessmentRepository;
    runId: string;
    applicationId: string;
    requestId: string;
    actorId: string;
    at: string;
  },
) {
  const assessment = createStep({
    id: 'assess-application',
    inputSchema,
    outputSchema,
    execute: async ({ inputData }) => assessApplication(inputData, dependencies),
  });
  const workflow = createWorkflow({ id: 'application-assessment', inputSchema, outputSchema }).then(
    assessment,
  );
  if (!persistence) return workflow.commit();
  const save = createStep({
    id: 'record-pending-assessment',
    inputSchema: outputSchema,
    outputSchema,
    execute: async ({ inputData }) => {
      await persistence.repository.save({
        id: persistence.runId,
        applicationId: persistence.applicationId,
        actorId: persistence.actorId,
        requestId: persistence.requestId,
        at: persistence.at,
        result: inputData,
      });
      return inputData;
    },
  });
  return workflow.then(save).commit();
}
