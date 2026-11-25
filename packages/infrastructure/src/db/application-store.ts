import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ZodError } from 'zod';
import type { Actor } from '../../../domain/src/access.js';
import type { ApplicationStore } from '../../../application/src/operations.js';
import type { AssessmentResult } from '../../../application/src/assessment-record.js';
import type { NormalizedDocument } from '../../../contracts/src/documents.js';
import { issuedOfferDocumentSchema } from '../../../contracts/src/offers.js';
import { parseApplicationForm } from '../../../application/src/application-form.js';
import { compareMoney } from '../../../domain/src/calculations.js';
import { DomainError, invariant } from '../../../domain/src/errors.js';
import type { AssessmentMode } from '../../../domain/src/evidence-mode.js';
import {
  ASSESSMENT_STAGES,
  assessmentStageEvent,
  type AssessmentStage,
  type AssessmentStreamEvent,
  type StreamFrame,
} from '../../../contracts/src/streams.js';
import {
  buildIssuedOfferDocument,
  recordedIssuerTier,
  type OfferApprovalRow,
} from './offer-document.js';
interface Stored {
  id: string;
  preparer_id: string;
  normalized: NormalizedDocument;
  synthetic: boolean;
  latest_assessment_id: string | null;
  filename: string;
}
interface StoredProgress {
  application_id: string;
  status: 'running' | 'succeeded' | 'failed';
  expired: boolean;
  progress: unknown[];
}
interface StoredOffer {
  id: string;
  run_id: string;
  approval_id: string;
  data: Record<string, unknown>;
  created_at: Date;
  preparer_id: string;
}
interface LegacyOfferProvenance extends OfferApprovalRow {
  issuer_id: string;
  issuer_tier: string | null;
  approval_authority: unknown;
  version: number;
  normalized: NormalizedDocument;
  result: AssessmentResult;
}
const assessmentProgressQuery = `
  SELECT j.application_id, j.status,
         (j.status='running' AND j.created_at < clock_timestamp()-interval '15 minutes') AS expired,
         COALESCE(r.result->'stageEvents', j.progress) AS progress
    FROM cases.assessment_jobs j
    JOIN cases.applications a ON a.id=j.application_id
    LEFT JOIN cases.assessment_runs r ON r.id=j.run_id
   WHERE j.run_id=$1 AND a.preparer_id=$2`;

