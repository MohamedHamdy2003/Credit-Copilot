import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { configSchema } from '../packages/contracts/src/config.js';
import { createDataSource } from '../packages/infrastructure/src/db/data-source.js';
import { GeminiAdapter } from '../packages/infrastructure/src/llm/gemini.js';
import type { ManifestEntry } from '../packages/infrastructure/src/knowledge/ingestion.js';
export async function runtime() {
  const config = configSchema.parse(process.env);
  const provider = new GeminiAdapter(
    config.GEMINI_API_KEY,
    config.GENERATION_MODEL,
    config.EMBEDDING_MODEL,
    config.EMBEDDING_DIMENSIONS,
  );
  const db = await createDataSource(config.DATABASE_URL).initialize();
  const manifest = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  ) as ManifestEntry[];
  return { config, provider, db, manifest };
}
