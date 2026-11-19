import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { Actor } from '../../../domain/src/access.js';
import type { ApplicationStore } from '../../../application/src/operations.js';
import type { NormalizedDocument } from '../../../contracts/src/documents.js';
import { parseApplicationForm } from '../../../application/src/application-form.js';
import { invariant } from '../../../domain/src/errors.js';
import type { AssessmentMode } from '../../../domain/src/evidence-mode.js';
interface Stored {
  id: string;
  preparer_id: string;
  normalized: NormalizedDocument;
  synthetic: boolean;
  latest_assessment_id: string | null;
  filename: string;
}
export class PostgresApplicationStore implements ApplicationStore {
  constructor(private readonly db: DataSource) {}
  async register(actor: Actor, document: NormalizedDocument, bytes: Uint8Array) {
    const form = parseApplicationForm(document);
    return this.db.transaction(async (manager) => {
      const active = (await manager.query(
        'SELECT id FROM cases.users WHERE id=$1 AND active FOR SHARE',
        [actor.id],
      )) as { id: string }[];
      invariant(active.length, 'Unauthenticated', 'Active user required', 401);
      const id = randomUUID();
      const inserted = (await manager.query(
        'INSERT INTO cases.applications(id,reference,preparer_id,filename,hash,normalized,synthetic) VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(preparer_id,hash) DO NOTHING RETURNING id',
        [id, form.reference, actor.id, document.filename, document.hash, document],
      )) as { id: string }[];
      if (!inserted.length) {
        const existing = (await manager.query(
          'SELECT id FROM cases.applications WHERE preparer_id=$1 AND hash=$2',
          [actor.id, document.hash],
        )) as { id: string }[];
        return { id: existing[0]!.id, reference: form.reference, synthetic: true, duplicate: true };
      }
      await manager.query(
        'INSERT INTO cases.evidence_documents(id,application_id,requirement,original_bytes,hash) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), id, 'application_pack', Buffer.from(bytes), document.hash],
      );
      return { id, reference: form.reference, synthetic: true, duplicate: false };
    });
  }
  list(actor: Actor) {
    return this.db.query(
      'SELECT a.id,a.reference,a.synthetic,a.created_at,a.latest_assessment_id,r.status FROM cases.applications a LEFT JOIN cases.assessment_runs r ON r.id=a.latest_assessment_id WHERE a.preparer_id=$1 OR $2 ORDER BY a.created_at DESC LIMIT 100',
      [actor.id, actor.role === 'credit_officer'],
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
    };
  }
  async start(actor: Actor, id: string, key: string, mode: AssessmentMode) {
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
        "UPDATE cases.assessment_jobs SET status='failed',error_code='AssessmentInterrupted' WHERE application_id=$1 AND status='running' AND created_at<now()-interval '15 minutes'",
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
  async offer(actor: Actor, id: string) {
    const rows = (await this.db.query(
      'SELECT o.id,o.run_id,o.data,o.created_at,a.preparer_id FROM cases.offers o JOIN cases.assessment_runs r ON r.id=o.run_id JOIN cases.applications a ON a.id=r.application_id WHERE o.id=$1',
      [id],
    )) as { preparer_id: string }[];
    invariant(rows[0], 'NotFound', 'Issued offer not found', 404);
    invariant(
      rows[0].preparer_id === actor.id || actor.role === 'credit_officer',
      'Forbidden',
      'Offer access denied',
      403,
    );
    return rows[0];
  }
}
