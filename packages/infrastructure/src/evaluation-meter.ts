import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
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
  constructor(
    private readonly provider: GenerationPort & EmbeddingPort,
    private readonly cache?: DataSource,
    private readonly generationIntervalMs = 0,
  ) {
    this.model = provider.model;
    this.dimensions = provider.dimensions;
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
    this.events.push(event);
    try {
      const r = await this.provider.completeStructured(system, data, schema);
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
    this.events.push(event);
    try {
      return await this.provider.embed(text, purpose);
    } catch (e) {
      event.failed = true;
      throw e;
    }
  }
  metrics(from: number) {
    const gen = this.events.slice(from).filter((e) => e.kind === 'generation'),
      unknown = gen.some((e) => e.inputTokens === null || e.outputTokens === null);
    return {
      generationCalls: gen.length,
      embeddingCalls: this.events.slice(from).filter((e) => e.kind === 'embedding').length,
      inputTokens: unknown ? null : gen.reduce((n, e) => n + e.inputTokens!, 0),
      outputTokens: unknown ? null : gen.reduce((n, e) => n + e.outputTokens!, 0),
      unknownUsage: unknown,
    };
  }
}
