/** Test-only server. Never import in production or point at the main database. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApi } from '../apps/api/src/app.js';
import { AuthService } from '../packages/application/src/auth.js';
import { DecisionService } from '../packages/application/src/decisions.js';
import { configSchema } from '../packages/contracts/src/config.js';
import { PostgresAuthStore } from '../packages/infrastructure/src/auth/store.js';
import { ScryptCredentials } from '../packages/infrastructure/src/auth/passwords.js';
import { createDataSource } from '../packages/infrastructure/src/db/data-source.js';
import { PostgresDecisionStore } from '../packages/infrastructure/src/db/decision-store.js';
import { createOperations } from '../packages/infrastructure/src/operations.js';
import { createCaseReviews } from '../packages/infrastructure/src/db/case-review-store.js';
import { loadProductCatalog } from '../packages/infrastructure/src/product-catalog.js';
import { WorkflowTestProvider } from '../tests/helpers/workflow-provider.js';
import { seedRejection } from '../tests/e2e/seed-rejection.js';
import {
  IngestionService,
  type ManifestEntry,
} from '../packages/infrastructure/src/knowledge/ingestion.js';
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://copilot:copilot_local@localhost:54329/credit_copilot_test';
if (!new URL(url).pathname.endsWith('_test'))
  throw new Error('E2E requires a dedicated *_test database');
const db = await createDataSource(url).initialize();
await db.runMigrations();
// Browser suite is run after integration tests, never concurrently against the same test DB.
await db.query('TRUNCATE cases.users CASCADE');
await db.query('DELETE FROM cases.login_attempts');
const credentials = new ScryptCredentials();
const hash = await credentials.hash('e2e-only-password');
for (const username of [
  'basic',
  'stream',
  'auto',
  'strict',
  'demo',
  'question',
  'usage',
  'upload',
  'head',
  'reasons',
]) {
  await db.query(
    'INSERT INTO cases.users(id,username,password_hash,role,tier,can_ingest) VALUES($1,$2,$3,$4,$5,$6)',
    [
      randomUUID(),
      `e2e-${username}`,
      hash,
      username === 'head' ? 'credit_officer' : 'loan_officer',
      username === 'head' ? 'head' : 'none',
      username === 'head',
    ],
  );
}
const provider = new WorkflowTestProvider();
const manifest = JSON.parse(
  await readFile('data/config/corpus-manifest.json', 'utf8'),
) as ManifestEntry[];
const ingestion = new IngestionService(db, provider, manifest);
for (const entry of manifest)
  await ingestion.ingest(entry.filename, await readFile(`data/corpus/policy/${entry.filename}`));
const catalog = await loadProductCatalog();
const policies = Object.values(catalog).flatMap((entry) => entry.policies);
await seedRejection(db, catalog['PL-100'].policies);
const config = configSchema.parse({
  DATABASE_URL: url,
  ALLOW_DEMO_MODE: 'true',
  EMBEDDING_DIMENSIONS: '64',
  RETRIEVAL_MIN_SIMILARITY: '0',
});
const app = await createApi({
  caseReviews: await createCaseReviews(db),
  auth: new AuthService(new PostgresAuthStore(db), credentials, 8),
  decisions: new DecisionService(new PostgresDecisionStore(db, policies, catalog)),
  operations: await createOperations(db, provider, config, catalog),
  maxUploadBytes: 10 * 1024 * 1024,
  webOrigin: 'http://127.0.0.1:5174',
  secureCookies: false,
  sessionHours: 8,
});
await app.listen(4304, '127.0.0.1');
console.log('E2E API ready on4304: fake provider, dedicated test database only.');
const shutdown = async () => {
  await app.close();
  await db.destroy();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
