import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Actor } from '../../domain/src/access.js';
import type { NormalizedDocument } from '../../contracts/src/documents.js';
import { productIds, type ProductId } from '../../contracts/src/products.js';
import type {
  AssessmentStreamEvent,
  QuestionStreamEvent,
  StreamFrame,
} from '../../contracts/src/streams.js';
import { QuestionStreams } from './question-streams.js';
import { maskPolicyQuestion, type answerPolicyQuestion } from './questions.js';
import { invariant } from '../../domain/src/errors.js';
import { resolveMode, type AssessmentMode } from '../../domain/src/evidence-mode.js';
import { parseApplicationForm } from './application-form.js';
import { selectPolicy, type Policy } from '../../domain/src/policy.js';

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
}
export interface KnowledgePort {
  ingest(filename: string, bytes: Uint8Array, mime?: string): Promise<unknown>;
  documents(): Promise<unknown>;
  attempts(): Promise<unknown>;
}
export interface OperationDependencies {
  policies: Record<ProductId, Policy[]>;
  store: ApplicationStore;
  knowledge: KnowledgePort;
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
  }): ReturnType<typeof answerPolicyQuestion>;
  calculate(input: unknown): unknown;
  settings: { allowDemo: boolean; defaultMode?: AssessmentMode };
  newId(): string;
}
export class OperationsService {
  private readonly questionStreams = new QuestionStreams();
  constructor(private readonly deps: OperationDependencies) {}
  async ingest(actor: Actor, uploads: Upload[]) {
    invariant(
      actor.canIngest,
      'Forbidden',
      'Reviewed knowledge ingestion permission required',
      403,
    );
    invariant(uploads.length > 0 && uploads.length <= 20, 'InvalidUpload', 'Select1–20 files');
    const results = [];
    for (const upload of uploads) {
      try {
        results.push({
          filename: upload.filename,
          result: await this.deps.knowledge.ingest(upload.filename, upload.bytes, upload.mime),
          status: 'succeeded',
        });
      } catch (error) {
        results.push({
          filename: upload.filename,
          status: 'failed',
          code: error instanceof Error ? error.name : 'IngestionFailed',
        });
      }
    }
    return { results };
  }
  documents() {
    return this.deps.knowledge.documents();
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
      return await this.deps.assess(
        {
          document: job.document,
          actorId: actor.id,
          synthetic: job.synthetic,
          requestedMode,
          at: new Date().toISOString(),
        },
        { runId: job.runId, applicationId: id, requestId },
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
    const policies = this.deps.policies[product];
    const asOfDate =
      input.asOfDate ??
      dates[0] ??
      policies.find((p) => p.edition === edition)?.effectiveFrom ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
    if (edition)
      invariant(
        selectPolicy(policies, asOfDate).edition === edition,
        'ConflictingEdition',
        'Selected date does not belong to the requested edition',
      );
    return { question: input.question, product, asOfDate };
  }
  async question(raw: unknown) {
    return this.deps.ask(this.resolveQuestion(raw));
  }
  startQuestionStream(actor: Actor, raw: unknown, key: unknown) {
    const requestKey = this.requestKey(key);
    const question = this.resolveQuestion(raw);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...question, question: maskPolicyQuestion(question.question) }))
      .digest('hex');
    return this.questionStreams.start(actor.id, requestKey, fingerprint, this.deps.newId, () =>
      this.deps.ask(question),
    );
  }
  questionEvents(actor: Actor, id: string): StreamFrame<QuestionStreamEvent>[] {
    return this.questionStreams.read(actor.id, z.uuid().parse(id));
  }
  calculate(raw: unknown) {
    return this.deps.calculate(raw);
  }
  evidence(actor: Actor, id: string) {
    z.uuid().parse(id);
    return this.deps.store.evidence(actor, id);
  }
  offer(actor: Actor, id: string) {
    z.uuid().parse(id);
    return this.deps.store.offer(actor, id);
  }
}
