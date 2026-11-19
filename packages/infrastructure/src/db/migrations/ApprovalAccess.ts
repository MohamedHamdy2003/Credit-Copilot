import type { MigrationInterface, QueryRunner } from 'typeorm';
export class ApprovalAccess1794916800002 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`
 ALTER TABLE cases.users ADD COLUMN active boolean NOT NULL DEFAULT true;
 CREATE TABLE cases.login_attempts(key text PRIMARY KEY,attempts integer NOT NULL,window_start timestamptz NOT NULL);
 CREATE TABLE cases.customer_responses(id uuid PRIMARY KEY,run_id uuid UNIQUE NOT NULL REFERENCES cases.assessment_runs(id),accepted boolean NOT NULL,recorded_by uuid NOT NULL REFERENCES cases.users(id),comment text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE cases.approvals ADD COLUMN amount numeric(14,2);
 ALTER TABLE cases.approvals ADD COLUMN assessment_version integer;
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      'ALTER TABLE cases.approvals DROP COLUMN assessment_version; ALTER TABLE cases.approvals DROP COLUMN amount; DROP TABLE cases.customer_responses; DROP TABLE cases.login_attempts; ALTER TABLE cases.users DROP COLUMN active;',
    );
  }
}
