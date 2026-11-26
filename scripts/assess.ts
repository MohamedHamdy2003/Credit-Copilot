import { randomUUID } from 'node:crypto';
import { runtime } from './runtime.js';
import { assessmentAgents } from '../packages/infrastructure/src/workflows/assessment-agents.js';
import { ParserRegistry } from '../packages/infrastructure/src/parsers/registry.js';
import { loadExtractionPrompt } from '../packages/infrastructure/src/llm/prompts.js';
import { PostgresAssessmentRepository } from '../packages/infrastructure/src/db/assessment-repository.js';
import { PostgresAssessmentClauses } from '../packages/infrastructure/src/knowledge/assessment-clauses.js';
import { createDocumentAssessmentWorkflow } from '../packages/infrastructure/src/workflows/document-assessment.js';
import { parseApplicationForm } from '../packages/application/src/application-form.js';
import { invariant } from '../packages/domain/src/errors.js';
import {
  loadAssessmentFixtures,
  loadProductCatalog,
} from '../packages/infrastructure/src/product-catalog.js';

const fixture = (await loadAssessmentFixtures()).find(
  (entry) => entry.reference === process.argv[2],
);
invariant(fixture, 'InvalidApplication', 'Select a reviewed APP or AUTO synthetic pack');
invariant(
  process.argv.slice(3).every((arg) => arg === '--demo'),
  'InvalidApplication',
  'Only --demo is supported',
);
const { db, provider, config } = await runtime();
try {
  const { bytes, filename } = fixture;
  const parser = new ParserRegistry(config.UPLOAD_MAX_BYTES);
  const document = await parser.extract(filename, bytes);
  const form = parseApplicationForm(document);
  const catalog = await loadProductCatalog(parser);
  // This CLI is local synthetic-fixture tooling, not a public authenticated endpoint.
  const runId = randomUUID();
  const { actorId, applicationId } = await db.transaction(async (manager) => {
    const newActorId = randomUUID();
    await manager.query(
      'INSERT INTO cases.users(id,username,password_hash,role,tier,active) VALUES($1,$2,$3,$4,$5,false) ON CONFLICT(username) DO NOTHING',
      [newActorId, 'cli-assessor', 'DISABLED_LOCAL_FIXTURE_ACCOUNT', 'loan_officer', 'none'],
    );
    const actorRows = (await manager.query('SELECT id FROM cases.users WHERE username=$1', [
      'cli-assessor',
    ])) as { id: string }[];
    const resolvedActorId = actorRows[0]!.id;
    const newAppId = randomUUID();
    const inserted = (await manager.query(
      'INSERT INTO cases.applications(id,reference,preparer_id,filename,hash,normalized,synthetic) VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(preparer_id,hash) DO NOTHING RETURNING id',
      [newAppId, form.reference, resolvedActorId, document.filename, document.hash, document],
    )) as { id: string }[];
    if (inserted.length) {
      await manager.query(
        'INSERT INTO cases.evidence_documents(id,application_id,requirement,original_bytes,hash) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), newAppId, 'application_pack', bytes, document.hash],
      );
      return { actorId: resolvedActorId, applicationId: newAppId };
    }
    const existingRows = (await manager.query(
      'SELECT id FROM cases.applications WHERE preparer_id=$1 AND hash=$2',
      [resolvedActorId, document.hash],
    )) as { id: string }[];
    return { actorId: resolvedActorId, applicationId: existingRows[0]!.id };
  });
  const workflow = createDocumentAssessmentWorkflow({
    provider,
    agents: assessmentAgents(config.ASSESSMENT_ORCHESTRATION),
    prompt: await loadExtractionPrompt(process.cwd()),
    ...catalog[form.productId],
    settings: { allowDemo: config.ALLOW_DEMO_MODE, defaultMode: config.ASSESSMENT_MODE },
    clauses: new PostgresAssessmentClauses(db),
    persistence: {
      repository: new PostgresAssessmentRepository(db),
      runId,
      applicationId,
      requestId: randomUUID(),
    },
  });
  const run = await workflow.createRun();
  const output = await run.start({
    inputData: {
      document,
      actorId,
      at: new Date().toISOString(),
      synthetic: true,
      ...(process.argv.includes('--demo') ? { requestedMode: 'demo' as const } : {}),
    },
  });
  if (output.status !== 'success')
    throw new Error('Assessment workflow failed; inspect database connectivity and configuration');
  console.log(JSON.stringify({ runId, applicationId, ...output.result.result }, null, 2));
} finally {
  await db.destroy();
}
