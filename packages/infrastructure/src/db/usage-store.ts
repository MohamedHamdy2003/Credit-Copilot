import type { DataSource } from 'typeorm';
import type {
  UsageEvent,
  UsageGroup,
  UsageSummary,
  UsageTotals,
} from '../../../contracts/src/usage.js';

const groupLimit = 100;
const recentRunLimit = 20;

const insertEvents = `
  INSERT INTO cases.model_usage_events (
    id, actor_id, run_id, request_id, operation, step, provider, model, kind, outcome,
    retry, fallback_from, input_tokens, output_tokens, list_cost_usd, rate_snapshot,
    actual_cost_usd, charge_basis, occurred_at
  )
  SELECT id, actor_id, run_id, request_id, operation, step, provider, model, kind, outcome,
    retry, fallback_from, input_tokens, output_tokens, list_cost_usd, rate_snapshot,
    actual_cost_usd, charge_basis, occurred_at
  FROM jsonb_to_recordset($1::jsonb) AS event(
    id uuid, actor_id uuid, run_id uuid, request_id text, operation text, step text,
    provider text, model text, kind text, outcome text, retry boolean, fallback_from text,
    input_tokens bigint, output_tokens bigint, list_cost_usd numeric, rate_snapshot jsonb,
    actual_cost_usd numeric, charge_basis text, occurred_at timestamptz
  )
  ON CONFLICT (id) DO NOTHING
`;

function summaryQuery(runId: string | undefined) {
  const scope = runId ? 'actor_id = $1 AND run_id = $2' : 'actor_id = $1';
  return `
    WITH scoped AS NOT MATERIALIZED (
      SELECT * FROM cases.model_usage_events WHERE ${scope}
    ), aggregated AS (
      SELECT GROUPING(provider) = 1 AS is_total, provider, model, kind, operation, step,
        COUNT(*) AS calls,
        COUNT(*) FILTER (WHERE outcome = 'failed') AS failed_calls,
        COUNT(*) FILTER (WHERE retry) AS retries,
        COUNT(fallback_from) AS fallback_calls,
        COUNT(*) FILTER (WHERE step = 'legacy_assessment') AS legacy_calls,
        COUNT(*) FILTER (WHERE charge_basis = 'confirmed_free_tier') AS free_tier_calls,
        COUNT(*) FILTER (WHERE charge_basis = 'local') AS local_calls,
        SUM(input_tokens)::text AS input_total,
        COUNT(*) - COUNT(input_tokens) AS input_unknown,
        SUM(output_tokens)::text AS output_total,
        COUNT(*) - COUNT(output_tokens) AS output_unknown,
        trim_scale(SUM(list_cost_usd))::text AS list_cost_total,
        COUNT(*) - COUNT(list_cost_usd) AS list_cost_unknown,
        trim_scale(SUM(actual_cost_usd))::text AS actual_cost_total,
        COUNT(*) - COUNT(actual_cost_usd) AS actual_cost_unknown,
        MIN(occurred_at) AS first_at,
        MAX(occurred_at) AS last_at
      FROM scoped
      GROUP BY GROUPING SETS ((), (provider, model, kind, operation, step))
    ), recent_runs AS (
      SELECT run_id, MAX(occurred_at) AS last_at, COUNT(*) AS calls
      FROM scoped
      WHERE run_id IS NOT NULL
      GROUP BY run_id
      ORDER BY last_at DESC, run_id
      LIMIT ${recentRunLimit}
    )
    SELECT *, COUNT(*) OVER (PARTITION BY is_total) AS group_count,
      CASE WHEN is_total THEN (
        SELECT jsonb_agg(
          jsonb_build_object('id', run_id, 'last_at', last_at, 'calls', calls::text)
          ORDER BY last_at DESC, run_id
        )
        FROM recent_runs
      ) END AS recent_runs
    FROM aggregated
    ORDER BY is_total DESC, calls DESC, provider, model, kind, operation, step
    LIMIT ${groupLimit + 1}
  `;
}

type GroupDimensions = Pick<UsageGroup, 'provider' | 'model' | 'kind' | 'operation' | 'step'>;
interface AggregateRow {
  calls: string;
  failed_calls: string;
  retries: string;
  fallback_calls: string;
  legacy_calls: string;
  free_tier_calls: string;
  local_calls: string;
  input_total: string | null;
  input_unknown: string;
  output_total: string | null;
  output_unknown: string;
  list_cost_total: string | null;
  list_cost_unknown: string;
  actual_cost_total: string | null;
  actual_cost_unknown: string;
}
type SummaryRow = AggregateRow &
  (
    | {
        is_total: true;
        first_at: Date | null;
        last_at: Date | null;
        recent_runs: { id: string; last_at: string; calls: string }[] | null;
      }
    | ({ is_total: false; group_count: string } & GroupDimensions)
  );

function count(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new RangeError('Usage counter exceeds safe integer range');
  return parsed;
}

function totals(row: AggregateRow): UsageTotals {
  return {
    calls: count(row.calls),
    failedCalls: count(row.failed_calls),
    retries: count(row.retries),
    fallbacks: count(row.fallback_calls),
    legacyCalls: count(row.legacy_calls),
    freeTierCalls: count(row.free_tier_calls),
    localCalls: count(row.local_calls),
    inputTokens: {
      knownTotal: row.input_total === null ? null : count(row.input_total),
      missingCalls: count(row.input_unknown),
    },
    outputTokens: {
      knownTotal: row.output_total === null ? null : count(row.output_total),
      missingCalls: count(row.output_unknown),
    },
    estimatedUsd: {
      knownTotal: row.list_cost_total,
      missingCalls: count(row.list_cost_unknown),
    },
    actualUsd: {
      knownTotal: row.actual_cost_total,
      missingCalls: count(row.actual_cost_unknown),
    },
  };
}

export class PostgresUsageStore {
  constructor(private readonly db: DataSource) {}

  async record(events: readonly UsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    const payload = events.map((event) => ({
      id: event.id,
      actor_id: event.actorId,
      run_id: event.runId,
      request_id: event.requestId,
      operation: event.operation,
      step: event.step,
      provider: event.provider,
      model: event.model,
      kind: event.kind,
      outcome: event.outcome,
      retry: event.retry,
      fallback_from: event.fallbackFrom,
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      list_cost_usd: event.estimatedUsd,
      rate_snapshot: event.price,
      actual_cost_usd: event.actualUsd,
      charge_basis: event.chargeBasis,
      occurred_at: event.occurredAt,
    }));
    await this.db.query(insertEvents, [JSON.stringify(payload)]);
  }

  async summarize(actorId: string, runId?: string): Promise<UsageSummary> {
    const [overall, ...grouped] = (await this.db.query(
      summaryQuery(runId),
      runId ? [actorId, runId] : [actorId],
    )) as SummaryRow[];
    if (!overall?.is_total) throw new Error('Usage summary totals are missing');
    const groups = grouped.filter((row) => !row.is_total);
    return {
      runId: runId ?? null,
      totals: totals(overall),
      groups: groups.map((row) => ({
        provider: row.provider,
        model: row.model,
        kind: row.kind,
        operation: row.operation,
        step: row.step,
        ...totals(row),
      })),
      truncated: count(groups[0]?.group_count ?? '0') > groupLimit,
      firstRecordedAt: overall.first_at?.toISOString() ?? null,
      lastRecordedAt: overall.last_at?.toISOString() ?? null,
      recentRuns: (overall.recent_runs ?? []).map((row) => ({
        runId: row.id,
        lastRecordedAt: new Date(row.last_at).toISOString(),
        calls: count(row.calls),
      })),
    };
  }
}
