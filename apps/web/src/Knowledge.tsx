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

const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
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

function parseHeaderDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(trimmed);
  if (!match) return null;
  const month = MONTHS[match[2]!.toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[1]!.padStart(2, '0')}`;
}

function detectPolicyMetadata(
  filename: string,
  sampleText: string,
): {
  product?: 'PL-100' | 'AL-200';
  kind?: PolicyKind;
  edition?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
} {
  const lower = filename.toLowerCase();
  const combined = `${filename}\n${sampleText}`;
  const product: 'PL-100' | 'AL-200' | undefined = /\bAL-200\b|\bauto[\s-]?loan\b/i.test(combined)
    ? 'AL-200'
    : /\bPL-100\b|\bpersonal[\s-]?loan\b/i.test(combined)
      ? 'PL-100'
      : undefined;
  const kind: PolicyKind | undefined =
    lower.endsWith('.csv') || /\bpricing\b/i.test(lower)
      ? 'pricing'
      : /\bcircular\b/i.test(combined)
        ? 'circular'
        : /\bprocedure/i.test(combined)
          ? 'procedure'
          : /\bproduct\s+sheet\b/i.test(combined)
            ? 'product'
            : /\bpolicy\b/i.test(combined)
              ? 'policy'
              : undefined;
  const editionMatch =
    /\b(CP-20\d{2}|AUTO-20\d{2})\b/i.exec(combined) ??
    /\bCircular\s+(20\d{2})\/(\d{2})\b/i.exec(combined);
  const edition = editionMatch
    ? editionMatch[2]
      ? `C-${editionMatch[1]}-${editionMatch[2]}`
      : editionMatch[1]!.toUpperCase()
    : undefined;
  const effectiveFromMatch =
    /\b(?:Effective(?:\s+from)?|IN FORCE from)[:*\s]+(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/i.exec(
      sampleText,
    );
  const effectiveFrom = effectiveFromMatch
    ? (parseHeaderDate(effectiveFromMatch[1]!) ?? undefined)
    : undefined;
  const effectiveToMatch =
    /\b(?:Effective\s+to|Superseded[^.\n]*?\bon|Ends)[:*\s]+(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/i.exec(
      sampleText,
    );
  const effectiveTo = effectiveToMatch
    ? (parseHeaderDate(effectiveToMatch[1]!) ?? undefined)
    : undefined;
  return { product, kind, edition, effectiveFrom, effectiveTo };
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
  const [customId, setCustomId] = useState('');
  const [customEdition, setCustomEdition] = useState('');
  const [customProduct, setCustomProduct] = useState<'PL-100' | 'AL-200'>('PL-100');
  const [customKind, setCustomKind] = useState<PolicyKind>('policy');
  const [effectiveFrom, setEffectiveFrom] = useState(todayCairo);
  const [effectiveTo, setEffectiveTo] = useState('');
  const [autoFillNote, setAutoFillNote] = useState<string | null>(null);

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

  async function handleFilesSelected(fileList: FileList | null) {
    setAutoFillNote(null);
    if (!fileList || fileList.length !== 1) return;
    const file = fileList[0]!;
    if (/^(?:APP|AUTO)-\d+/i.test(file.name)) return;
    const alreadyIndexed = (documents.data ?? []).some((doc) => doc.filename === file.name);
    if (alreadyIndexed) return;
    const isText = /\.(?:md|csv)$/i.test(file.name);
    const sampleText = isText
      ? await file
          .slice(0, 4096)
          .text()
          .catch(() => '')
      : '';
    const detected = detectPolicyMetadata(file.name, sampleText);
    const filled: string[] = [];
    if (detected.product) {
      setCustomProduct(detected.product);
      filled.push('product');
    }
    if (detected.kind) {
      setCustomKind(detected.kind);
      filled.push('type');
    }
    if (detected.edition && !customEdition.trim()) {
      setCustomEdition(detected.edition);
      filled.push('edition');
    }
    if (detected.effectiveFrom) {
      setEffectiveFrom(detected.effectiveFrom);
      filled.push('effective date');
    }
    if (detected.effectiveTo) {
      setEffectiveTo(detected.effectiveTo);
      filled.push('expiry date');
    }
    if (filled.length > 0) {
      setAutoFillNote(
        `Auto-detected ${filled.join(', ')} from ${file.name}. Review before ingesting.`,
      );
    }
  }

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
    const payload = new FormData();
    for (const file of files) payload.append('files', file);
    const hasCustomMetadata = customEdition.trim().length > 0;
    if (hasCustomMetadata) {
      if (!effectiveFrom) {
        setError(new Error('Provide an effective-from date when specifying a custom edition.'));
        return;
      }
      if (effectiveTo && effectiveTo <= effectiveFrom) {
        setError(new Error('Effective-to date must be later than effective-from date.'));
        return;
      }
      payload.append(
        'metadata',
        JSON.stringify({
          ...(customId.trim() ? { id: customId.trim() } : {}),
          edition: customEdition.trim(),
          product: customProduct,
          kind: customKind,
          effectiveFrom,
          effectiveTo: effectiveTo || null,
        }),
      );
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
      setCustomId('');
      setCustomEdition('');
      setEffectiveFrom(todayCairo());
      setEffectiveTo('');
      setAutoFillNote(null);
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
            Upload one or more policy files (PDF, CSV, or MD · up to 10 MiB each). Recognized bank
            policies match automatically; specify edition and validity dates below for new policies.
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
                onChange={(event) => void handleFilesSelected(event.currentTarget.files)}
              />
            </label>

            <fieldset className="policy-metadata-box">
              <legend>Validity &amp; metadata (for new policies)</legend>
              {autoFillNote && (
                <p className="autofill-hint" role="status">
                  {autoFillNote}
                </p>
              )}
              <div className="form-grid">
                <label>
                  Product
                  <select
                    value={customProduct}
                    disabled={busy}
                    onChange={(event) =>
                      setCustomProduct(event.target.value as 'PL-100' | 'AL-200')
                    }
                  >
                    <option value="PL-100">Personal loan (PL-100)</option>
                    <option value="AL-200">Auto loan (AL-200)</option>
                  </select>
                </label>
                <label>
                  Document type
                  <select
                    value={customKind}
                    disabled={busy}
                    onChange={(event) => setCustomKind(event.target.value as PolicyKind)}
                  >
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
                    value={customEdition}
                    disabled={busy}
                    maxLength={40}
                    placeholder="Optional for bank policies · e.g. CP-2026"
                    onChange={(event) => setCustomEdition(event.target.value)}
                  />
                </label>
                <label>
                  Document ID (optional)
                  <input
                    type="text"
                    value={customId}
                    disabled={busy}
                    maxLength={64}
                    pattern="[A-Za-z0-9._-]{2,64}"
                    placeholder="Auto-generated if left blank"
                    onChange={(event) => setCustomId(event.target.value)}
                  />
                </label>
                <label>
                  Effective from
                  <input
                    type="date"
                    value={effectiveFrom}
                    disabled={busy}
                    required={customEdition.trim().length > 0}
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
            </fieldset>

            <button className="primary" disabled={busy}>
              {busy ? 'Ingesting…' : 'Ingest documents'}
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
