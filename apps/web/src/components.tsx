import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';
export function message(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}
export function Toast({
  message: text,
  durationMs = 2600,
  onDone,
}: {
  message: string;
  durationMs?: number;
  onDone: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const closeTimer = useRef<number | null>(null);
  useEffect(() => {
    setLeaving(false);
    const fadeTimer = window.setTimeout(() => setLeaving(true), durationMs);
    const removeTimer = window.setTimeout(() => doneRef.current(), durationMs + 320);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(removeTimer);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    };
  }, [text, durationMs]);
  return (
    <div className={`toast${leaving ? ' is-leaving' : ''}`} role="status" aria-live="polite">
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-text">{text}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss notification"
        onClick={() => {
          setLeaving(true);
          closeTimer.current = window.setTimeout(() => doneRef.current(), 180);
        }}
      >
        ×
      </button>
    </div>
  );
}
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busyLabel = 'Working…',
  busy = false,
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
      >
        <div className="modal-body">
          <div className={`modal-icon${danger ? ' is-danger' : ''}`} aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M7.5 3.5H12.5M3.5 5.5H16.5M15 5.5L14.3 15.1C14.2 16.2 13.3 17 12.2 17H7.8C6.7 17 5.8 16.2 5.7 15.1L5 5.5M8.25 9V13.5M11.75 9V13.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="modal-copy">
            <h2 id="confirm-dialog-title">{title}</h2>
            <p id="confirm-dialog-desc">{description}</p>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <div className="modal-footer">
          <button type="button" disabled={busy} autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'danger-button' : 'primary'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <strong>{message(error)}</strong>
      {error instanceof ApiError && (
        <small>
          {error.code}
          {error.requestId ? ` · Request ${error.requestId}` : ''}
        </small>
      )}
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
const LIFECYCLE_STATUS: Record<string, { label: string; tone: string; detail?: string }> = {
  pending_review: { label: 'Pending', tone: 'pending', detail: 'Pending human review' },
  pending_approval: { label: 'Pending', tone: 'pending', detail: 'Pending approval' },
  pending_customer_acceptance: {
    label: 'Pending',
    tone: 'pending',
    detail: 'Pending customer acceptance',
  },
  approved: { label: 'Approved', tone: 'approved' },
  rejected: { label: 'Rejected', tone: 'rejected' },
  issued: { label: 'Issued', tone: 'issued' },
};
export function Status({ value }: { value: string | null | undefined }) {
  if (!value) {
    return <span className="status status-pill status-neutral">Not assessed</span>;
  }
  const lifecycle = LIFECYCLE_STATUS[value];
  if (lifecycle) {
    return (
      <span className={`status status-pill status-${lifecycle.tone}`} title={lifecycle.detail}>
        {lifecycle.label}
      </span>
    );
  }
  return <span className="status">{value.replaceAll('_', ' ').toLowerCase()}</span>;
}
export function Money({ value }: { value: string | undefined | null }) {
  return (
    <>
      {value
        ? `EGP ${Number(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '—'}
    </>
  );
}
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState<unknown>(),
    [loading, setLoading] = useState(true),
    [revision, refresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setData(undefined);
    setError(undefined);
    setLoading(true);
    load(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setData(value);
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [...deps, revision]);
  return { data, error, loading, refresh: () => refresh((v) => v + 1) };
}
export function ResourceState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: unknown;
  retry: () => void;
}) {
  return (
    <>
      {loading && <p role="status">Loading…</p>}
      <ErrorNotice error={error} />
      {!!error && <button onClick={retry}>Retry</button>}
    </>
  );
}
