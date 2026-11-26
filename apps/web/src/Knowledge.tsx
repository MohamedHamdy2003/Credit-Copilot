import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  INGESTION_STAGES,
  ingestionStreamEvent,
  type IngestionStage,
} from '../../../packages/contracts/src/streams.js';
import { api } from './api';
import type { Actor, KnowledgeDocument, IngestionAttempt } from './types';
import {
  ConfirmDialog,
  Empty,
  ErrorNotice,
  ResourceState,
  Status,
  Toast,
  useResource,
} from './components';

type StageState = {
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
  detail?: string;
  current?: number;
  total?: number;
};

interface FileProgress {
  fileIndex: number;
  filename: string;
  stages: Record<IngestionStage, StageState>;
  outcome?: {
    status: 'succeeded' | 'skipped' | 'failed';
    documentId?: string;
    chunks?: number;
    code?: string;
    message?: string;
  };
}

interface BatchSummary {
  totalFiles: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

type PolicyKind = 'policy' | 'product' | 'procedure' | 'circular' | 'pricing';

const STAGE_LABELS: Record<IngestionStage, { step: string; title: string }> = {
  extract: { step: '1', title: 'Extract' },
  chunk: { step: '2', title: 'Chunk' },
  embed: { step: '3', title: 'Embed' },
  index: { step: '4', title: 'Index' },
};

function initialStages(): Record<IngestionStage, StageState> {
  return {
    extract: { status: 'pending' },
    chunk: { status: 'pending' },
    embed: { status: 'pending' },
    index: { status: 'pending' },
  };
}

function sourceHref(filename: string) {
  return `/api/v1/knowledge/source?filename=${encodeURIComponent(filename)}`;
}

function todayCairo() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
}

function validityStatus(effectiveFrom?: string, effectiveTo?: string | null) {
  const today = todayCairo();
  if (effectiveFrom && today < effectiveFrom)
    return { label: 'Scheduled', tone: 'status-scheduled' };
  if (effectiveTo && today >= effectiveTo) return { label: 'Expired', tone: 'status-neutral' };
  return { label: 'Active', tone: 'status-approved' };
}

