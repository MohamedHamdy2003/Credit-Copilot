import type { MigrationInterface, QueryRunner } from 'typeorm';
export class LatestAssessment1794916800003 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE cases.applications ADD COLUMN latest_assessment_id uuid REFERENCES cases.assessment_runs(id);
 UPDATE cases.applications a SET latest_assessment_id=(SELECT id FROM cases.assessment_runs r WHERE r.application_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1);`);
  }
  async down(q: QueryRunner) {
    await q.query('ALTER TABLE cases.applications DROP COLUMN latest_assessment_id;');
  }
}
