import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AssessmentJobs1794916800004 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE cases.assessment_jobs(run_id uuid PRIMARY KEY,application_id uuid NOT NULL REFERENCES cases.applications(id),request_key text NOT NULL,mode text NOT NULL CHECK(mode IN ('strict','demo')),status text NOT NULL CHECK(status IN ('running','succeeded','failed')),error_code text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(application_id,request_key));
 CREATE UNIQUE INDEX one_running_assessment ON cases.assessment_jobs(application_id) WHERE status='running';
 CREATE UNIQUE INDEX unique_application_source ON cases.applications(preparer_id,hash);`);
  }
  async down(q: QueryRunner) {
    await q.query('DROP INDEX cases.unique_application_source; DROP TABLE cases.assessment_jobs;');
  }
}
