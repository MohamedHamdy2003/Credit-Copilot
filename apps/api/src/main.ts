import 'reflect-metadata';
import 'dotenv/config';
import { createApi } from './app.js';
import { configSchema } from '../../../packages/contracts/src/config.js';
import { createDataSource } from '../../../packages/infrastructure/src/db/data-source.js';
import { PostgresAuthStore } from '../../../packages/infrastructure/src/auth/store.js';
import { ScryptCredentials } from '../../../packages/infrastructure/src/auth/passwords.js';
import { AuthService } from '../../../packages/application/src/auth.js';
import { DecisionService } from '../../../packages/application/src/decisions.js';
import { PostgresDecisionStore } from '../../../packages/infrastructure/src/db/decision-store.js';
import { loadProductCatalog } from '../../../packages/infrastructure/src/product-catalog.js';
import { ParserRegistry } from '../../../packages/infrastructure/src/parsers/registry.js';
import { createRuntimeProvider } from '../../../packages/infrastructure/src/llm/provider.js';
import { createOperations } from '../../../packages/infrastructure/src/operations.js';
import { createCaseReviews } from '../../../packages/infrastructure/src/db/case-review-store.js';
const config = configSchema.parse(process.env);
const db = await createDataSource(config.DATABASE_URL).initialize();
const catalog = await loadProductCatalog(new ParserRegistry(config.UPLOAD_MAX_BYTES));
const app = await createApi({
  caseReviews: await createCaseReviews(db),
  operations: await createOperations(db, createRuntimeProvider(config), config, catalog),
  maxUploadBytes: config.UPLOAD_MAX_BYTES,
  auth: new AuthService(
    new PostgresAuthStore(db),
    new ScryptCredentials(),
    config.SESSION_TTL_HOURS,
  ),
  decisions: new DecisionService(
    new PostgresDecisionStore(
      db,
      Object.values(catalog).flatMap((entry) => entry.policies),
      catalog,
    ),
  ),
  webOrigin: config.WEB_ORIGIN,
  secureCookies: config.COOKIE_SECURE,
  sessionHours: config.SESSION_TTL_HOURS,
});
await app.listen(config.PORT, config.API_HOST);
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
