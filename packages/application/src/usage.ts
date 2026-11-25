import type { UsageOperation, UsageSummary } from '../../contracts/src/usage.js';

export interface UsageContext {
  actorId: string;
  runId?: string;
  requestId: string;
  operation: UsageOperation;
}

export type UsageProviderFilter = 'gemini' | 'ollama';

export interface UsagePort {
  track<T>(context: UsageContext, work: () => Promise<T>): Promise<T>;
  summarize(actorId: string, runId?: string, provider?: UsageProviderFilter): Promise<UsageSummary>;
}
