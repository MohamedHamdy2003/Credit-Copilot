import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ASSESSMENT_STAGES,
  assessmentStreamEvent,
  type AssessmentStreamEvent,
} from '../../../packages/contracts/src/streams';
import { api, ApiError } from './api';
import type { Actor, ApplicationDetail, ApplicationRow, Run } from './types';
import { Empty, ErrorNotice, Money, ResourceState, Status, Toast, useResource } from './components';
import { Assessment } from './Assessment';

const stageLabels = {
  load_application: 'Loaded application',
  remove_protected_attributes: 'Removed protected attributes',
  select_policy: 'Selected applicable policy',
  extract_data: 'Extracted assessment data',
  retrieve_policy_clauses: 'Retrieved policy clauses',
  calculate_and_check_rules: 'Calculated affordability and checked rules',
  prepare_memo: 'Prepared credit memo',
  record_pending_review: 'Recorded for human review',
};
function AddApplication({
  onAdded,
  onCancel,
}: {
  onAdded: (id: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const file = form.get('file');
      if (!(file instanceof File) || file.size === 0)
        throw new Error('Choose an application PDF to upload.');
      if (file.size > 10 * 1024 * 1024) throw new Error('File exceeds the 10 MiB limit.');
      const data = new FormData();
      data.set('file', file);
      const result = await api.request<{ id: string }>('applications', { body: data });
      onAdded(result.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>New application</h2>
      <p className="muted">
        Upload an application pack PDF (up to 10 MiB) containing the application form and supporting
        documents.
      </p>
      <ErrorNotice error={error} />
      <form onSubmit={submit}>
        <label>
          Application pack (PDF)
          <input name="file" type="file" accept=".pdf,application/pdf" required disabled={busy} />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
function ApplicationView({
  id,
  actor,
  onChanged,
}: {
  id: string;
  actor: Actor;
  onChanged: () => void;
}) {
  const resource = useResource(
    async (signal) => {
      const application = await api.request<ApplicationDetail>(`applications/${id}`, { signal });
      const run = application.latestAssessmentId
        ? await api.request<Run>(`assessments/${application.latestAssessmentId}`, { signal })
        : null;
      return { application, run };
    },
    [id],
  );
  const [mode, setMode] = useState<'strict' | 'demo'>('strict'),
    [busy, setBusy] = useState(false),
    [completed, setCompleted] = useState(false),
    [reconnecting, setReconnecting] = useState(false),
    [stage, setStage] = useState<Extract<AssessmentStreamEvent, { kind: 'stage' }>>(),
    [error, setError] = useState<unknown>();
  const key = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function assess() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setCompleted(false);
    setStage(undefined);
    setError(undefined);
    key.current ??= crypto.randomUUID();
    try {
      const { runId } = await api.request<{ runId: string }>(
        `applications/${id}/assessment-streams`,
        {
          body: { mode: resource.data?.application.synthetic ? mode : 'strict' },
          key: key.current,
          signal: controller.signal,
        },
      );
      const terminal = await api.follow(`assessment-streams/${runId}`, assessmentStreamEvent, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === 'stage') setStage(event);
        },
        onReconnect: setReconnecting,
      });
      key.current = null;
      if (terminal.kind === 'failed') {
        throw new ApiError(
          503,
          terminal.code,
          'Assessment could not be completed. Run a new assessment to retry.',
        );
      }
      setCompleted(true);
      resource.refresh();
      onChanged();
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e);
      if (
        e instanceof ApiError &&
        e.status > 0 &&
        e.status < 500 &&
        e.code !== 'AssessmentInProgress'
      )
        key.current = null;
    } finally {
      request.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        setReconnecting(false);
      }
    }
  }
  const data = resource.data;
  const effectiveMode = data?.application.synthetic ? mode : 'strict';
  return (
    <>
      <ResourceState {...resource} retry={resource.refresh} />
      {data && (
        <>
          <section className="panel split">
            <div>
              <h2>{data.application.form.reference}</h2>
              <a href={`/api/v1/applications/${id}/evidence`}>Download original</a>
              <dl>
                <div>
                  <dt>Product</dt>
                  <dd>
                    {data.application.form.productId === 'AL-200'
                      ? 'Auto loan (AL-200)'
                      : 'Personal loan (PL-100)'}
                  </dd>
                </div>
                <div>
                  <dt>Requested</dt>
                  <dd>
                    <Money value={data.application.form.amount} />
                  </dd>
                </div>
                <div>
                  <dt>Tenor</dt>
                  <dd>{data.application.form.months} months</dd>
                </div>
                <div>
                  <dt>Application date</dt>
                  <dd>{data.application.form.applicationDate}</dd>
                </div>
                {data.application.form.productId === 'AL-200' && (
                  <>
                    <div>
                      <dt>Vehicle price</dt>
                      <dd>
                        <Money value={data.application.form.vehiclePrice} />
                      </dd>
                    </div>
                    <div>
                      <dt>Documented down payment</dt>
                      <dd>
                        <Money value={data.application.form.downPayment} />
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              <label>
                Assessment mode
                <select
                  value={effectiveMode}
                  disabled={busy || !data.application.synthetic}
                  onChange={(e) => {
                    setMode(e.target.value as 'strict' | 'demo');
                    key.current = null;
                    setError(undefined);
                    setStage(undefined);
                    setCompleted(false);
                  }}
                >
                  <option value="strict">Strict</option>
                  {data.application.synthetic && (
                    <option value="demo">Demo — ID presence assumed</option>
                  )}
                </select>
              </label>
              <p className="muted">
                {effectiveMode === 'strict'
                  ? 'Missing evidence requires human review.'
                  : 'Synthetic demo only. ID copy is assumed present, never verified. Other evidence requirements still apply; the server must enable Demo.'}
              </p>
              {data.application.canAssess && data.run?.status !== 'issued' && (
                <button className="primary" disabled={busy} onClick={() => void assess()}>
                  {busy
                    ? 'Assessing…'
                    : error instanceof ApiError && error.code === 'StreamDisconnected'
                      ? 'Retry connection'
                      : 'Run assessment'}
                </button>
              )}
              {busy && (
                <>
                  <progress
                    className="assessment-progress"
                    aria-label="Assessment progress"
                    max={ASSESSMENT_STAGES.length}
                    value={stage ? ASSESSMENT_STAGES.indexOf(stage.stage) + 1 : 0}
                  />
                  <p role="status">
                    {reconnecting
                      ? 'Reconnecting to assessment…'
                      : stage
                        ? `${stageLabels[stage.stage]}${stage.status === 'executed' ? '' : ` (${stage.status})`}`
                        : 'Starting assessment…'}
                  </p>
                </>
              )}
              {completed && (
                <Toast
                  message="Assessment saved for human review."
                  onDone={() => setCompleted(false)}
                />
              )}
              <ErrorNotice error={error} />
            </div>
            <div>
              <h2>Assessment</h2>
              {data.run ? (
                <>
                  <p>
                    <Status value={data.run.result.recommendation} />
                  </p>
                  {!!data.run.result.evidence.missing.length && (
                    <p>
                      Missing: {data.run.result.evidence.missing.join(', ').replaceAll('_', ' ')}.{' '}
                      {data.run.result.evidence.referral?.citations.join(' · ')}
                    </p>
                  )}
                  <dl>
                    <div>
                      <dt>Lifecycle</dt>
                      <dd>
                        <Status value={data.run.status} />
                      </dd>
                    </div>
                    <div>
                      <dt>Policy</dt>
                      <dd>{data.run.result.policyEdition ?? 'Unresolved'}</dd>
                    </div>
                    <div>
                      <dt>Evidence</dt>
                      <dd>
                        {data.run.result.evidence.fullyEvidenceVerified
                          ? 'Fully verified'
                          : 'Not fully verified'}
                      </dd>
                    </div>
                  </dl>
                  <p className="muted">
                    A recommendation is not human approval or an issued offer.
                  </p>
                </>
              ) : (
                <Empty>No assessment yet.</Empty>
              )}
            </div>
          </section>
          {data.run && (
            <Assessment
              run={data.run}
              actor={actor}
              onChanged={() => {
                resource.refresh();
                onChanged();
              }}
            />
          )}
        </>
      )}
    </>
  );
}
export function Applications({ actor }: { actor: Actor }) {
  const applications = useResource(
    (signal) => api.request<ApplicationRow[]>('applications', { signal }),
    [],
  );
  const [selected, setSelected] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null),
    [deletingId, setDeletingId] = useState<string | null>(null),
    [deleteError, setDeleteError] = useState<unknown>(),
    [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  async function removeDraft(row: ApplicationRow) {
    setDeleteError(undefined);
    setDeleteNotice(null);
    setDeletingId(row.id);
    try {
      await api.request<{ deleted: true; id: string; reference: string }>(
        `applications/${encodeURIComponent(row.id)}`,
        { method: 'DELETE' },
      );
      setConfirmDeleteId(null);
      if (selected === row.id) setSelected(null);
      setDeleteNotice(`Deleted draft application ${row.reference}.`);
      applications.refresh();
    } catch (e) {
      setDeleteError(e);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Applications</h1>
          <p>Review evidence. Assess consistently.</p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>
          New application
        </button>
      </header>
      {adding && (
        <AddApplication
          onAdded={(id) => {
            applications.refresh();
            setSelected(id);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {deleteNotice && <Toast message={deleteNotice} onDone={() => setDeleteNotice(null)} />}
      <ErrorNotice error={deleteError} />
      <ResourceState {...applications} retry={applications.refresh} />
      {applications.data && (
        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Status</th>
                <th>Evidence</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {applications.data.map((row) => (
                <tr key={row.id} className={selected === row.id ? 'selected' : ''}>
                  <td>{row.reference}</td>
                  <td>
                    <Status value={row.status} />
                  </td>
                  <td>{row.synthetic ? 'Synthetic pack' : 'Uploaded PDF'}</td>
                  <td>
                    <div className="table-actions">
                      <button
                        aria-label={`Open ${row.reference}`}
                        onClick={() => setSelected(row.id)}
                      >
                        Open
                      </button>
                      {row.can_delete &&
                        (confirmDeleteId === row.id ? (
                          <div className="inline-confirm">
                            <button
                              type="button"
                              className="danger-button"
                              disabled={deletingId === row.id}
                              onClick={() => void removeDraft(row)}
                            >
                              {deletingId === row.id ? 'Deleting…' : 'Confirm delete'}
                            </button>
                            <button
                              type="button"
                              disabled={deletingId === row.id}
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="danger-outline"
                            aria-label={`Delete ${row.reference}`}
                            disabled={deletingId !== null}
                            onClick={() => {
                              setConfirmDeleteId(row.id);
                              setDeleteError(undefined);
                            }}
                          >
                            Delete
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!applications.data.length && (
            <Empty>No applications yet. Upload an application PDF to begin.</Empty>
          )}
        </section>
      )}
      {selected && (
        <ApplicationView
          key={selected}
          id={selected}
          actor={actor}
          onChanged={applications.refresh}
        />
      )}
    </>
  );
}
