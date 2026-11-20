import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { DataSource, EntityManager } from 'typeorm';
import type { Actor } from '../../../domain/src/access.js';
import { invariant } from '../../../domain/src/errors.js';
import {
  reasonWindow,
  referralTarget,
  requireSenior,
  type ReviewCalendar,
} from '../../../domain/src/review-policy.js';
import {
  CaseReviewService,
  type CaseReviewStore,
  type ReferralNote,
} from '../../../application/src/case-review.js';
import type { AssessmentResult } from '../../../application/src/assessment-record.js';
interface ReviewRun {
  id: string;
  application_id: string;
  preparer_id: string;
  status: string;
  version: number;
  result: AssessmentResult;
  created_at: Date;
  latest_assessment_id: string | null;
}
interface Notice {
  run_id: string;
  clause: string;
  policy_edition: string;
  source_file: string;
  reason_text: string;
  decided_at: Date;
}
const cairoDate = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
export class PostgresCaseReviewStore implements CaseReviewStore {
  constructor(
    private readonly db: DataSource,
    private readonly calendar: ReviewCalendar,
  ) {}
  private async actor(m: EntityManager, id: string) {
    const users = (await m.query(
      'SELECT id,username,role,tier,can_ingest AS "canIngest" FROM cases.users WHERE id=$1 AND active FOR SHARE',
      [id],
    )) as Actor[];
    invariant(users[0], 'Unauthenticated', 'Active user required', 401);
    return users[0];
  }
  private async run(m: EntityManager, id: string, lock = false) {
    const rows = (await m.query(
      `SELECT r.*,a.preparer_id,a.latest_assessment_id FROM cases.assessment_runs r JOIN cases.applications a ON a.id=r.application_id WHERE r.id=$1${lock ? ' FOR UPDATE OF r,a' : ''}`,
      [id],
    )) as ReviewRun[];
    invariant(rows[0], 'NotFound', 'Assessment not found', 404);
    return rows[0];
  }
  private authorize(actor: Actor, run: ReviewRun) {
    invariant(
      actor.id === run.preparer_id || actor.role === 'credit_officer',
      'Forbidden',
      'Assessment access denied',
      403,
    );
  }
  private async now(m: EntityManager) {
    return ((await m.query('SELECT now() AS at')) as { at: Date }[])[0]!.at;
  }
  private async written(m: EntityManager, actor: Actor, run: ReviewRun) {
    this.authorize(actor, run);
    invariant(
      run.status === 'rejected',
      'NotDeclined',
      'Written-reason requests apply to a human rejection',
      409,
    );
    const notices = (await m.query('SELECT * FROM cases.rejection_notices WHERE run_id=$1', [
      run.id,
    ])) as Notice[];
    invariant(
      notices[0],
      'ReasonUnavailable',
      'Recorded rejection reason unavailable; refer to human review',
      409,
    );
    const notice = notices[0];
    const requests = (await m.query(
      'SELECT id,reply,created_at FROM cases.reason_requests WHERE run_id=$1',
      [run.id],
    )) as { id: string; reply: unknown; created_at: Date }[];
    const window = reasonWindow(cairoDate(notice.decided_at), cairoDate(await this.now(m)));
    return {
      notice,
      request: requests[0] ?? null,
      window,
      canRequest: actor.id === run.preparer_id && window.eligible && !requests[0],
    };
  }
  async reason(actor: Actor, id: string) {
    return this.written(this.db.manager, actor, await this.run(this.db.manager, id));
  }
  async requestReason(actor: Actor, id: string, message: string, requestId: string) {
    return this.db.transaction(async (m) => {
      actor = await this.actor(m, actor.id);
      const run = await this.run(m, id, true);
      invariant(
        run.preparer_id === actor.id,
        'Forbidden',
        'Only the preparer may record the applicant written-reason request',
        403,
      );
      const written = await this.written(m, actor, run);
      if (written.request) return written.request;
      invariant(
        written.window.eligible,
        'ReasonRequestWindowClosed',
        'PM-9 permits requests within 30 calendar days of the rejection',
        409,
      );
      const at = await this.now(m);
      const reply = {
        reference: run.result.reference,
        clause: written.notice.clause,
        policyEdition: written.notice.policy_edition,
        sourceFile: written.notice.source_file,
        reason: written.notice.reason_text,
        decidedAt: written.notice.decided_at.toISOString(),
        providedAt: at.toISOString(),
        mode: run.result.mode,
        fullyEvidenceVerified: run.result.evidence.fullyEvidenceVerified,
        assumptions: run.result.evidence.assumptions,
        procedure: 'PM-9',
        note: 'Written copy of the recorded human decision. This does not change the assessment or constitute an appeal decision.',
      };
      const request = (
        await m.query(
          'INSERT INTO cases.reason_requests(id,run_id,requested_by,message,reply) VALUES($1,$2,$3,$4,$5) RETURNING id,reply,created_at',
          [randomUUID(), id, actor.id, message, reply],
        )
      )[0] as { id: string; reply: unknown };
      await this.audit(m, actor, id, requestId, 'WRITTEN_REASON_REQUESTED', {
        reasonRequestId: request.id,
        source: 'PM-9',
      });
      await this.audit(m, actor, id, requestId, 'WRITTEN_REASON_PROVIDED', {
        reasonRequestId: request.id,
        clause: reply.clause,
        edition: reply.policyEdition,
        sourceFile: reply.sourceFile,
        mode: reply.mode,
      });
      return request;
    });
  }
  async referrals(actor: Actor) {
    requireSenior(actor);
    const rows = (await this.db.query(
      "SELECT r.id,r.application_id,r.version,r.created_at,r.result->>'reference' AS reference,r.result->>'reason' AS reason,r.result->'evidence'->'missing' AS missing,(r.result->>'fraudReferral')::boolean AS fraud FROM cases.assessment_runs r JOIN cases.applications a ON a.id=r.application_id WHERE r.recommendation='REFER_TO_HUMAN' AND r.status='pending_review' AND (a.latest_assessment_id IS NULL OR a.latest_assessment_id=r.id) ORDER BY r.created_at,r.id",
    )) as { id: string; created_at: Date; fraud: boolean }[];
    const today = cairoDate(await this.now(this.db.manager));
    return rows.map((r) => {
      const target = referralTarget(cairoDate(r.created_at), this.calendar);
      return {
        ...r,
        target,
        overdue: today > target,
        assignedTier: 'senior',
        destination: r.fraud ? 'Fraud Unit (internal record)' : 'Senior Credit Officer',
        calendar: this.calendar,
        calendarNote:
          'Indicative two-business-day target; configured weekends/holidays. Public holidays are not supplied by the source corpus.',
      };
    });
  }
  async referral(actor: Actor, id: string) {
    const run = await this.run(this.db.manager, id);
    this.authorize(actor, run);
    invariant(
      run.result.recommendation === 'REFER_TO_HUMAN',
      'NotReferred',
      'Assessment is not a referral',
      409,
    );
    return {
      notes: await this.db.query(
        'SELECT id,action,comment,reviewer_id,assessment_version,created_at FROM cases.referral_reviews WHERE run_id=$1 ORDER BY created_at,id',
        [id],
      ),
      destination: run.result.fraudReferral
        ? 'Fraud Unit (internal record)'
        : 'Senior Credit Officer',
      target: referralTarget(cairoDate(run.created_at), this.calendar),
    };
  }
  async note(actor: Actor, id: string, command: ReferralNote, requestId: string) {
    return this.db.transaction(async (m) => {
      actor = await this.actor(m, actor.id);
      requireSenior(actor);
      const run = await this.run(m, id, true);
      invariant(
        run.preparer_id !== actor.id,
        'FourEyesViolation',
        'Independent referral reviewer required',
        403,
      );
      invariant(
        run.result.recommendation === 'REFER_TO_HUMAN' && run.status === 'pending_review',
        'NotReferred',
        'Assessment is not awaiting referral review',
        409,
      );
      invariant(
        run.version === command.expectedVersion &&
          (!run.latest_assessment_id || run.latest_assessment_id === id),
        'StaleAssessment',
        'Reload the latest assessment before referral review',
        409,
      );
      const running = (await m.query(
        "SELECT run_id FROM cases.assessment_jobs WHERE application_id=$1 AND status='running'",
        [run.application_id],
      )) as { run_id: string }[];
      invariant(
        !running.length,
        'AssessmentInProgress',
        'Wait for reassessment before referral review',
        409,
      );
      invariant(
        command.action !== 'fraud_recorded' || run.result.fraudReferral,
        'InvalidReferralAction',
        'No fraud referral exists on this assessment',
      );
      const note = (
        await m.query(
          'INSERT INTO cases.referral_reviews(id,run_id,reviewer_id,action,comment,assessment_version) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,action,comment,created_at',
          [randomUUID(), id, actor.id, command.action, command.comment, run.version],
        )
      )[0] as { id: string };
      await this.audit(m, actor, id, requestId, 'REFERRAL_REVIEW_RECORDED', {
        noteId: note.id,
        ...command,
        source: run.result.fraudReferral ? 'PM-7' : 'PM-4',
        externalDelivery: false,
      });
      return note;
    });
  }
  private audit(
    m: EntityManager,
    actor: Actor,
    id: string,
    requestId: string,
    event: string,
    details: unknown,
  ) {
    return m.query(
      'INSERT INTO cases.audit_events(id,run_id,request_id,actor_id,event,details) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), id, requestId, actor.id, event, details],
    );
  }
}
export async function createCaseReviews(db: DataSource) {
  const calendar = z
    .object({
      weekendDays: z.array(z.number().int().min(0).max(6)).max(6),
      holidays: z.array(z.iso.date()),
    })
    .strict()
    .parse(JSON.parse(await readFile('data/config/review-calendar.json', 'utf8')));
  return new CaseReviewService(new PostgresCaseReviewStore(db, calendar));
}
