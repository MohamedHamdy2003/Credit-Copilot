import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { configSchema } from '../packages/contracts/src/config.js';
import { createDataSource } from '../packages/infrastructure/src/db/data-source.js';
import { ScryptCredentials } from '../packages/infrastructure/src/auth/passwords.js';
import { invariant } from '../packages/domain/src/errors.js';
const config = configSchema.parse(process.env);
invariant(
  config.DEMO_PASSWORD.length >= 12 && config.DEMO_PASSWORD.length <= 256,
  'InvalidDemoPassword',
  'Set DEMO_PASSWORD locally to a unique12–256 character password before seeding',
);
const db = await createDataSource(config.DATABASE_URL).initialize();
try {
  const passwordHash = await new ScryptCredentials().hash(config.DEMO_PASSWORD);
  await db.transaction(async (manager) => {
    for (const [username, role, tier] of [
      ['loan-officer', 'loan_officer', 'none'],
      ['credit-officer', 'credit_officer', 'credit'],
      ['senior-credit-officer', 'credit_officer', 'senior'],
      ['head-credit', 'credit_officer', 'head'],
    ]) {
      await manager.query(
        'INSERT INTO cases.users(id,username,password_hash,role,tier,can_ingest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,role=excluded.role,tier=excluded.tier,can_ingest=excluded.can_ingest,active=true',
        [randomUUID(), username, passwordHash, role, tier, username === 'head-credit'],
      );
    }
    await manager.query(
      "DELETE FROM cases.sessions WHERE user_id IN (SELECT id FROM cases.users WHERE username IN ('loan-officer','credit-officer','senior-credit-officer','head-credit'))",
    );
  });
  console.log(
    'Seeded four synthetic demo accounts. Password never printed. Existing sessions revoked on password reset.',
  );
} finally {
  await db.destroy();
}
