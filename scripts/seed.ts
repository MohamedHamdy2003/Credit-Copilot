import { readFile } from 'node:fs/promises';
import { runtime } from './runtime.js';
import { IngestionService } from '../packages/infrastructure/src/knowledge/ingestion.js';
const { db, provider, manifest } = await runtime();
let failures = 0;
try {
  const service = new IngestionService(db, provider, manifest);
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
