import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Actor } from '../../domain/src/access.js';
import {
  customPolicyMetadataSchema,
  type CustomPolicyMetadata,
  type NormalizedDocument,
} from '../../contracts/src/documents.js';
import type { IssuedOfferDocument } from '../../contracts/src/offers.js';
import {
  generationProviderUpdateSchema,
  type GenerationProviderUpdate,
  type LlmProviderStatus,
} from '../../contracts/src/llm.js';
import { productIds, type ProductId } from '../../contracts/src/products.js';
import type {
  AssessmentStreamEvent,
  IngestionStage,
  IngestionStreamEvent,
  QuestionStreamEvent,
  StreamFrame,
} from '../../contracts/src/streams.js';
import { IngestionStreams } from './ingestion-streams.js';
import { QuestionStreams } from './question-streams.js';
import { maskPolicyQuestion, type answerPolicyQuestion } from './questions.js';
import { DomainError, invariant } from '../../domain/src/errors.js';
import { resolveMode, type AssessmentMode } from '../../domain/src/evidence-mode.js';
import { parseApplicationForm } from './application-form.js';
import { selectPolicy, type Policy } from '../../domain/src/policy.js';
import type { UsagePort } from './usage.js';

export interface Upload {
  filename: string;
  bytes: Uint8Array;
  mime?: string;
}
export interface ApplicationStore {
  register(actor: Actor, document: NormalizedDocument, bytes: Uint8Array): Promise<unknown>;
  list(actor: Actor): Promise<unknown>;
  read(
    actor: Actor,
    id: string,
  ): Promise<{
    id: string;
    document: NormalizedDocument;
    synthetic: boolean;
    latestAssessmentId: string | null;
    preparerId: string;
  }>;
  start(
    actor: Actor,
    id: string,
    key: string,
    mode: AssessmentMode,
    resume?: boolean,
  ): Promise<{
    runId: string;
    document: NormalizedDocument;
    synthetic: boolean;
    existing?: unknown;
    resumed?: true;
  }>;
  assessmentEvents(actor: Actor, runId: string): Promise<StreamFrame<AssessmentStreamEvent>[]>;
  fail(runId: string, code: string): Promise<void>;
  evidence(actor: Actor, id: string): Promise<{ filename: string; bytes: Uint8Array }>;
  offer(actor: Actor, id: string): Promise<unknown>;
  offerDocument(actor: Actor, id: string): Promise<IssuedOfferDocument>;
}
export interface KnowledgeIngestionProgress {
  stage: IngestionStage;
  status: 'running' | 'completed' | 'skipped' | 'failed';
  detail?: string;
  current?: number;
  total?: number;
}
export interface KnowledgePort {
  ingest(
    filename: string,
    bytes: Uint8Array,
    mime?: string,
    options?: {
      customMetadata?: CustomPolicyMetadata;
      onProgress?: (event: KnowledgeIngestionProgress) => void;
    },
  ): Promise<{
    id: string;
    documentId: string;
    filename: string;
    status: 'succeeded' | 'skipped';
    chunks: number;
    stages: KnowledgeIngestionProgress[];
  }>;
  deleteDocument(id: string): Promise<{ deleted: true; id: string; filename: string }>;
  documents(): Promise<unknown>;
  attempts(): Promise<unknown>;
  source(filename: string): Promise<{
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }>;
}
export interface LlmControlPort {
  status(canManage: boolean): Promise<LlmProviderStatus>;
  configure(update: GenerationProviderUpdate): Promise<LlmProviderStatus>;
}
export interface OperationDependencies {
  policies: Record<ProductId, Policy[]>;
  store: ApplicationStore;
  usage: UsagePort;
  knowledge: KnowledgePort;
  llm?: LlmControlPort;
  parse(upload: Upload): Promise<NormalizedDocument>;
  fixtures: { reference: string; filename: string; hash: string; bytes: Uint8Array }[];
  assess(
    input: {
      document: NormalizedDocument;
      actorId: string;
      synthetic: boolean;
      requestedMode?: AssessmentMode;
      at: string;
    },
    context: { runId: string; applicationId: string; requestId: string },
  ): Promise<unknown>;
  ask(input: {
    question: string;
    asOfDate: string;
    product: string;
    context?: string[];
  }): ReturnType<typeof answerPolicyQuestion>;
  calculate(input: unknown): unknown;
  settings: { allowDemo: boolean; defaultMode?: AssessmentMode };
  newId(): string;
}
export class OperationsService {
  private readonly questionStreams = new QuestionStreams();
  private readonly ingestionStreams = new IngestionStreams();
  constructor(private readonly deps: OperationDependencies) {}
  private parseCustomMetadata(raw: unknown, fileCount: number): CustomPolicyMetadata | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    let parsedRaw: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsedRaw = JSON.parse(raw);
      } catch {
        throw new DomainError(
          'InvalidPolicyMetadata',
          'Custom policy metadata must be valid JSON',
          422,
        );
      }
    }
    const metadata = customPolicyMetadataSchema.parse(parsedRaw);
    invariant(
      fileCount === 1 || !metadata.id,
      'InvalidUpload',
      'Custom document ID can only be set when uploading a single policy file',
    );
    return metadata;
  }
  async ingest(actor: Actor, uploads: Upload[], requestId: string, rawMetadata?: unknown) {
    invariant(
      actor.canIngest,
      'Forbidden',
      'Reviewed knowledge ingestion permission required',
      403,
    );
    invariant(uploads.length > 0 && uploads.length <= 20, 'InvalidUpload', 'Select 1–20 files');
    const customMetadata = this.parseCustomMetadata(rawMetadata, uploads.length);
    return this.deps.usage.track(
      { actorId: actor.id, requestId, operation: 'knowledge_ingestion' },
      async () => {
        const results = [];
        for (const upload of uploads) {
          try {
            results.push({
              filename: upload.filename,
              result: await this.deps.knowledge.ingest(upload.filename, upload.bytes, upload.mime, {
                customMetadata,
              }),
              status: 'succeeded',
            });
          } catch (error) {
            results.push({
              filename: upload.filename,
              status: 'failed',
              code:
                error instanceof DomainError
                  ? error.code
                  : error instanceof Error
                    ? error.name
                    : 'IngestionFailed',
            });
          }
        }
        return { results };
      },
    );
  }
  startIngestionStream(actor: Actor, uploads: Upload[], requestId: string, rawMetadata?: unknown) {
    invariant(
      actor.canIngest,
      'Forbidden',
      'Reviewed knowledge ingestion permission required',
      403,
    );
    invariant(uploads.length > 0 && uploads.length <= 20, 'InvalidUpload', 'Select 1–20 files');
    const customMetadata = this.parseCustomMetadata(rawMetadata, uploads.length);
    return this.ingestionStreams.start(actor.id, this.deps.newId, async (emit) => {
      await this.deps.usage.track(
        { actorId: actor.id, requestId, operation: 'knowledge_ingestion' },
        async () => {
          let succeeded = 0,
            skipped = 0,
            failed = 0;
          for (const [fileIndex, upload] of uploads.entries()) {
            try {
              const outcome = await this.deps.knowledge.ingest(
                upload.filename,
                upload.bytes,
                upload.mime,
                {
                  customMetadata,
                  onProgress: (event) =>
                    emit({
                      kind: 'stage',
                      fileIndex,
                      filename: upload.filename,
                      ...event,
                    }),
                },
              );
              if (outcome.status === 'skipped') skipped++;
              else succeeded++;
              emit({
                kind: 'file_completed',
                fileIndex,
                filename: upload.filename,
                status: outcome.status,
                documentId: outcome.documentId,
                chunks: outcome.chunks,
              });
            } catch (error) {
              failed++;
              emit({
                kind: 'file_completed',
                fileIndex,
                filename: upload.filename,
                status: 'failed',
                code:
                  error instanceof DomainError
                    ? error.code
                    : error instanceof Error
                      ? error.name
                      : 'IngestionFailed',
                message: error instanceof DomainError ? error.message : 'Document ingestion failed',
              });
            }
          }
          emit({
            kind: 'completed',
            totalFiles: uploads.length,
            succeeded,
            skipped,
            failed,
          });
        },
      );
    });
  }
  ingestionEvents(actor: Actor, id: string): StreamFrame<IngestionStreamEvent>[] {
    invariant(
      actor.canIngest,
      'Forbidden',
      'Reviewed knowledge ingestion permission required',
      403,
    );
    return this.ingestionStreams.read(actor.id, z.uuid().parse(id));
  }
  deleteDocument(actor: Actor, id: unknown) {
    invariant(
      actor.canIngest,
      'Forbidden',
      'Reviewed knowledge ingestion permission required',
      403,
    );
    return this.deps.knowledge.deleteDocument(z.string().trim().min(1).max(64).parse(id));
  }
  documents() {
    return this.deps.knowledge.documents();
  }
  source(filename: unknown) {
    return this.deps.knowledge.source(z.string().trim().min(1).max(255).parse(filename));
  }
  attempts(actor: Actor) {
    invariant(actor.canIngest, 'Forbidden', 'Ingestion permission required', 403);
    return this.deps.knowledge.attempts();
  }
  fixtures() {
    return this.deps.fixtures.map(({ reference, filename }) => ({ reference, filename }));
  }
  async upload(actor: Actor, upload: Upload) {
    const document = await this.deps.parse(upload);
    const fixture = this.deps.fixtures.find((entry) => entry.hash === document.hash);
    invariant(
      fixture,
      'UnrecognizedSyntheticPack',
      'Only reviewed synthetic application packs are accepted',
      403,
    );
    parseApplicationForm(document);
    return this.deps.store.register(
      actor,
      { ...document, filename: fixture.filename },
      upload.bytes,
    );
  }
  async selectFixture(actor: Actor, reference: string) {
    const fixture = this.deps.fixtures.find((f) => f.reference === reference);
    invariant(fixture, 'NotFound', 'Synthetic fixture not found', 404);
    return this.upload(actor, {
      filename: fixture.filename,
      bytes: fixture.bytes,
      mime: 'application/pdf',
    });
  }
  list(actor: Actor) {
    return this.deps.store.list(actor);
  }
  async read(actor: Actor, id: string) {
    z.uuid().parse(id);
    const record = await this.deps.store.read(actor, id);
    return {
      id: record.id,
      synthetic: record.synthetic,
      latestAssessmentId: record.latestAssessmentId,
      canAssess: record.preparerId === actor.id,
      form: parseApplicationForm(record.document),
    };
  }
  private async reserveAssessment(
    actor: Actor,
    id: string,
    raw: unknown,
    key: string,
    resume = false,
  ) {
    z.uuid().parse(id);
    const input = z
      .object({ mode: z.enum(['strict', 'demo']).optional() })
      .strict()
      .parse(raw);
    const record = await this.deps.store.read(actor, id);
    const mode = resolveMode(input.mode, this.deps.settings, record.synthetic);
    const job = await this.deps.store.start(actor, id, key, mode, resume);
    return { job, requestedMode: input.mode };
  }
  private async executeAssessment(
    job: Awaited<ReturnType<ApplicationStore['start']>>,
    requestedMode: AssessmentMode | undefined,
    actor: Actor,
    id: string,
    requestId: string,
  ) {
    try {
      return await this.deps.usage.track(
        { actorId: actor.id, requestId, runId: job.runId, operation: 'assessment' },
        () =>
          this.deps.assess(
            {
              document: job.document,
              actorId: actor.id,
              synthetic: job.synthetic,
              requestedMode,
              at: new Date().toISOString(),
            },
            { runId: job.runId, applicationId: id, requestId },
          ),
      );
    } catch (error) {
      await this.deps.store.fail(
        job.runId,
        error instanceof Error ? error.name : 'AssessmentFailed',
      );
      throw error;
    }
  }
  private requestKey(key: unknown) {
    return z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .parse(key);
  }
  async assess(actor: Actor, id: string, raw: unknown, requestId: string, key?: string) {
    const { job, requestedMode } = await this.reserveAssessment(
      actor,
      id,
      raw,
      this.requestKey(key ?? this.deps.newId()),
    );
    if (job.existing) return job.existing;
    return this.executeAssessment(job, requestedMode, actor, id, requestId);
  }
  async startAssessmentStream(
    actor: Actor,
    id: string,
    raw: unknown,
    requestId: string,
    key: unknown,
  ) {
    const { job, requestedMode } = await this.reserveAssessment(
      actor,
      id,
      raw,
      this.requestKey(key),
      true,
    );
    if (!job.resumed) {
      // The accepted job owns its lifecycle even if the initiating connection closes.
      void this.executeAssessment(job, requestedMode, actor, id, requestId).catch(() => undefined);
    }
    return { runId: job.runId };
  }
  assessmentEvents(actor: Actor, id: string) {
    return this.deps.store.assessmentEvents(actor, z.uuid().parse(id));
  }
  private resolveQuestion(raw: unknown) {
    const input = z
      .object({
        question: z.string().trim().min(1).max(2000),
        asOfDate: z.iso.date().optional(),
        product: z.enum(productIds).optional(),
        edition: z.enum(['CP-2024', 'CP-2025', 'AUTO-2025']).optional(),
        context: z.array(z.string().trim().min(1).max(2000)).max(3).optional(),
      })
      .strict()
      .parse(raw);
    const editions = [
      ...new Set(
        input.question.match(/\b(?:CP-20(?:24|25)|AUTO-2025)\b/gi)?.map((e) => e.toUpperCase()) ??
          [],
      ),
    ];
    const dates = [...new Set(input.question.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])];
    const circulars = [
      ...new Set(
        [...input.question.matchAll(/\bcircular\s+(20\d{2}\/\d{2})\b/gi)].map((m) => m[1]!),
      ),
    ];
    // Strip document identifiers and full dates before inspecting standalone policy years.
    const withoutIdentifiers = input.question
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
      .replace(/\b(?:CP-20(?:24|25)|AUTO-2025|PT-20\d{2}-\d{2}|PM-CC-20\d{2})\b/gi, ' ')
      .replace(/\bcircular\s+20\d{2}\/\d{2}\b/gi, ' ');
    const standaloneYears = [...new Set(withoutIdentifiers.match(/\b20\d{2}\b/g) ?? [])];
    const hasExplicitScope = Boolean(input.asOfDate || input.edition || dates.length > 0);
    invariant(
      editions.length <= 1 && dates.length <= 1,
      'AmbiguousPolicyQuestion',
      'Specify one policy edition and one as-of date',
    );
    invariant(
      !input.edition || !editions[0] || input.edition === editions[0],
      'ConflictingEdition',
      'Question and edition selector disagree',
    );
    invariant(
      !input.asOfDate || !dates[0] || input.asOfDate === dates[0],
      'ConflictingDate',
      'Question and date selector disagree',
    );
    const edition = input.edition ?? editions[0];
    const editionProduct = edition === 'AUTO-2025' ? 'AL-200' : edition ? 'PL-100' : undefined;
    invariant(
      !editionProduct || !input.product || editionProduct === input.product,
      'ConflictingProduct',
      'Policy edition belongs to a different product',
    );
    const product = input.product ?? editionProduct ?? 'PL-100';
    const context = [...new Set(input.context ?? [])];
    invariant(
      context.reduce((total, question) => total + question.length, 0) <= 3000,
      'QuestionContextTooLong',
      'Follow-up context must not exceed 3000 characters',
    );
    const policies = this.deps.policies[product];
    const circularEffectiveDates: Record<string, string> = {
      '2024/07': '2024-08-01',
      '2025/02': '2025-03-01',
    };
    const circularDate =
      !hasExplicitScope && !edition && circulars.length === 1
        ? circularEffectiveDates[circulars[0]!]
        : undefined;
    let yearStartDate: string | undefined;
    if (!hasExplicitScope && !edition && !circularDate && standaloneYears.length === 1) {
      const referencedYear = standaloneYears[0]!;
      const yearStart = `${referencedYear}-01-01`;
      const yearEnd = `${Number(referencedYear) + 1}-01-01`;
      const yearPolicies = policies.filter(
        (policy) =>
          policy.effectiveFrom < yearEnd && (!policy.effectiveTo || policy.effectiveTo > yearStart),
      );
      if (yearPolicies.length > 1) {
        invariant(
          false,
          'AmbiguousPolicyYear',
          `${referencedYear} includes multiple policy editions. Select an edition or an exact date.`,
        );
      }
      yearStartDate =
        yearPolicies.length === 1
          ? yearPolicies[0]!.effectiveFrom > yearStart
            ? yearPolicies[0]!.effectiveFrom
            : yearStart
          : yearStart;
    }
    const asOfDate =
      input.asOfDate ??
      dates[0] ??
      circularDate ??
      yearStartDate ??
      policies.find((p) => p.edition === edition)?.effectiveFrom ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
    if (edition)
      invariant(
        selectPolicy(policies, asOfDate).edition === edition,
        'ConflictingEdition',
        'Selected date does not belong to the requested edition',
      );
    return { question: input.question, product, asOfDate, context };
  }
  async question(actor: Actor, raw: unknown, requestId: string) {
    const question = this.resolveQuestion(raw);
    return this.deps.usage.track(
      { actorId: actor.id, requestId, operation: 'policy_question' },
      () => this.deps.ask(question),
    );
  }
  startQuestionStream(actor: Actor, raw: unknown, key: unknown, requestId: string) {
    const requestKey = this.requestKey(key);
    const question = this.resolveQuestion(raw);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          ...question,
          question: maskPolicyQuestion(question.question),
          context: question.context.map(maskPolicyQuestion),
        }),
      )
      .digest('hex');
    return this.questionStreams.start(actor.id, requestKey, fingerprint, this.deps.newId, () =>
      this.deps.usage.track({ actorId: actor.id, requestId, operation: 'policy_question' }, () =>
        this.deps.ask(question),
      ),
    );
  }
  questionEvents(actor: Actor, id: string): StreamFrame<QuestionStreamEvent>[] {
    return this.questionStreams.read(actor.id, z.uuid().parse(id));
  }
  calculate(raw: unknown) {
    return this.deps.calculate(raw);
  }
  usage(actor: Actor, query: unknown) {
    const { runId } = z.object({ runId: z.uuid().optional() }).strict().parse(query);
    return this.deps.usage.summarize(actor.id, runId);
  }
  evidence(actor: Actor, id: string) {
    z.uuid().parse(id);
    return this.deps.store.evidence(actor, id);
  }
  offer(actor: Actor, id: string) {
    z.uuid().parse(id);
    return this.deps.store.offer(actor, id);
  }
  offerDocument(actor: Actor, id: string) {
    z.uuid().parse(id);
    return this.deps.store.offerDocument(actor, id);
  }
  llmStatus(actor: Actor): Promise<LlmProviderStatus> {
    invariant(
      this.deps.llm,
      'ServiceUnavailable',
      'LLM provider management is not configured',
      503,
    );
    return this.deps.llm.status(actor.tier === 'head');
  }
  setLlmProvider(actor: Actor, raw: unknown): Promise<LlmProviderStatus> {
    invariant(
      actor.tier === 'head',
      'Forbidden',
      'Only Head Credit Officer may change the active LLM provider',
      403,
    );
    invariant(
      this.deps.llm,
      'ServiceUnavailable',
      'LLM provider management is not configured',
      503,
    );
    const update = generationProviderUpdateSchema.parse(raw);
    return this.deps.llm.configure(update);
  }
}
