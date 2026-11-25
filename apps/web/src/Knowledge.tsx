import { useState, type FormEvent } from 'react';
import { api } from './api';
import type { Actor, KnowledgeDocument, IngestionAttempt, IngestionResult } from './types';
import { Empty, ErrorNotice, ResourceState, Status, useResource } from './components';
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
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [results, setResults] = useState<IngestionResult[]>();
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form);
    const files = data.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    setError(undefined);
    setResults(undefined);
    if (!files.length || files.length > 20 || files.some((f) => f.size > 10 * 1024 * 1024)) {
      setError(new Error('Choose 1–20 files, no larger than 10 MiB each.'));
      return;
    }
    setBusy(true);
    try {
      const result = await api.request<{ results: IngestionResult[] }>('knowledge/ingestions', {
        body: data,
      });
      setResults(result.results);
      documents.refresh();
      attempts.refresh();
      form.reset();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Policy library</h1>
          <p>Reviewed policies. Traceable sources.</p>
        </div>
      </header>
      <p className="notice">
        Policy documents only. Customer applications are stored separately and never enter this
        library.
      </p>
      {actor.canIngest ? (
        <section className="panel">
          <h2>Ingest reviewed documents</h2>
          <form onSubmit={upload}>
            <label>
              Policy files
              <input name="files" type="file" multiple accept=".pdf,.csv,.md" required />
            </label>
            <p className="muted">
              PDF, CSV or MD · 10 MiB per file · 20 files maximum. Only the reviewed source hashes
              are accepted.
            </p>
            <button className="primary" disabled={busy}>
              {busy ? 'Ingesting…' : 'Ingest documents'}
            </button>
          </form>
          <ErrorNotice error={error} />
          {results && (
            <div aria-live="polite">
              <h3>Batch results</h3>
              <ul>
                {results.map((r, i) => (
                  <li key={i}>
                    {r.filename} —{' '}
                    {r.status === 'failed' ? `failed: ${r.code}` : (r.result?.status ?? r.status)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : (
        <p className="muted">
          Your account can read the policy library. Ingestion requires separate permission.
        </p>
      )}
      <ResourceState {...documents} retry={documents.refresh} />
      {documents.data && (
        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Edition</th>
                <th>Index version</th>
              </tr>
            </thead>
            <tbody>
              {documents.data.map((d) => (
                <tr key={d.id}>
                  <td className="break">{d.filename}</td>
                  <td>{d.metadata.edition ?? '—'}</td>
                  <td>{d.pipeline_version}</td>
                </tr>
              ))}
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
