import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { EmbeddingPort } from '../packages/application/src/ports.js';
import { runtime } from './runtime.js';
import { IngestionService } from '../packages/infrastructure/src/knowledge/ingestion.js';
const embeddingIntervalMs = z.coerce
  .number()
  .int()
  .min(0)
  .max(60000)
  .default(750)
  .parse(process.env.SEED_EMBEDDING_INTERVAL_MS);
const { db, provider, manifest } = await runtime();
let nextEmbeddingAt = 0;
const pacedEmbeddings: EmbeddingPort = {
  model: provider.model,
  dimensions: provider.dimensions,
  async embed(text, purpose) {
    const delay = nextEmbeddingAt - performance.now();
    if (delay > 0) await sleep(Math.ceil(delay));
    nextEmbeddingAt = performance.now() + embeddingIntervalMs;
    return provider.embed(text, purpose);
  },
};
let failures = 0;
try {
  const service = new IngestionService(db, pacedEmbeddings, manifest);
  for (const document of manifest) {
    try {
      console.log(
        await service.ingest(
          document.filename,
          await readFile(`data/corpus/policy/${document.filename}`),
        ),
      );
    } catch (error) {
      failures++;
      console.error(document.filename, error instanceof Error ? error.message : 'Ingestion failed');
    }
  }
  console.log(
    'Policy files only indexed. Customer packs stay isolated; select or upload a reviewed pack through Applications.',
  );
} finally {
  await db.destroy();
}
if (failures) process.exitCode = 1;
