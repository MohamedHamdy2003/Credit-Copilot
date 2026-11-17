import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type {
  AssessmentRecord,
  AssessmentRepository,
} from '../../../application/src/assessment-record.js';
import { invariant } from '../../../domain/src/errors.js';

export class PostgresAssessmentRepository implements AssessmentRepository {
  constructor(private readonly database: DataSource) {}
  async save(record: AssessmentRecord): Promise<void> {
    await this.database.transaction(async (manager) => {
      const applications = (await manager.query(
        'SELECT preparer_id FROM cases.applications WHERE id=$1 FOR UPDATE',
        [record.applicationId],
      )) as { preparer_id: string }[];
      invariant(
        applications[0]?.preparer_id === record.actorId,
        'Forbidden',
        'Assessment actor must be the application preparer',
        403,
      );
      const result = record.result;
      // INSERT only: existing run IDs cannot overwrite an earlier immutable assessment.
      await manager.query(
        'INSERT INTO cases.assessment_runs(id,application_id,mode,recommendation,status,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          record.id,
          record.applicationId,
          result.mode,
          result.recommendation,
          result.status,
          result,
          record.at,
        ],
      );
      const audit = async (event: string, details: unknown) =>
        manager.query(
          'INSERT INTO cases.audit_events(id,run_id,request_id,actor_id,event,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), record.id, record.requestId, record.actorId, event, details, record.at],
        );
      await audit('PROTECTED_ATTRIBUTES_REMOVED', { fields: result.removedFields });
      for (const step of result.steps) await audit('ASSESSMENT_STEP', { step });
      for (const assumption of result.evidence.auditEvents)
        await audit(assumption.event, assumption);
      await audit('ASSESSMENT_RECORDED', {
        recommendation: result.recommendation,
        mode: result.mode,
        policyEdition: result.policyEdition,
        maxDbr: result.maxDbr,
        reason: 'reason' in result ? result.reason : null,
      });
      if (result.fraudReferral)
        await audit('FRAUD_UNIT_REFERRAL', {
          reason: 'SuspectedTampering',
          status: 'pending_review',
        });
      if ('extraction' in result && result.extraction) {
        await manager.query(
          'INSERT INTO cases.llm_usage(id,actor_id,run_id,model,operation,input_tokens,output_tokens,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            randomUUID(),
            record.actorId,
            record.id,
            result.extraction.model,
            'assessment_extraction',
            result.extraction.usage.inputTokens,
            result.extraction.usage.outputTokens,
            record.at,
          ],
        );
      }
    });
  }
}
