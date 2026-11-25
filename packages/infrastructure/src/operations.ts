import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { Config } from '../../contracts/src/config.js';
import { OperationsService } from '../../application/src/operations.js';
import { parseApplicationForm } from '../../application/src/application-form.js';
import type { GenerationPort, EmbeddingPort } from '../../application/src/ports.js';
import { answerPolicyQuestion } from '../../application/src/questions.js';
import { answerCalculationQuestion } from '../../application/src/calculation-question.js';
import { invariant } from '../../domain/src/errors.js';
import { ParserRegistry } from './parsers/registry.js';
import { loadAssessmentFixtures, loadProductCatalog } from './product-catalog.js';
import { IngestionService, type ManifestEntry } from './knowledge/ingestion.js';
import { RetrievalService } from './knowledge/retrieval.js';
import { PostgresAssessmentClauses } from './knowledge/assessment-clauses.js';
import { PostgresAssessmentRepository } from './db/assessment-repository.js';
import { PostgresApplicationStore } from './db/application-store.js';
import { createDocumentAssessmentWorkflow } from './workflows/document-assessment.js';
import { assessmentAgents } from './workflows/assessment-agents.js';
import { PostgresUsageStore } from './db/usage-store.js';
import { instrumentProvider } from './llm/attempt-meter.js';
import { UsageTracker, withUsageStep } from './llm/usage-tracker.js';
export async function createOperations(
  db: DataSource,
  rawProvider: GenerationPort & EmbeddingPort,
  config: Config,
  catalog?: Awaited<ReturnType<typeof loadProductCatalog>>,
) {
  const parser = new ParserRegistry(config.UPLOAD_MAX_BYTES);
  const provider = instrumentProvider(rawProvider);
  const usage = new UsageTracker(new PostgresUsageStore(db), config.GEMINI_BILLING_TIER);
  const products = catalog ?? (await loadProductCatalog(parser));
  const manifest = JSON.parse(
    await readFile('data/config/corpus-manifest.json', 'utf8'),
  ) as ManifestEntry[];
  const extractionPrompt = await readFile('prompts/extraction.txt', 'utf8'),
    questionPrompt = await readFile('prompts/questions.txt', 'utf8');
  const fixtures = await loadAssessmentFixtures();
  const excludedHashes = new Set(fixtures.map((entry) => entry.hash));
  const ingestion = new IngestionService(db, provider, manifest, parser, excludedHashes),
    search = new RetrievalService(db, provider, config.RETRIEVAL_STRATEGY, config);
  const store = new PostgresApplicationStore(db);
  return new OperationsService({
    policies: { 'PL-100': products['PL-100'].policies, 'AL-200': products['AL-200'].policies },
    store,
    usage,
    newId: randomUUID,
    fixtures,
    settings: { allowDemo: config.ALLOW_DEMO_MODE, defaultMode: config.ASSESSMENT_MODE },
    parse: (upload) => parser.extract(upload.filename, upload.bytes, upload.mime),
    knowledge: {
      ingest: (name, bytes, mime, options) => ingestion.ingest(name, bytes, mime, options),
      deleteDocument: (id) => ingestion.deleteDocument(id),
      source: async (filename) => {
        invariant(!/[\\/]/.test(filename), 'NotFound', 'Policy source not found', 404);
        const entry = manifest.find((candidate) => candidate.filename === filename);
        if (entry) {
          const bytes = await readFile(`data/corpus/policy/${entry.filename}`);
          invariant(
            createHash('sha256').update(bytes).digest('hex') === entry.sha256,
            'UntrustedPolicyDocument',
            'Reviewed policy source failed integrity verification',
            409,
          );
          return {
            filename: entry.filename,
            contentType: entry.filename.toLowerCase().endsWith('.pdf')
              ? 'application/pdf'
              : 'text/plain; charset=utf-8',
            bytes,
          };
        }
        const rows = (await db.query(
          'SELECT filename, normalized FROM knowledge.documents WHERE filename=$1 LIMIT 1',
          [filename],
        )) as {
          filename: string;
          normalized: { blocks?: { originalText?: string; text: string }[] };
        }[];
        const stored = rows[0];
        invariant(stored, 'NotFound', 'Policy source not found', 404);
        const text = (stored.normalized.blocks ?? [])
          .map((block) => block.originalText ?? block.text)
          .join('\n\n');
        return {
          filename: stored.filename,
          contentType: 'text/plain; charset=utf-8',
          bytes: Buffer.from(text, 'utf8'),
        };
      },
      documents: () =>
        db.query(
          `SELECT d.id, d.filename, d.metadata, d.pipeline_version, d.created_at,
                  (SELECT count(*)::int FROM knowledge.chunks c WHERE c.document_id=d.id AND c.active) AS chunk_count
             FROM knowledge.documents d
            ORDER BY d.id`,
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
    calculate: (raw) => answerCalculationQuestion(raw, products['PL-100']),
    assess: async (input, context) => {
      const { productId } = parseApplicationForm(input.document);
      const workflow = createDocumentAssessmentWorkflow(
        {
          provider,
          withUsageStep,
          agents: assessmentAgents(config.ASSESSMENT_ORCHESTRATION),
          prompt: extractionPrompt,
          ...products[productId],
          settings: { allowDemo: config.ALLOW_DEMO_MODE, defaultMode: config.ASSESSMENT_MODE },
          clauses: new PostgresAssessmentClauses(db),
          persistence: { ...context, repository: new PostgresAssessmentRepository(db) },
        },
        (event) => store.recordAssessmentStage(context.runId, event),
      );
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
