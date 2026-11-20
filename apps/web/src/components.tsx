import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';
export function message(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
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
export function Status({ value }: { value: string | null | undefined }) {
  return (
    <span className="status">{(value ?? 'Not assessed').replaceAll('_', ' ').toLowerCase()}</span>
  );
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
