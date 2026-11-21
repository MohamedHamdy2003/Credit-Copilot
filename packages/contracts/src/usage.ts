export type UsageProvider = 'gemini' | 'ollama' | 'unknown';
export type UsageKind = 'generation' | 'query_embedding' | 'document_embedding';
export type UsageOperation = 'assessment' | 'policy_question' | 'knowledge_ingestion';
export type UsageStep =
  | 'assessment'
  | 'extract_data'
  | 'plan_extract_data'
  | 'plan_retrieve_policy_clauses'
  | 'plan_prepare_memo'
  | 'legacy_assessment'
  | 'retrieve'
  | 'answer'
  | 'index';

export interface PriceSnapshot {
  currency: 'USD';
  capturedOn: string;
  source: string;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
}

export interface UsageEvent {
  id: string;
  actorId: string;
  runId: string | null;
  requestId: string | null;
  operation: UsageOperation;
  step: UsageStep;
  provider: UsageProvider;
  model: string;
  kind: UsageKind;
  outcome: 'succeeded' | 'failed' | 'unknown';
  retry: boolean;
  fallbackFrom: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedUsd: string | null;
  price: PriceSnapshot | null;
  actualUsd: string | null;
  chargeBasis: 'confirmed_free_tier' | 'local' | 'unknown';
  occurredAt: string;
}

export interface UsageMetric<T> {
  knownTotal: T | null;
  missingCalls: number;
}

export interface UsageTotals {
  calls: number;
  failedCalls: number;
  retries: number;
  fallbacks: number;
  legacyCalls: number;
  freeTierCalls: number;
  localCalls: number;
  inputTokens: UsageMetric<number>;
  outputTokens: UsageMetric<number>;
  estimatedUsd: UsageMetric<string>;
  actualUsd: UsageMetric<string>;
}

export interface UsageGroup extends UsageTotals {
  provider: UsageProvider;
  model: string;
  kind: UsageKind;
  operation: UsageOperation;
  step: UsageStep;
}

export interface UsageSummary {
  runId: string | null;
  totals: UsageTotals;
  groups: UsageGroup[];
  truncated: boolean;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
  recentRuns: { runId: string; lastRecordedAt: string; calls: number }[];
}
