import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { UsageContext, UsagePort } from '../../../application/src/usage.js';
import type { Config } from '../../../contracts/src/config.js';
import type { UsageEvent, UsageStep } from '../../../contracts/src/usage.js';
import type { PostgresUsageStore } from '../db/usage-store.js';
import { withProviderAttemptObserver, type ProviderAttempt } from './attempt-meter.js';
import { priceAttempt } from './pricing.js';

const modelId = (model: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model) ? model : 'provider-not-reported';

const steps = new AsyncLocalStorage<UsageStep>();
export const currentUsageStep = () => steps.getStore();
export const withUsageStep = <T>(step: UsageStep, work: () => Promise<T>) => steps.run(step, work);

function defaultUsageStep(context: UsageContext, kind: ProviderAttempt['kind']): UsageStep {
  if (context.operation === 'assessment') return 'assessment';
  if (context.operation === 'knowledge_ingestion') return 'index';
  return kind === 'query_embedding' ? 'retrieve' : 'answer';
}

export class UsageTracker implements UsagePort {
  constructor(
    private readonly store: Pick<PostgresUsageStore, 'record' | 'summarize'>,
    private readonly billingTier: Config['GEMINI_BILLING_TIER'],
  ) {}

  async track<T>(context: UsageContext, work: () => Promise<T>): Promise<T> {
    const events: UsageEvent[] = [];
    try {
      return await withProviderAttemptObserver((attempt) => {
        events.push({
          ...attempt,
          model: modelId(attempt.model),
          fallbackFrom: attempt.fallbackFrom ? modelId(attempt.fallbackFrom) : null,
          ...priceAttempt(attempt, this.billingTier),
          id: randomUUID(),
          actorId: context.actorId,
          runId: context.runId ?? null,
          requestId: context.requestId,
          operation: context.operation,
          step: currentUsageStep() ?? defaultUsageStep(context, attempt.kind),
          occurredAt: new Date().toISOString(),
        });
      }, work);
    } finally {
      if (events.length) await this.record(events);
    }
  }

  summarize(actorId: string, runId?: string) {
    return this.store.summarize(actorId, runId);
  }

  private async record(events: UsageEvent[]) {
    try {
      await this.store.record(events);
    } catch {
      // An ambiguous write can be retried with the same IDs, independently of the business result.
      try {
        await this.store.record(events);
      } catch {
        console.error(`Model usage could not be recorded for ${events.length} attempt(s).`);
      }
    }
  }
}
