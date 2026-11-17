import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1794916800000 implements MigrationInterface {
  name = 'InitialSchema1794916800000';
  async up(query: QueryRunner): Promise<void> {
    await query.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE SCHEMA knowledge;
      CREATE SCHEMA cases;
      CREATE TABLE knowledge.documents (
        id text PRIMARY KEY, filename text NOT NULL, hash text NOT NULL,
        metadata jsonb NOT NULL, normalized jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE knowledge.chunks (
        id text PRIMARY KEY, document_id text NOT NULL REFERENCES knowledge.documents(id),
        ordinal integer NOT NULL, text text NOT NULL, metadata jsonb NOT NULL,
        edition text NOT NULL, product text NOT NULL, effective_from date NOT NULL, effective_to date,
        search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
        UNIQUE(document_id, ordinal), CHECK(effective_to IS NULL OR effective_to > effective_from)
      );
      CREATE INDEX chunk_search ON knowledge.chunks USING gin(search_vector);
      CREATE INDEX chunk_dates ON knowledge.chunks(product, effective_from, effective_to);
      CREATE TABLE knowledge.embeddings (
        chunk_id text NOT NULL REFERENCES knowledge.chunks(id), model text NOT NULL,
        dimensions integer NOT NULL CHECK(dimensions > 0), embedding vector NOT NULL,
        PRIMARY KEY(chunk_id, model), CHECK(vector_dims(embedding) = dimensions)
      );
      CREATE TABLE knowledge.pricing (
        document_id text NOT NULL REFERENCES knowledge.documents(id), row_number integer NOT NULL,
        data jsonb NOT NULL, PRIMARY KEY(document_id, row_number)
      );
      CREATE TABLE knowledge.ingestion_attempts (
        id uuid PRIMARY KEY, filename text NOT NULL, status text NOT NULL,
        error_code text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE cases.users (
        id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL,
        role text NOT NULL CHECK(role IN ('loan_officer','credit_officer')),
        tier text NOT NULL CHECK(tier IN ('none','credit','senior','head')),
        can_ingest boolean NOT NULL DEFAULT false,
        CHECK(role = 'credit_officer' OR tier = 'none')
      );
      CREATE TABLE cases.sessions (
        token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES cases.users(id),
        csrf_token text NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE TABLE cases.applications (
        id uuid PRIMARY KEY, reference text NOT NULL, preparer_id uuid NOT NULL REFERENCES cases.users(id),
        filename text NOT NULL, hash text NOT NULL, normalized jsonb NOT NULL,
        synthetic boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE cases.evidence_documents (
        id uuid PRIMARY KEY, application_id uuid NOT NULL REFERENCES cases.applications(id),
        requirement text NOT NULL, original_bytes bytea NOT NULL, hash text NOT NULL,
        verified_by uuid REFERENCES cases.users(id), verified_at timestamptz,
        UNIQUE(application_id, requirement, hash)
      );
      CREATE TABLE cases.assessment_runs (
        id uuid PRIMARY KEY, application_id uuid NOT NULL REFERENCES cases.applications(id),
        mode text NOT NULL CHECK(mode IN ('strict','demo')), recommendation text NOT NULL,
        status text NOT NULL CHECK(status IN ('pending_review','pending_approval','pending_customer_acceptance','approved','rejected','issued','superseded')),
        result jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(), retention_until timestamptz NOT NULL DEFAULT (now()+interval '7 years')
      );
      CREATE TABLE cases.audit_events (
        id uuid PRIMARY KEY, run_id uuid REFERENCES cases.assessment_runs(id),
        request_id text NOT NULL, actor_id uuid REFERENCES cases.users(id), event text NOT NULL,
        details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE cases.approvals (
        id uuid PRIMARY KEY, run_id uuid UNIQUE NOT NULL REFERENCES cases.assessment_runs(id),
        approver_id uuid NOT NULL REFERENCES cases.users(id), decision text NOT NULL,
        comment text NOT NULL CHECK(length(trim(comment)) > 0), created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE cases.offers (
        id uuid PRIMARY KEY, run_id uuid UNIQUE NOT NULL REFERENCES cases.assessment_runs(id),
        approval_id uuid NOT NULL REFERENCES cases.approvals(id), data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE cases.llm_usage (
        id uuid PRIMARY KEY, actor_id uuid REFERENCES cases.users(id), run_id uuid REFERENCES cases.assessment_runs(id),
        model text NOT NULL, operation text NOT NULL, input_tokens integer, output_tokens integer,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
  async down(query: QueryRunner): Promise<void> {
    // Explicit migration rollback only; never invoked at normal application startup.
    await query.query('DROP SCHEMA cases CASCADE; DROP SCHEMA knowledge CASCADE;');
  }
}
