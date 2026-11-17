import { createHash } from 'node:crypto';
import type {
  EmbeddingPort,
  GenerationPort,
  Completion,
} from '../../packages/application/src/ports.js';

/** Test-only lexical hash vectors. NOT semantic embeddings or a live-provider evaluation. */
export class FakeEmbedding implements EmbeddingPort {
  readonly model = 'test-only-hash-v1';
  readonly dimensions = 64;
  calls = 0;
  async embed(text: string): Promise<number[]> {
    this.calls++;
    const values = Array<number>(this.dimensions).fill(0);
    for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const index = createHash('sha256').update(term).digest()[0]! % this.dimensions;
      values[index] = values[index]! + 1;
    }
    const norm = Math.sqrt(values.reduce((sum, n) => sum + n * n, 0)) || 1;
    return values.map((n) => n / norm);
  }
}
export class FakeGeneration implements GenerationPort {
  calls: { system: string; data: string }[] = [];
  constructor(private readonly value: unknown) {}
  async completeStructured(system: string, data: string): Promise<Completion> {
    this.calls.push({ system, data });
    return {
      value: this.value,
      model: 'test-only-fake',
      usage: { inputTokens: null, outputTokens: null },
    };
  }
}
