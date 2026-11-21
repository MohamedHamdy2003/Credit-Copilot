import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
import { Decimal } from 'decimal.js';
import type { Config } from '../../contracts/src/config.js';
import {
  instrumentProvider,
  withProviderAttemptObserver,
  type ProviderAttempt,
} from './llm/attempt-meter.js';
import { priceAttempt } from './llm/pricing.js';
import { currentUsageStep } from './llm/usage-tracker.js';
import type {
  EmbeddingPort,
  GenerationPort,
  Completion,
  GenerationSchema,
} from '../../application/src/ports.js';
export class EvaluationMeter implements GenerationPort, EmbeddingPort {
  readonly model: string;
  readonly dimensions: number;
  events: {
    kind: 'generation' | 'embedding';
    inputHash: string;
    inputTokens: number | null;
    outputTokens: number | null;
    failed: boolean;
  }[] = [];
  cacheHits = 0;
  private nextGenerationAt = 0;
  private readonly provider: GenerationPort & EmbeddingPort;
  private readonly attempts: {
    logicalIndex: number;
    row: ProviderAttempt &
      ReturnType<typeof priceAttempt> & { step: ReturnType<typeof currentUsageStep> };
  }[] = [];
  constructor(
    provider: GenerationPort & EmbeddingPort,
    private readonly cache?: DataSource,
    private readonly generationIntervalMs = 0,
    private readonly billingTier: Config['GEMINI_BILLING_TIER'] = 'unknown',
  ) {
    this.provider = instrumentProvider(provider);
    this.model = provider.model;
    this.dimensions = provider.dimensions;
  }
  private account<T>(logicalIndex: number, work: () => Promise<T>): Promise<T> {
    return withProviderAttemptObserver((attempt) => {
      this.attempts.push({
        logicalIndex,
        row: { ...attempt, step: currentUsageStep(), ...priceAttempt(attempt, this.billingTier) },
      });
    }, work);
  }
  async completeStructured(
    system: string,
    data: string,
    schema?: GenerationSchema,
  ): Promise<Completion> {
    if (this.generationIntervalMs > 0) {
      const now = performance.now();
      const scheduled = Math.max(now, this.nextGenerationAt);
      this.nextGenerationAt = scheduled + this.generationIntervalMs;
      if (scheduled > now) await sleep(Math.ceil(scheduled - now));
    }
    const event = {
      kind: 'generation' as const,
      inputHash: createHash('sha256')
        .update(system + '\n' + data)
        .digest('hex'),
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      failed: false,
    };
    const logicalIndex = this.events.push(event) - 1;
    try {
      const r = await this.account(logicalIndex, () =>
        this.provider.completeStructured(system, data, schema),
      );
      Object.assign(event, r.usage);
      return r;
    } catch (e) {
      event.failed = true;
      throw e;
    }
  }
  async embed(text: string, purpose: 'document' | 'query') {
    if (purpose === 'document' && this.cache) {
      const rows = (await this.cache.query(
        'SELECT e.embedding::text AS vector FROM knowledge.embeddings e JOIN knowledge.chunks c ON c.id=e.chunk_id WHERE c.active AND c.text=$1 AND e.model=$2 AND e.dimensions=$3 LIMIT 1',
        [text, this.model, this.dimensions],
      )) as { vector: string }[];
      if (rows[0]) {
        this.cacheHits++;
        return JSON.parse(rows[0].vector) as number[];
      }
    }
    const event = {
      kind: 'embedding' as const,
      inputHash: createHash('sha256').update(text).digest('hex'),
      inputTokens: null,
      outputTokens: null,
      failed: false,
    };
    const logicalIndex = this.events.push(event) - 1;
    try {
      return await this.account(logicalIndex, () => this.provider.embed(text, purpose));
    } catch (e) {
      event.failed = true;
      throw e;
    }
  }
  metrics(from: number) {
    const gen = this.events.slice(from).filter((e) => e.kind === 'generation'),
      unknown = gen.some((e) => e.inputTokens === null || e.outputTokens === null);
    const attempts = this.attempts
      .filter(({ logicalIndex }) => logicalIndex >= from)
      .map(({ row }) => row);
    const totalUsd = (key: 'estimatedUsd' | 'actualUsd') => {
      const known = attempts.flatMap((attempt) => (attempt[key] === null ? [] : [attempt[key]]));
      return {
        knownTotal: known.length
          ? known.reduce((sum, value) => sum.plus(value), new Decimal(0)).toFixed(8)
          : null,
        missingCalls: attempts.length - known.length,
      };
    };
    const totalTokens = (key: 'inputTokens' | 'outputTokens') => {
      const known = attempts.flatMap((attempt) => (attempt[key] === null ? [] : [attempt[key]]));
      return {
        knownTotal: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
        missingCalls: attempts.length - known.length,
      };
    };
    return {
      generationCalls: gen.length,
      embeddingCalls: this.events.slice(from).filter((e) => e.kind === 'embedding').length,
      inputTokens: unknown ? null : gen.reduce((n, e) => n + e.inputTokens!, 0),
      outputTokens: unknown ? null : gen.reduce((n, e) => n + e.outputTokens!, 0),
      unknownUsage: unknown,
      providerAccounting: {
        calls: attempts.length,
        failedCalls: attempts.filter((attempt) => attempt.outcome === 'failed').length,
        retries: attempts.filter((attempt) => attempt.retry).length,
        fallbacks: attempts.filter((attempt) => attempt.fallbackFrom).length,
        inputTokens: totalTokens('inputTokens'),
        outputTokens: totalTokens('outputTokens'),
        attempts,
        estimatedUsd: totalUsd('estimatedUsd'),
        actualUsd: totalUsd('actualUsd'),
      },
    };
  }
}
