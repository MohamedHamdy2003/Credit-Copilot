import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AssessmentProgress1794916800007 implements MigrationInterface {
  async up(query: QueryRunner) {
    await query.query(
      "ALTER TABLE cases.assessment_jobs ADD COLUMN progress jsonb NOT NULL DEFAULT '[]'",
    );
  }

  async down(query: QueryRunner) {
    await query.query('ALTER TABLE cases.assessment_jobs DROP COLUMN progress');
  }
}