export function Knowledge({ actor }: { actor: Actor }) {
  const documents = useResource(
    (signal) => api.request<KnowledgeDocument[]>('knowledge/documents', { signal }),
    [],
  );
  const attempts = useResource(
    (signal) =>
      actor.canIngest
        ? api.request<IngestionAttempt[]>('knowledge/ingestions', { signal })
        : Promise.resolve([]),
    [actor.canIngest],
  );
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideId, setOverrideId] = useState('');
  const [overrideEdition, setOverrideEdition] = useState('');
  const [overrideProduct, setOverrideProduct] = useState<'' | 'PL-100' | 'AL-200'>('');
  const [overrideKind, setOverrideKind] = useState<'' | PolicyKind>('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');

  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<unknown>();
  const [filesProgress, setFilesProgress] = useState<FileProgress[]>([]);
  const [summary, setSummary] = useState<BatchSummary | null>(null);

  const [pendingDelete, setPendingDelete] = useState<KnowledgeDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>();

  const streamAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => streamAbort.current?.abort();
  }, []);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const rawData = new FormData(form);
    const files = rawData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    setError(undefined);
    setDeleteError(undefined);
    setDeleteNotice(null);
    setSummary(null);
    if (!files.length || files.length > 20 || files.some((f) => f.size > 10 * 1024 * 1024)) {
      setError(new Error('Choose 1–20 files, no larger than 10 MiB each.'));
      return;
    }
    if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) {
      setError(new Error('Effective-to date must be later than effective-from date.'));
      return;
    }

    const payload = new FormData();
    for (const file of files) payload.append('files', file);

    const override: Record<string, string | null> = {};
    if (overrideId.trim()) override.id = overrideId.trim();
    if (overrideEdition.trim()) override.edition = overrideEdition.trim();
    if (overrideProduct) override.product = overrideProduct;
    if (overrideKind) override.kind = overrideKind;
    if (effectiveFrom) override.effectiveFrom = effectiveFrom;
    if (effectiveTo) override.effectiveTo = effectiveTo;
    if (Object.keys(override).length > 0) {
      payload.append('metadata', JSON.stringify(override));
    }

    setFilesProgress(
      files.map((file, fileIndex) => ({
        fileIndex,
        filename: file.name,
        stages: initialStages(),
      })),
    );
    streamAbort.current?.abort();
    const abort = new AbortController();
    streamAbort.current = abort;
    setBusy(true);
    setReconnecting(false);
    try {
      const { streamId } = await api.request<{ streamId: string }>('knowledge/ingestions/streams', {
        body: payload,
        signal: abort.signal,
      });
      const finalEvent = await api.follow(
        `knowledge/ingestion-streams/${streamId}`,
        ingestionStreamEvent,
        {
          signal: abort.signal,
          onReconnect: setReconnecting,
          onEvent: (frame) => {
            if (frame.kind === 'stage') {
              setFilesProgress((previous) =>
                previous.map((item) =>
                  item.fileIndex === frame.fileIndex
                    ? {
                        ...item,
                        stages: {
                          ...item.stages,
                          [frame.stage]: {
                            status: frame.status,
                            detail: frame.detail,
                            current: frame.current,
                            total: frame.total,
                          },
                        },
                      }
                    : item,
                ),
              );
            } else if (frame.kind === 'file_completed') {
              setFilesProgress((previous) =>
                previous.map((item) =>
                  item.fileIndex === frame.fileIndex
                    ? {
                        ...item,
                        outcome: {
                          status: frame.status,
                          documentId: frame.documentId,
                          chunks: frame.chunks,
                          code: frame.code,
                          message: frame.message,
                        },
                      }
                    : item,
                ),
              );
            }
          },
        },
      );
      if (finalEvent.kind === 'completed') {
        setSummary({
          totalFiles: finalEvent.totalFiles,
          succeeded: finalEvent.succeeded,
          skipped: finalEvent.skipped,
          failed: finalEvent.failed,
        });
      } else if (finalEvent.kind === 'failed') {
        setError(new Error(`Ingestion stream failed (${finalEvent.code}).`));
      }
      documents.refresh();
      attempts.refresh();
      form.reset();
      setOverrideId('');
      setOverrideEdition('');
      setOverrideProduct('');
      setOverrideKind('');
      setEffectiveFrom('');
      setEffectiveTo('');
      setOverrideOpen(false);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError(e);
    } finally {
      setBusy(false);
      setReconnecting(false);
    }
  }

  async function removeDocument(doc: KnowledgeDocument) {
    setDeleteError(undefined);
    setDeleteNotice(null);
    setDeleting(true);
    try {
      await api.request<{ deleted: true; id: string; filename: string }>(
        `knowledge/documents/${encodeURIComponent(doc.id)}`,
        { method: 'DELETE' },
      );
      setPendingDelete(null);
      setDeleteNotice(
        `Deleted ${doc.filename} (${doc.id}) and its indexed chunks. You can upload it again to re-run ingestion.`,
      );
      documents.refresh();
      attempts.refresh();
    } catch (e) {
      setPendingDelete(null);
      setDeleteError(e);
    } finally {
      setDeleting(false);
    }
  }

  const totalChunks = (documents.data ?? []).reduce((sum, doc) => sum + (doc.chunk_count ?? 0), 0);
  const activeOverrideCount = [
    overrideId.trim(),
    overrideEdition.trim(),
    overrideProduct,
    overrideKind,
    effectiveFrom,
    effectiveTo,
  ].filter(Boolean).length;

  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Policy library</h1>
          <p>Ingest, inspect, and manage dated lending policies with live pipeline stages.</p>
        </div>
      </header>
      {actor.canIngest ? (
        <section className="panel">
          <h2>Ingest policy documents</h2>
          <p className="muted">
            Upload policy files (PDF, CSV, or MD · up to 10 MiB each). Edition, product, and
            validity dates are read automatically from each document header or bank manifest.
          </p>

          <form onSubmit={upload}>
            <label>
              Policy files
              <input
                name="files"
                type="file"
                multiple
                accept=".pdf,.csv,.md"
                required
                disabled={busy}
              />
            </label>

            <details
              className="policy-override"
              open={overrideOpen}
              onToggle={(event) => setOverrideOpen(event.currentTarget.open)}
            >
              <summary className="policy-override-summary">
                <span>
                  Override validity dates &amp; metadata (optional)
                  {activeOverrideCount > 0 && (
                    <span className="policy-override-badge">{activeOverrideCount} set</span>
                  )}
                </span>
                <svg
                  className="policy-override-chevron"
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6.25L8 10.25L12 6.25"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </summary>

              {overrideOpen && (
                <div className="policy-override-body">
                  <p className="muted policy-override-hint">
                    Leave blank to use values detected from the file header. Fill any field below to
                    override or supply missing dates for a custom policy.
                  </p>
                  <div className="form-grid">
                    <label>
                      Product
                      <select
                        value={overrideProduct}
                        disabled={busy}
                        onChange={(event) =>
                          setOverrideProduct(event.target.value as '' | 'PL-100' | 'AL-200')
                        }
                      >
                        <option value="">Auto-detect from file</option>
                        <option value="PL-100">Personal loan (PL-100)</option>
                        <option value="AL-200">Auto loan (AL-200)</option>
                      </select>
                    </label>
                    <label>
                      Document type
                      <select
                        value={overrideKind}
                        disabled={busy}
                        onChange={(event) => setOverrideKind(event.target.value as '' | PolicyKind)}
                      >
                        <option value="">Auto-detect from file</option>
                        <option value="policy">Credit policy</option>
                        <option value="circular">Circular</option>
                        <option value="product">Product sheet</option>
                        <option value="procedure">Procedures manual</option>
                        <option value="pricing">Pricing table (CSV)</option>
                      </select>
                    </label>
                    <label>
                      Policy edition
                      <input
                        type="text"
                        value={overrideEdition}
                        disabled={busy}
                        maxLength={40}
                        placeholder="Auto-detect · e.g. CP-2026"
                        onChange={(event) => setOverrideEdition(event.target.value)}
                      />
                    </label>
                    <label>
                      Document ID (optional)
                      <input
                        type="text"
                        value={overrideId}
                        disabled={busy}
                        maxLength={64}
                        pattern="[A-Za-z0-9._-]{2,64}"
                        placeholder="Auto-detected or generated"
                        onChange={(event) => setOverrideId(event.target.value)}
                      />
                    </label>
                    <label>
                      Effective from
                      <input
                        type="date"
                        value={effectiveFrom}
                        disabled={busy}
                        onChange={(event) => setEffectiveFrom(event.target.value)}
                      />
                    </label>
                    <label>
                      Effective to (optional)
                      <input
                        type="date"
                        value={effectiveTo}
                        disabled={busy}
                        onChange={(event) => setEffectiveTo(event.target.value)}
                      />
                    </label>
                  </div>
                </div>
              )}
            </details>

            <button className="primary" disabled={busy}>
              {busy ? 'Uploading & indexing…' : 'Upload & index'}
            </button>
          </form>

          <ErrorNotice error={error} />

          {!!filesProgress.length && (
            <section
              className="ingestion-pipeline"
              aria-live="polite"
              aria-label="Ingestion stages"
            >
              <div className="ingestion-pipeline-head">
                <h3>Ingestion pipeline progress</h3>
                {reconnecting && (
                  <small role="status">Reconnecting to live ingestion stream…</small>
                )}
                {summary && (
                  <small>
                    Completed {summary.totalFiles} files: {summary.succeeded} indexed ·{' '}
                    {summary.skipped} skipped · {summary.failed} failed
                  </small>
                )}
              </div>
              <div className="ingestion-file-list">
                {filesProgress.map((file) => {
                  const headline = file.outcome
                    ? file.outcome.status === 'failed'
                      ? `${file.filename} — failed: ${file.outcome.code ?? 'IngestionFailed'}`
                      : `${file.filename} — ${file.outcome.status}`
                    : `${file.filename} — processing`;
                  return (
                    <article
                      className="ingestion-file-card"
                      key={`${file.fileIndex}-${file.filename}`}
                    >
                      <div className="ingestion-file-head">
                        <strong className="break">{headline}</strong>
                        {file.outcome?.documentId && (
                          <small>
                            {file.outcome.documentId}
                            {file.outcome.chunks !== undefined
                              ? ` · ${file.outcome.chunks} chunks`
                              : ''}
                          </small>
                        )}
                      </div>
                      <ol className="stage-grid">
                        {INGESTION_STAGES.map((stage) => {
                          const info = file.stages[stage];
                          const meta = STAGE_LABELS[stage];
                          return (
                            <li key={stage} className={`stage-step stage-${info.status}`}>
                              <div className="stage-title">
                                <span className="stage-num">{meta.step}</span>
                                <strong>{meta.title}</strong>
                                <span className="stage-badge">{info.status}</span>
                              </div>
                              {info.detail && <small>{info.detail}</small>}
                              {info.status === 'running' &&
                                info.total !== undefined &&
                                info.current !== undefined && (
                                  <progress
                                    className="stage-progress"
                                    value={info.current}
                                    max={info.total}
                                  />
                                )}
                            </li>
                          );
                        })}
                      </ol>
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </section>
      ) : (
        <p className="muted">
          Your account can read the policy library. Ingestion requires separate permission. Sign in
          as <code>head-credit</code> to upload or delete policies.
        </p>
      )}

      {deleteNotice && <Toast message={deleteNotice} onDone={() => setDeleteNotice(null)} />}
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.filename}?`}
          description={
            <>
              This will permanently remove <strong>{pendingDelete.filename}</strong> (
              <code>{pendingDelete.id}</code>) and all its indexed chunks from the policy library.
            </>
          }
          confirmLabel="Delete policy"
          busyLabel="Deleting…"
          busy={deleting}
          onConfirm={() => void removeDocument(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      <ErrorNotice error={deleteError} />
      <ResourceState {...documents} retry={documents.refresh} />

      {documents.data && (
        <section className="table-wrap">
          {!!documents.data.length && (
            <div className="library-summary">
              <strong>{documents.data.length} indexed sources</strong>
              <span className="muted">{totalChunks} active chunks</span>
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Product</th>
                <th>Edition</th>
                <th>Effective</th>
                <th>Validity</th>
                <th>Chunks</th>
                {actor.canIngest && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {documents.data.map((d) => {
                const validity = validityStatus(d.metadata.effectiveFrom, d.metadata.effectiveTo);
                return (
                  <tr key={d.id}>
                    <td className="break">
                      <a href={sourceHref(d.filename)} target="_blank" rel="noopener noreferrer">
                        {d.filename}
                      </a>
                      <small className="doc-id">{d.id}</small>
                    </td>
                    <td>{d.metadata.product ?? '—'}</td>
                    <td>{d.metadata.edition ?? '—'}</td>
                    <td>
                      {d.metadata.effectiveFrom ?? '—'}
                      {d.metadata.effectiveTo ? ` → ${d.metadata.effectiveTo}` : ''}
                    </td>
                    <td>
                      <span className={`status-pill ${validity.tone}`}>{validity.label}</span>
                    </td>
                    <td>{d.chunk_count ?? '—'}</td>
                    {actor.canIngest && (
                      <td>
                        <button
                          type="button"
                          className="danger-outline"
                          disabled={deleting || busy}
                          onClick={() => {
                            setPendingDelete(d);
                            setDeleteError(undefined);
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!documents.data.length && <Empty>No policies indexed yet.</Empty>}
        </section>
      )}

      {actor.canIngest && (
        <section className="panel">
          <h2>Ingestion history</h2>
          <ResourceState {...attempts} retry={attempts.refresh} />
          {attempts.data?.length ? (
            <ul className="history">
              {attempts.data.map((a) => (
                <li key={a.id}>
                  <span className="break">{a.filename}</span>
                  <Status value={a.status} />
                  {a.error_code && <small>{a.error_code}</small>}
                </li>
              ))}
            </ul>
          ) : (
            !attempts.loading && <Empty>No ingestion attempts recorded.</Empty>
          )}
        </section>
      )}
    </>
  );
}
