import type { AssessmentInput, AssessmentDependencies } from './assessment.js';
import { assessApplication } from './assessment.js';
import type { Usage } from './ports.js';

export interface AssessmentResult {
  reference: string;
  mode: 'strict' | 'demo';
  evidence: ReturnType<typeof import('../../domain/src/evidence-mode.js').evaluateEvidence>;
  policyEdition: string | null;
  maxDbr: string | null;
  removedFields: string[];
  steps: string[];
  recommendation: 'APPROVE' | 'DECLINE' | 'REFER_TO_HUMAN' | 'OFFER_ALTERNATIVE';
  status: 'pending_review' | 'pending_customer_acceptance' | 'pending_approval';
  calculation: ReturnType<typeof import('../../domain/src/rules.js').assessRules>['calculation'];
  results?: import('../../domain/src/rules.js').RuleResult[];
  recommendedAmount?: string | null;
  memo?: string;
  pricing?: { annualRatePercent: string; sourceFile: string; row: number };
  reason?: string;
  citations?: string[];
  extraction?: Awaited<ReturnType<typeof import('./extraction.js').extractVerified>>;
  fraudReferral: boolean;
  retrievedChunkIds?: string[];
  stageEvents?: { stage: string; status: 'executed' | 'skipped' | 'failed' }[];
  usageRecords?: (Usage & { model: string; fallbackFrom?: string })[];
}
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
