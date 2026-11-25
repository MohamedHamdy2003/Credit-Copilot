import type { ApprovalAuthorityRole } from '../../domain/src/access.js';
import type { Usage } from './ports.js';
import type { AgentToolCall } from './assessment-agents.js';

export interface AssessmentResult {
  reference: string;
  mode: 'strict' | 'demo';
  evidence: ReturnType<typeof import('../../domain/src/evidence-mode.js').evaluateEvidence>;
  policyEdition: string | null;
  maxDbr: string | null;
  productId?: string;
  productSource?: string;
  autoFinance?: import('../../domain/src/rules.js').AutoFinance;
  removedFields: string[];
  steps: string[];
  recommendation: 'APPROVE' | 'DECLINE' | 'REFER_TO_HUMAN' | 'OFFER_ALTERNATIVE';
  approvalRequiredFrom?: ApprovalAuthorityRole | null;
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
  usageRecords?: (Usage & {
    model: string;
    fallbackFrom?: string;
    operation?: 'assessment_agent_planning';
  })[];
  agentToolCalls?: AgentToolCall[];
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
