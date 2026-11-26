import { ASSESSMENT_STAGES, type AssessmentStage } from '../../../packages/contracts/src/streams';

export type PipelineStageStatus = 'pending' | 'running' | 'executed' | 'skipped' | 'failed';

const STAGE_META: Record<AssessmentStage, { step: string; title: string; subtitle: string }> = {
  load_application: {
    step: '1',
    title: 'Load application',
    subtitle: 'Validate form schema & evidence',
  },
  remove_protected_attributes: {
    step: '2',
    title: 'Privacy & tampering',
    subtitle: 'Strip 4 protected fields locally',
  },
  select_policy: {
    step: '3',
    title: 'Select policy',
    subtitle: 'Match dated edition & pricing',
  },
  extract_data: {
    step: '4',
    title: 'Extract data',
    subtitle: 'LLM JSON & verbatim quote check',
  },
  retrieve_policy_clauses: {
    step: '5',
    title: 'Retrieve clauses',
    subtitle: 'Active edition & circular rules',
  },
  calculate_and_check_rules: {
    step: '6',
    title: 'Rules & math',
    subtitle: '50-digit Decimal & eligibility',
  },
  prepare_memo: {
    step: '7',
    title: 'Credit memo',
    subtitle: 'Code-rendered memo & authority',
  },
  record_pending_review: {
    step: '8',
    title: 'Save for review',
    subtitle: 'Persist Pending run & audit trail',
  },
};

const STATUS_LABELS: Record<PipelineStageStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  executed: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
};

export function AssessmentPipeline({
  stages,
  running = false,
  heading,
  reconnecting = false,
  compact = false,
}: {
  stages: Partial<Record<AssessmentStage, 'executed' | 'skipped' | 'failed'>>;
  running?: boolean;
  heading?: string;
  reconnecting?: boolean;
  compact?: boolean;
}) {
  const firstUnfinished = running
    ? ASSESSMENT_STAGES.find((stage) => stages[stage] === undefined)
    : undefined;
  const completedCount = ASSESSMENT_STAGES.filter((stage) => stages[stage] !== undefined).length;
  const executedCount = ASSESSMENT_STAGES.filter((stage) => stages[stage] === 'executed').length;
  const skippedCount = ASSESSMENT_STAGES.filter((stage) => stages[stage] === 'skipped').length;
  const failedCount = ASSESSMENT_STAGES.filter((stage) => stages[stage] === 'failed').length;

  return (
    <section
      className={compact ? 'assessment-pipeline is-compact' : 'panel assessment-pipeline'}
      aria-label="Assessment pipeline stages"
      aria-live="polite"
    >
      <div className="ingestion-pipeline-head">
        {heading ? <h2>{heading}</h2> : <h3>Assessment pipeline</h3>}
        <small className="muted">
          {running
            ? reconnecting
              ? 'Reconnecting to live stream…'
              : `Stage ${Math.min(completedCount + 1, ASSESSMENT_STAGES.length)} of ${ASSESSMENT_STAGES.length} running`
            : `${executedCount} executed${skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}${failedCount > 0 ? ` · ${failedCount} failed` : ''}`}
        </small>
      </div>
      <ol className="stage-grid assessment-stage-grid">
        {ASSESSMENT_STAGES.map((stage) => {
          const recorded = stages[stage];
          const status: PipelineStageStatus =
            recorded ?? (stage === firstUnfinished ? 'running' : 'pending');
          const visualClass =
            status === 'executed'
              ? 'stage-completed'
              : status === 'running'
                ? 'stage-running'
                : status === 'skipped'
                  ? 'stage-skipped'
                  : status === 'failed'
                    ? 'stage-failed'
                    : 'stage-pending';
          const meta = STAGE_META[stage];
          return (
            <li key={stage} className={`stage-step ${visualClass}`} data-stage={stage}>
              <div className="stage-title">
                <span className="stage-num" aria-hidden="true">
                  {status === 'executed'
                    ? '✓'
                    : status === 'skipped'
                      ? '–'
                      : status === 'failed'
                        ? '!'
                        : meta.step}
                </span>
                <strong>{meta.title}</strong>
                <span className="stage-badge">{STATUS_LABELS[status]}</span>
              </div>
              <small>{meta.subtitle}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
