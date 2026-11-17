import 'dotenv/config';
import { configSchema } from '../packages/contracts/src/config.js';
import { createDataSource } from '../packages/infrastructure/src/db/data-source.js';
const config = configSchema.parse(process.env);
const database = await createDataSource(config.DATABASE_URL).initialize();
try {
  const migrations = await database.runMigrations();
  console.log(`Applied ${migrations.length} migration(s).`);
} finally {
  await database.destroy();
}
