import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ModelUsageEvents1794916800008 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE cases.model_usage_events (
        id uuid PRIMARY KEY,
        actor_id uuid NOT NULL REFERENCES cases.users(id),
        run_id uuid,
        request_id text CHECK (length(request_id) BETWEEN 1 AND 100),
        operation text NOT NULL CHECK (operation IN ('assessment','policy_question','knowledge_ingestion')),
        step text NOT NULL CHECK (step IN (
          'assessment','extract_data','plan_extract_data','plan_retrieve_policy_clauses',
          'plan_prepare_memo','legacy_assessment','retrieve','answer','index'
        )),
        provider text NOT NULL CHECK (provider IN ('gemini','ollama','unknown')),
        model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
        kind text NOT NULL CHECK (kind IN ('generation','query_embedding','document_embedding')),
        outcome text NOT NULL CHECK (outcome IN ('succeeded','failed','unknown')),
        retry boolean NOT NULL,
        fallback_from text CHECK (length(fallback_from) BETWEEN 1 AND 200),
        input_tokens bigint CHECK (input_tokens >= 0),
        output_tokens bigint CHECK (output_tokens >= 0),
        list_cost_usd numeric CHECK (list_cost_usd >= 0 AND list_cost_usd < 'Infinity'::numeric),
        rate_snapshot jsonb CHECK (jsonb_typeof(rate_snapshot) = 'object'),
        actual_cost_usd numeric CHECK (actual_cost_usd >= 0 AND actual_cost_usd < 'Infinity'::numeric),
        charge_basis text NOT NULL CHECK (charge_basis IN ('confirmed_free_tier','local','unknown')),
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      INSERT INTO cases.model_usage_events (
        id, actor_id, run_id, operation, step, provider, model, kind, outcome,
        retry, input_tokens, output_tokens, charge_basis, occurred_at
      )
      SELECT id, actor_id, run_id, 'assessment', 'legacy_assessment', 'unknown',
        CASE WHEN length(model) BETWEEN 1 AND 200 THEN model ELSE 'legacy-unavailable' END,
        'generation', 'unknown', false,
        CASE WHEN input_tokens >= 0 THEN input_tokens END,
        CASE WHEN output_tokens >= 0 THEN output_tokens END,
        'unknown', created_at
      FROM cases.llm_usage
      WHERE actor_id IS NOT NULL;
      CREATE INDEX model_usage_events_actor_date ON cases.model_usage_events(actor_id, occurred_at);
      CREATE INDEX model_usage_events_actor_run ON cases.model_usage_events(actor_id, run_id)
        WHERE run_id IS NOT NULL;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE cases.model_usage_events');
  }
}
