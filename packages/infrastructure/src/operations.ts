import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { Config } from '../../contracts/src/config.js';
import { OperationsService } from '../../application/src/operations.js';
import type { GenerationPort, EmbeddingPort } from '../../application/src/ports.js';
import { answerPolicyQuestion } from '../../application/src/questions.js';
import { answerCalculationQuestion } from '../../application/src/calculation-question.js';
import { invariant } from '../../domain/src/errors.js';
import type { Policy, Product } from '../../domain/src/policy.js';
import { ParserRegistry } from './parsers/registry.js';
import { extractPricing } from './parsers/pricing.js';
import { IngestionService, type ManifestEntry } from './knowledge/ingestion.js';
import { RetrievalService } from './knowledge/retrieval.js';
import { PostgresAssessmentClauses } from './knowledge/assessment-clauses.js';
import { PostgresAssessmentRepository } from './db/assessment-repository.js';
import { PostgresApplicationStore } from './db/application-store.js';
import { createDocumentAssessmentWorkflow } from './workflows/document-assessment.js';
export async function createOperations(
  db: DataSource,
  provider: GenerationPort & EmbeddingPort,
  config: Config,
) {
  const parser = new ParserRegistry(config.UPLOAD_MAX_BYTES);
  const policies = JSON.parse(await readFile('data/config/policies.json', 'utf8')) as Policy[];
  const product = JSON.parse(await readFile('data/config/personal-loan.json', 'utf8')) as Product;
  const manifest = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  ) as ManifestEntry[];
  const pricing = extractPricing(
    await parser.extract(
      'pricing-table.csv',
      await readFile('data/corpus/policy/pricing-table.csv'),
    ),
  );
  const extractionPrompt = await readFile('prompts/extraction.txt', 'utf8'),
    questionPrompt = await readFile('prompts/questions.txt', 'utf8');
  const fixtures = [];
  for (let n = 1; n <= 5; n++) {
    const reference = `APP-00${n}`,
      filename = `${reference}.pdf`,
      bytes = await readFile(`data/corpus/evidence/${filename}`);
    fixtures.push({
      reference,
      filename,
      bytes,
      hash: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const ingestion = new IngestionService(db, provider, manifest, parser),
    search = new RetrievalService(db, provider, config.RETRIEVAL_STRATEGY);
  return new OperationsService({
    policies,
    store: new PostgresApplicationStore(db),
    newId: randomUUID,
    fixtures,
    settings: { allowDemo: config.ALLOW_DEMO_MODE, defaultMode: config.ASSESSMENT_MODE },
    parse: (upload) => parser.extract(upload.filename, upload.bytes, upload.mime),
    knowledge: {
      ingest: (name, bytes, mime) => ingestion.ingest(name, bytes, mime),
      documents: () =>
        db.query(
          'SELECT id,filename,metadata,pipeline_version,created_at FROM knowledge.documents ORDER BY id',
        ),
      attempts: () =>
        db.query(
          'SELECT id,filename,status,error_code,created_at FROM knowledge.ingestion_attempts ORDER BY created_at DESC LIMIT 100',
        ),
    },
    ask: (input) =>
      answerPolicyQuestion(input, {
        provider,
        search,
        prompt: questionPrompt,
        minimumSimilarity: config.RETRIEVAL_MIN_SIMILARITY,
      }),
    calculate: (raw) => answerCalculationQuestion(raw, { policies, product, pricing }),
    assess: async (input, context) => {
      const workflow = createDocumentAssessmentWorkflow({
        provider,
        prompt: extractionPrompt,
        policies,
        product,
        pricing,
        settings: { allowDemo: config.ALLOW_DEMO_MODE, defaultMode: config.ASSESSMENT_MODE },
        clauses: new PostgresAssessmentClauses(db),
        persistence: { ...context, repository: new PostgresAssessmentRepository(db) },
      });
      const outcome = await (await workflow.createRun()).start({ inputData: input });
      invariant(
        outcome.status === 'success',
        'AssessmentFailed',
        'Assessment could not be completed',
        503,
      );
      return { runId: context.runId, result: outcome.result.result };
    },
  });
}
