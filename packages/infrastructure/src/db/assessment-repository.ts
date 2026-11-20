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
      const jobs = (await manager.query(
        'SELECT status FROM cases.assessment_jobs WHERE run_id=$1',
        [record.id],
      )) as { status: string }[];
      invariant(
        !jobs.length || jobs[0]!.status === 'running',
        'StaleAssessmentJob',
        'Assessment job is no longer active',
        409,
      );
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
      await manager.query('UPDATE cases.applications SET latest_assessment_id=$2 WHERE id=$1', [
        record.applicationId,
        record.id,
      ]);
      await manager.query("UPDATE cases.assessment_jobs SET status='succeeded' WHERE run_id=$1", [
        record.id,
      ]);
      await audit('PROTECTED_ATTRIBUTES_REMOVED', { fields: result.removedFields });
      if (result.stageEvents)
        for (const event of result.stageEvents) await audit('ASSESSMENT_STEP', event);
      else for (const step of result.steps) await audit('ASSESSMENT_STEP', { step });
      for (const assumption of result.evidence.auditEvents)
        await audit(assumption.event, assumption);
      await audit('ASSESSMENT_RECORDED', {
        recommendation: result.recommendation,
        mode: result.mode,
        policyEdition: result.policyEdition,
        maxDbr: result.maxDbr,
        reason: 'reason' in result ? result.reason : null,
      });
      await audit('POLICY_EVIDENCE_RETRIEVED', { chunkIds: result.retrievedChunkIds ?? [] });
      for (const usage of result.usageRecords ?? []) {
        await manager.query(
          'INSERT INTO cases.llm_usage(id,actor_id,run_id,model,operation,input_tokens,output_tokens,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            randomUUID(),
            record.actorId,
            record.id,
            usage.model,
            'assessment_extraction',
            usage.inputTokens,
            usage.outputTokens,
            record.at,
          ],
        );
        if (usage.fallbackFrom)
          await audit('LLM_GENERATION_FALLBACK', { from: usage.fallbackFrom, to: usage.model });
      }
      if (result.fraudReferral)
        await audit('FRAUD_UNIT_REFERRAL', {
          reason: 'SuspectedTampering',
          status: 'pending_review',
        });
      if (!result.usageRecords && 'extraction' in result && result.extraction) {
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
