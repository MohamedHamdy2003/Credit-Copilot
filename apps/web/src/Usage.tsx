import { useState } from 'react';
import type {
  UsageGroup,
  UsageMetric,
  UsageSummary,
  UsageTotals,
} from '../../../packages/contracts/src/usage.js';
import { api } from './api';
import { Empty, ResourceState, useResource } from './components';

const counts = new Intl.NumberFormat('en-GB');
const recordedDate = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Cairo',
});
const operations = {
  assessment: 'Assessment',
  policy_question: 'Policy question',
  knowledge_ingestion: 'Policy source ingestion',
};
const steps = {
  assessment: 'Run',
  extract_data: 'Evidence extraction',
  plan_extract_data: 'Plan evidence extraction',
  plan_retrieve_policy_clauses: 'Plan policy research',
  plan_prepare_memo: 'Plan credit memo',
  legacy_assessment: 'Legacy assessment',
  retrieve: 'Retrieve sources',
  answer: 'Answer from sources',
  index: 'Index source documents',
};
const kinds = {
  generation: 'Generation',
  query_embedding: 'Query embedding',
  document_embedding: 'Document embedding',
};
const providers = { gemini: 'Gemini', ollama: 'Ollama', unknown: 'Unreported provider' };

function calls(count: number) {
  return `${counts.format(count)} ${count === 1 ? 'call' : 'calls'}`;
}

function formatUsd(amount: string) {
  const [whole, decimals = ''] = amount.split('.');
  const fraction = decimals.replace(/0+$/, '').padEnd(2, '0');
  return `USD ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

function Metric({ metric, label }: { metric: UsageMetric<string | number>; label: string }) {
  const observed = metric.knownTotal;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {observed === null
          ? 'Unknown'
          : typeof observed === 'number'
            ? counts.format(observed)
            : formatUsd(observed)}
        {metric.missingCalls > 0 && (
          <small>
            {observed === null ? '' : 'Known subtotal · '}
            {calls(metric.missingCalls)} unreported
          </small>
        )}
      </dd>
    </div>
  );
}

function Metrics({ totals, prominent = false }: { totals: UsageTotals; prominent?: boolean }) {
  return (
    <dl className={prominent ? 'metrics usage-totals' : 'usage-metrics'}>
      <Metric label="Input tokens" metric={totals.inputTokens} />
      <Metric label="Output tokens" metric={totals.outputTokens} />
      <Metric label="Estimated list cost" metric={totals.estimatedUsd} />
      <Metric label="Actual provider charges" metric={totals.actualUsd} />
    </dl>
  );
}

function AttemptCounts({ totals }: { totals: UsageTotals }) {
  return (
    <p className="muted">
      {calls(totals.calls)} · {counts.format(totals.failedCalls)} failed ·{' '}
      {counts.format(totals.retries)} {totals.retries === 1 ? 'retry' : 'retries'} ·{' '}
      {counts.format(totals.fallbacks)} {totals.fallbacks === 1 ? 'fallback' : 'fallbacks'}
    </p>
  );
}

function ModelUsage({ group }: { group: UsageGroup }) {
  return (
    <li className="panel">
      <h3 className="break">{group.model}</h3>
      <p className="muted">
        {providers[group.provider]} · {operations[group.operation]} · {steps[group.step]} ·{' '}
        {kinds[group.kind]}
      </p>
      <AttemptCounts totals={group} />
      <Metrics totals={group} />
    </li>
  );
}

function UsageReport({ report }: { report: UsageSummary }) {
  const { totals, groups, truncated } = report;
  if (totals.calls === 0) return <Empty>No model usage recorded yet.</Empty>;
  const zeroChargeCalls = [
    totals.freeTierCalls > 0 && `${calls(totals.freeTierCalls)} on confirmed free tier`,
    totals.localCalls > 0 && `${calls(totals.localCalls)} on the local model`,
  ].filter(Boolean);
  return (
    <>
      <section className="panel" aria-labelledby="usage-totals-title">
        <h2 id="usage-totals-title">Recorded usage</h2>
        <AttemptCounts totals={totals} />
        <Metrics totals={totals} prominent />
        {totals.legacyCalls > 0 && (
          <p className="muted">
            Includes {calls(totals.legacyCalls)} from older assessment records.
          </p>
        )}
        {zeroChargeCalls.length > 0 && (
          <p className="muted">
            Zero provider charges recorded for {zeroChargeCalls.join(' and ')}.
            {totals.localCalls > 0 && ' Local hosting costs are outside this report.'}
          </p>
        )}
        <p className="muted">
          List-cost estimates use nominal uncached rates. Provider charges are shown when known.
        </p>
      </section>
      <section aria-labelledby="usage-groups-title">
        <h2 id="usage-groups-title">By model and operation</h2>
        {truncated && (
          <p className="muted">
            Showing the most active groups. The totals cover all recorded usage.
          </p>
        )}
        <ul className="usage-groups">
          {groups.map((group) => (
            <ModelUsage
              key={JSON.stringify([
                group.provider,
                group.model,
                group.kind,
                group.operation,
                group.step,
              ])}
              group={group}
            />
          ))}
        </ul>
      </section>
    </>
  );
}

function RunUsage({ runId }: { runId: string }) {
  const run = useResource(
    (signal) =>
      api.request<UsageSummary>(`usage/me?runId=${encodeURIComponent(runId)}`, { signal }),
    [runId],
  );
  return (
    <>
      <ResourceState {...run} retry={run.refresh} />
      {run.data && <UsageReport report={run.data} />}
    </>
  );
}

export function Usage() {
  const account = useResource((signal) => api.request<UsageSummary>('usage/me', { signal }), []);
  const [runId, setRunId] = useState('');
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Usage</h1>
          <p>Model usage recorded for your account.</p>
        </div>
      </header>
      <ResourceState {...account} retry={account.refresh} />
      {account.data && (
        <>
          {account.data.recentRuns.length > 0 && (
            <label className="usage-run-filter">
              Assessment run
              <select value={runId} onChange={(event) => setRunId(event.target.value)}>
                <option value="">All activity</option>
                {account.data.recentRuns.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.runId.slice(0, 8)} · {recordedDate.format(new Date(run.lastRecordedAt))}
                  </option>
                ))}
              </select>
            </label>
          )}
          {runId ? <RunUsage key={runId} runId={runId} /> : <UsageReport report={account.data} />}
        </>
      )}
    </>
  );
}
