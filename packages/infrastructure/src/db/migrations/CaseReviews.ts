import type { MigrationInterface, QueryRunner } from 'typeorm';
export class CaseReviews1794916800005 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE cases.rejection_notices (
      run_id uuid PRIMARY KEY REFERENCES cases.assessment_runs(id), approval_id uuid UNIQUE NOT NULL REFERENCES cases.approvals(id),
      clause text NOT NULL, policy_edition text NOT NULL, source_file text NOT NULL, reason_text text NOT NULL,
      decided_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO cases.rejection_notices(run_id,approval_id,clause,policy_edition,source_file,reason_text,decided_at)
      SELECT a.run_id,a.id,split_part(a.comment,':',1),r.result->>'policyEdition',
        CASE WHEN a.comment LIKE 'PS-%' THEN 'product-sheet-personal-loan.md' WHEN a.comment LIKE 'PM-%' THEN 'credit-procedures-manual (1).pdf' WHEN r.result->>'policyEdition'='CP-2024' THEN 'credit-policy-2024.pdf' ELSE 'credit-policy-2025.pdf' END,
        substring(a.comment from position(':' in a.comment)+2),a.created_at
      FROM cases.approvals a JOIN cases.assessment_runs r ON r.id=a.run_id
      WHERE a.decision='rejected' AND a.comment ~ '^(CP|PS|PM)-[0-9]+([.][0-9]+)?: .+'
        AND r.result->>'policyEdition' IN ('CP-2024','CP-2025');
    CREATE TABLE cases.reason_requests (
      id uuid PRIMARY KEY,run_id uuid UNIQUE NOT NULL REFERENCES cases.rejection_notices(run_id),
      requested_by uuid NOT NULL REFERENCES cases.users(id),message text NOT NULL,reply jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE cases.referral_reviews (
      id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES cases.assessment_runs(id),reviewer_id uuid NOT NULL REFERENCES cases.users(id),
      action text NOT NULL CHECK(action IN ('awaiting_evidence','requires_reassessment','fraud_recorded')),comment text NOT NULL CHECK(length(trim(comment))>0),
      assessment_version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX referral_review_history ON cases.referral_reviews(run_id,created_at);`);
  }
  async down(q: QueryRunner) {
    await q.query(
      'DROP TABLE cases.referral_reviews; DROP TABLE cases.reason_requests; DROP TABLE cases.rejection_notices;',
    );
  }
}
