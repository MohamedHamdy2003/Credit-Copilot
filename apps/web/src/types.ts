import type { Actor } from '../../../packages/domain/src/access.js';
import type { AssessmentResult } from '../../../packages/application/src/assessment-record.js';
export type { Actor, AssessmentResult };
export interface Session {
  user: Actor;
  csrfToken: string;
}
export interface ApplicationRow {
  id: string;
  reference: string;
  status: string | null;
  latest_assessment_id: string | null;
}
export interface ApplicationDetail {
  canAssess: boolean;
  id: string;
  synthetic: boolean;
  latestAssessmentId: string | null;
  form: { reference: string; amount: string; months: number; applicationDate: string };
}
export interface Run {
  id: string;
  application_id: string;
  preparer_id: string;
  status: string;
  version: number;
  result: AssessmentResult;
}
export interface ReviewRow {
  id: string;
  application_id: string;
  status: string;
  recommendation: string;
  recommended_amount: string | null;
}
export interface Citation {
  sourceFile: string;
  section?: string;
  edition?: string;
  pageStart?: number;
  pageEnd?: number;
  row?: number;
  quote?: string;
  chunkId?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}
export interface Answer {
  answer: string;
  refused: boolean;
  asOfDate: string;
  citations: Citation[];
}
export interface KnowledgeDocument {
  id: string;
  filename: string;
  metadata: { edition?: string };
  pipeline_version: string;
}
export interface IngestionAttempt {
  id: string;
  filename: string;
  status: string;
  error_code?: string;
}
export interface IngestionResult {
  filename: string;
  status: string;
  code?: string;
  result?: { status: string };
}
export interface Offer {
  id: string;
  run_id: string;
  data: {
    amount: string;
    disbursementDate: string;
    mode: string;
    fullyEvidenceVerified: boolean;
    assumptions: { reason: string }[];
  };
}
