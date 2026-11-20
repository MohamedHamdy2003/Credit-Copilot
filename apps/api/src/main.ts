import 'reflect-metadata';
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createApi } from './app.js';
import { configSchema } from '../../../packages/contracts/src/config.js';
import { createDataSource } from '../../../packages/infrastructure/src/db/data-source.js';
import { PostgresAuthStore } from '../../../packages/infrastructure/src/auth/store.js';
import { ScryptCredentials } from '../../../packages/infrastructure/src/auth/passwords.js';
import { AuthService } from '../../../packages/application/src/auth.js';
import { DecisionService } from '../../../packages/application/src/decisions.js';
import { PostgresDecisionStore } from '../../../packages/infrastructure/src/db/decision-store.js';
import type { Policy } from '../../../packages/domain/src/policy.js';
import { GeminiAdapter } from '../../../packages/infrastructure/src/llm/gemini.js';
import { createOperations } from '../../../packages/infrastructure/src/operations.js';
import { createCaseReviews } from '../../../packages/infrastructure/src/db/case-review-store.js';
const config = configSchema.parse(process.env);
const db = await createDataSource(config.DATABASE_URL).initialize();
const policies = JSON.parse(await readFile('data/config/policies.json', 'utf8')) as Policy[];
const app = await createApi({
  caseReviews: await createCaseReviews(db),
  operations: await createOperations(
    db,
    new GeminiAdapter(
      config.GEMINI_API_KEY,
      config.GENERATION_MODEL,
      config.EMBEDDING_MODEL,
      config.EMBEDDING_DIMENSIONS,
    ),
    config,
  ),
  maxUploadBytes: config.UPLOAD_MAX_BYTES,
  auth: new AuthService(
    new PostgresAuthStore(db),
    new ScryptCredentials(),
    config.SESSION_TTL_HOURS,
  ),
  decisions: new DecisionService(new PostgresDecisionStore(db, policies)),
  webOrigin: config.WEB_ORIGIN,
  secureCookies: config.COOKIE_SECURE,
  sessionHours: config.SESSION_TTL_HOURS,
});
await app.listen(config.PORT, '127.0.0.1');
console.log(`Credit Copilot API: http://127.0.0.1:${config.PORT}/api/docs`);
const shutdown = async () => {
  await app.close();
  if (db.isInitialized) await db.destroy();
};
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
