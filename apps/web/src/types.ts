import type { Actor } from '../../../packages/domain/src/access.js';
import type { AssessmentResult } from '../../../packages/application/src/assessment-record.js';
import type { ProductId } from '../../../packages/contracts/src/products.js';
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
  form: {
    reference: string;
    amount: string;
    months: number;
    applicationDate: string;
    productId: ProductId;
    vehiclePrice?: string;
    downPayment?: string;
  };
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
  pageStart?: number | null;
  pageEnd?: number | null;
  row?: number | null;
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
  resolution?: string;
}
export interface KnowledgeDocument {
  id: string;
  filename: string;
  metadata: {
    edition?: string;
    product?: string;
    kind?: string;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    sourceOrigin?: 'manifest' | 'custom';
  };
  pipeline_version: string;
  chunk_count?: number;
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
  documentAvailable: boolean;
  data: {
    amount: string;
    disbursementDate: string;
    mode: string;
    fullyEvidenceVerified: boolean;
    assumptions: { reason: string }[];
  };
}
