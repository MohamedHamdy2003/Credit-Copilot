import type { AssessmentInput, AssessmentDependencies } from './assessment.js';
import { assessApplication } from './assessment.js';

export type AssessmentResult = Awaited<ReturnType<typeof assessApplication>>;
export interface AssessmentRecord {
  id: string;
  applicationId: string;
  actorId: string;
  requestId: string;
  at: string;
  result: AssessmentResult;
}
export interface AssessmentRepository {
  /** Atomically append immutable assessment, audit, usage and fraud referral. */
  save(record: AssessmentRecord): Promise<void>;
}
export async function assessAndRecord(
  input: AssessmentInput,
  dependencies: AssessmentDependencies,
  repository: AssessmentRepository,
  identifiers: { runId: string; applicationId: string; requestId: string },
) {
  const result = await assessApplication(input, dependencies);
  await repository.save({
    id: identifiers.runId,
    applicationId: identifiers.applicationId,
    requestId: identifiers.requestId,
    actorId: input.actorId,
    at: input.at,
    result,
  });
  return { runId: identifiers.runId, ...result };
}