export class PostgresApplicationStore implements ApplicationStore {
  constructor(private readonly db: DataSource) {}
  async register(
    actor: Actor,
    document: NormalizedDocument,
    bytes: Uint8Array,
    synthetic: boolean,
  ) {
    const form = parseApplicationForm(document);
    return this.db.transaction(async (manager) => {
      const active = (await manager.query(
        'SELECT id FROM cases.users WHERE id=$1 AND active FOR SHARE',
        [actor.id],
      )) as { id: string }[];
      invariant(active.length, 'Unauthenticated', 'Active user required', 401);
      const id = randomUUID();
      const inserted = (await manager.query(
        'INSERT INTO cases.applications(id,reference,preparer_id,filename,hash,normalized,synthetic) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(preparer_id,hash) DO NOTHING RETURNING id',
        [id, form.reference, actor.id, document.filename, document.hash, document, synthetic],
      )) as { id: string }[];
      if (!inserted.length) {
        const existing = (await manager.query(
          'SELECT id, synthetic FROM cases.applications WHERE preparer_id=$1 AND hash=$2',
          [actor.id, document.hash],
        )) as { id: string; synthetic: boolean }[];
        return {
          id: existing[0]!.id,
          reference: form.reference,
          synthetic: existing[0]!.synthetic,
          duplicate: true,
        };
      }
      await manager.query(
        'INSERT INTO cases.evidence_documents(id,application_id,requirement,original_bytes,hash) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), id, 'application_pack', Buffer.from(bytes), document.hash],
      );
      return { id, reference: form.reference, synthetic, duplicate: false };
    });
  }
  async deleteDraft(actor: Actor, id: string) {
    return this.db.transaction(async (manager) => {
      const active = (await manager.query(
        'SELECT id, role, tier FROM cases.users WHERE id=$1 AND active FOR SHARE',
        [actor.id],
      )) as { id: string; role: Actor['role']; tier: Actor['tier'] }[];
      invariant(active.length, 'Unauthenticated', 'Active user required', 401);
      const current = active[0]!;
      const rows = (await manager.query(
        'SELECT id, reference, preparer_id, latest_assessment_id FROM cases.applications WHERE id=$1 FOR UPDATE',
        [id],
      )) as {
        id: string;
        reference: string;
        preparer_id: string;
        latest_assessment_id: string | null;
      }[];
      const row = rows[0];
      invariant(row, 'NotFound', 'Application not found', 404);
      const isHead = current.role === 'credit_officer' && current.tier === 'head';
      invariant(
        row.preparer_id === current.id || isHead,
        'Forbidden',
        'Only the preparer or Head Credit Officer may delete a draft application',
        403,
      );
      const assessed = (await manager.query(
        `SELECT 1 FROM cases.assessment_runs WHERE application_id=$1
         UNION ALL
         SELECT 1 FROM cases.assessment_jobs WHERE application_id=$1
         LIMIT 1`,
        [id],
      )) as unknown[];
      invariant(
        row.latest_assessment_id === null && assessed.length === 0,
        'RetentionRequired',
        'Assessed applications must be retained under PM-8 record-keeping rules and cannot be deleted',
        409,
      );
      await manager.query('DELETE FROM cases.evidence_documents WHERE application_id=$1', [id]);
      await manager.query('DELETE FROM cases.applications WHERE id=$1', [id]);
      return { deleted: true as const, id: row.id, reference: row.reference };
    });
  }
  list(actor: Actor) {
    return this.db.query(
      `SELECT a.id,a.reference,a.synthetic,a.created_at,a.latest_assessment_id,r.status,
              (a.latest_assessment_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM cases.assessment_runs ar WHERE ar.application_id=a.id)
               AND NOT EXISTS (SELECT 1 FROM cases.assessment_jobs aj WHERE aj.application_id=a.id)
               AND (a.preparer_id=$1 OR $3)) AS can_delete
         FROM cases.applications a
         LEFT JOIN cases.assessment_runs r ON r.id=a.latest_assessment_id
        WHERE a.preparer_id=$1 OR $2
        ORDER BY a.created_at DESC
        LIMIT 100`,
      [
        actor.id,
        actor.role === 'credit_officer',
        actor.role === 'credit_officer' && actor.tier === 'head',
      ],
    );
  }
  async read(actor: Actor, id: string) {
    const rows = (await this.db.query('SELECT * FROM cases.applications WHERE id=$1', [
      id,
    ])) as Stored[];
    const row = rows[0];
    invariant(row, 'NotFound', 'Application not found', 404);
    invariant(
      row.preparer_id === actor.id || actor.role === 'credit_officer',
      'Forbidden',
      'Application access denied',
      403,
    );
    return {
      id: row.id,
      document: row.normalized,
      synthetic: row.synthetic,
      latestAssessmentId: row.latest_assessment_id,
      preparerId: row.preparer_id,
    };
  }
  async start(actor: Actor, id: string, key: string, mode: AssessmentMode, resume = false) {
    return this.db.transaction(async (manager) => {
      const rows = (await manager.query('SELECT * FROM cases.applications WHERE id=$1 FOR UPDATE', [
        id,
      ])) as Stored[];
      const row = rows[0];
      invariant(row, 'NotFound', 'Application not found', 404);
      invariant(
        row.preparer_id === actor.id,
        'Forbidden',
        'Only the preparer may assess this application',
        403,
      );
      await manager.query(
        "UPDATE cases.assessment_jobs SET status='failed',error_code='AssessmentInterrupted' WHERE application_id=$1 AND status='running' AND created_at<clock_timestamp()-interval '15 minutes'",
        [id],
      );
      const jobs = (await manager.query(
        'SELECT run_id,status,mode FROM cases.assessment_jobs WHERE application_id=$1 AND request_key=$2',
        [id, key],
      )) as { run_id: string; status: string; mode: string }[];
      if (jobs[0]) {
        invariant(
          jobs[0].mode === mode,
          'IdempotencyConflict',
          'Use a different key for a different assessment mode',
          409,
        );
        if (resume)
          return {
            runId: jobs[0].run_id,
            document: row.normalized,
            synthetic: row.synthetic,
            resumed: true as const,
          };
        const records = (await manager.query(
          'SELECT result FROM cases.assessment_runs WHERE id=$1',
          [jobs[0].run_id],
        )) as { result: unknown }[];
        if (records[0])
          return {
            runId: jobs[0].run_id,
            document: row.normalized,
            synthetic: row.synthetic,
            existing: { runId: jobs[0].run_id, result: records[0].result },
          };
        invariant(
          jobs[0].status !== 'running',
          'AssessmentInProgress',
          'Assessment is already running',
          409,
        );
        invariant(
          false,
          'PreviousAttemptFailed',
          'Use a new idempotency key after a failed attempt',
          409,
        );
      }
      const running = (await manager.query(
        "SELECT run_id FROM cases.assessment_jobs WHERE application_id=$1 AND status='running'",
        [id],
      )) as { run_id: string }[];
      invariant(
        !running.length,
        'AssessmentInProgress',
        'Another assessment is already running',
        409,
      );
      const issued = (await manager.query(
        'SELECT o.id FROM cases.offers o JOIN cases.assessment_runs r ON r.id=o.run_id WHERE r.application_id=$1',
        [id],
      )) as { id: string }[];
      invariant(
        !issued.length,
        'InvalidTransition',
        'Issued applications cannot be reassessed',
        409,
      );
      const runId = randomUUID();
      await manager.query(
        "INSERT INTO cases.assessment_jobs(run_id,application_id,request_key,mode,status) VALUES($1,$2,$3,$4,'running')",
        [runId, id, key, mode],
      );
      return { runId, document: row.normalized, synthetic: row.synthetic };
    });
  }
  async recordAssessmentStage(runId: string, event: unknown) {
    const stage = assessmentStageEvent.parse(event);
    await this.db.query(
      "UPDATE cases.assessment_jobs SET progress=progress || $2::jsonb WHERE run_id=$1 AND status='running'",
      [runId, JSON.stringify([stage])],
    );
  }
  async assessmentEvents(actor: Actor, runId: string) {
    const params = [runId, actor.id];
    const initial = (await this.db.query(assessmentProgressQuery, params)) as StoredProgress[];
    const job = initial[0]?.expired
      ? await this.db.transaction(async (manager) => {
          // Let a result already being saved settle before reporting a terminal interruption.
          await manager.query('SELECT id FROM cases.applications WHERE id=$1 FOR SHARE', [
            initial[0]!.application_id,
          ]);
          const settled = (await manager.query(
            assessmentProgressQuery,
            params,
          )) as StoredProgress[];
          return settled[0];
        })
      : initial[0];
    invariant(job, 'NotFound', 'Assessment stream not found', 404);
    const status = job.expired ? 'failed' : job.status;
    const stages = new Map<AssessmentStage, 'executed' | 'skipped' | 'failed'>();
    for (const raw of job.progress) {
      const stage = assessmentStageEvent.safeParse(raw);
      if (stage.success) stages.set(stage.data.stage, stage.data.status);
    }
    const events: StreamFrame<AssessmentStreamEvent>[] = [];
    for (const [index, stage] of ASSESSMENT_STAGES.entries()) {
      const stageStatus = stages.get(stage);
      // Delaying the rest of the live sequence leaves room for gaps to be filled by the saved run.
      if (!stageStatus && status === 'running') break;
      if (stageStatus)
        events.push({ id: index + 1, data: { kind: 'stage', stage, status: stageStatus } });
    }
    if (status !== 'running') {
      events.push({
        id: ASSESSMENT_STAGES.length + 1,
        data:
          status === 'succeeded'
            ? { kind: 'completed', runId }
            : { kind: 'failed', code: 'AssessmentFailed' },
      });
    }
    return events;
  }
  async fail(runId: string, code: string) {
    await this.db.query(
      "UPDATE cases.assessment_jobs SET status='failed',error_code=$2 WHERE run_id=$1 AND status='running'",
      [runId, code],
    );
  }
  async evidence(actor: Actor, id: string) {
    await this.read(actor, id);
    const rows = (await this.db.query(
      "SELECT a.filename,e.original_bytes FROM cases.evidence_documents e JOIN cases.applications a ON a.id=e.application_id WHERE a.id=$1 AND e.requirement='application_pack'",
      [id],
    )) as { filename: string; original_bytes: Buffer }[];
    invariant(rows[0], 'NotFound', 'Original evidence not found', 404);
    return { filename: rows[0].filename, bytes: rows[0].original_bytes };
  }
  private async readIssuedOffer(actor: Actor, id: string) {
    const rows = (await this.db.query(
      "SELECT o.id,o.run_id,o.approval_id,o.data,o.created_at,a.preparer_id FROM cases.offers o JOIN cases.assessment_runs r ON r.id=o.run_id JOIN cases.applications a ON a.id=r.application_id WHERE o.id=$1 AND r.status='issued'",
      [id],
    )) as StoredOffer[];
    invariant(rows[0], 'NotFound', 'Issued offer not found', 404);
    invariant(
      rows[0].preparer_id === actor.id ||
        (actor.role === 'credit_officer' && actor.tier !== 'none'),
      'Forbidden',
      'Offer access denied',
      403,
    );
    return rows[0];
  }
  async offer(actor: Actor, id: string) {
    const row = await this.readIssuedOffer(actor, id);
    const data = { ...row.data };
    delete data.document;
    return {
      id: row.id,
      run_id: row.run_id,
      data,
      created_at: row.created_at,
      preparer_id: row.preparer_id,
      documentAvailable: Boolean(await this.findOfferDocument(row)),
    };
  }
  async offerDocument(actor: Actor, id: string) {
    const document = await this.findOfferDocument(await this.readIssuedOffer(actor, id));
    invariant(
      document,
      'OfferDocumentUnavailable',
      'Verified offer document provenance is incomplete',
      409,
    );
    return document;
  }
  private async findOfferDocument(row: StoredOffer) {
    if (Object.hasOwn(row.data, 'document')) {
      const snapshot = issuedOfferDocumentSchema.safeParse(row.data.document);
      if (!snapshot.success) return undefined;
      const value = snapshot.data;
      return value.offerId === row.id &&
        value.runId === row.run_id &&
        value.approval.id === row.approval_id &&
        value.approval.preparerId === row.preparer_id &&
        value.issuance.issuedAt === row.created_at.toISOString()
        ? value
        : undefined;
    }

    const { amount, disbursementDate, productId, policyEdition, mode, fullyEvidenceVerified } =
      row.data;
    if (
      typeof amount !== 'string' ||
      !/^\d+(?:\.\d{1,2})?$/.test(amount) ||
      typeof disbursementDate !== 'string'
    )
      return undefined;
    const records = (await this.db.query(
      `SELECT approval.id,approval.amount::text AS amount,approval.approver_id,approval.created_at,
              approval.assessment_version,issued.actor_id AS issuer_id,
              issued.details->>'issuerTier' AS issuer_tier,r.version,r.result,a.normalized,
              (SELECT details FROM cases.audit_events event
                WHERE event.run_id=r.id AND event.actor_id=approval.approver_id
                  AND event.event='ASSESSMENT_APPROVED' AND event.details->>'approvalId'=approval.id::text
                LIMIT 1) AS approval_authority
         FROM cases.assessment_runs r
         JOIN cases.applications a ON a.id=r.application_id
         JOIN cases.approvals approval ON approval.run_id=r.id AND approval.id=$2 AND approval.decision='approved'
         JOIN cases.audit_events issued ON issued.run_id=r.id AND issued.event='OFFER_ISSUED'
              AND issued.details->>'offerId'=$3 AND issued.details->>'disbursementDate'=$4
        WHERE r.id=$1 AND r.status='issued'
        LIMIT 2`,
      [row.run_id, row.approval_id, row.id, disbursementDate],
    )) as LegacyOfferProvenance[];
    const record = records[0];
    if (records.length !== 1 || !record?.amount || !record.issuer_id) return undefined;
    try {
      if (
        record.assessment_version !== record.version - 2 ||
        compareMoney(amount, record.amount) !== 0 ||
        record.result.mode !== mode ||
        record.result.policyEdition !== policyEdition ||
        record.result.evidence.fullyEvidenceVerified !== fullyEvidenceVerified ||
        (record.result.productId ?? 'PL-100') !== (productId ?? 'PL-100')
      )
        return undefined;
      return await buildIssuedOfferDocument({
        offerId: row.id,
        runId: row.run_id,
        form: parseApplicationForm(record.normalized),
        result: record.result,
        preparerId: row.preparer_id,
        approval: record,
        approvalAuthority: record.approval_authority,
        issuance: {
          issuerId: record.issuer_id,
          issuedAt: row.created_at.toISOString(),
          issuerTier: recordedIssuerTier(record.issuer_tier),
        },
        disbursementDate,
      });
    } catch (error) {
      // The legacy JSON offer remains readable even when it cannot support an exact document.
      if (error instanceof DomainError || error instanceof ZodError || error instanceof TypeError)
        return undefined;
      throw error;
    }
  }
}
