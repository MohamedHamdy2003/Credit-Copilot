import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import type { Session } from './types';
import { ErrorNotice } from './components';
import { Applications } from './Applications';
import { Questions } from './Questions';
import { Affordability } from './Affordability';
import { Knowledge } from './Knowledge';
import { Reviews } from './Reviews';
import { Usage } from './Usage';
import { ModelSwitcher } from './ModelSwitcher';
const pages = [
  'Applications',
  'Delta Copilot',
  'Affordability calculator',
  'Policy library',
  'Usage',
  'Review queue',
] as const;
type Page = (typeof pages)[number];
function Login({ onLogin, expired }: { onLogin: (s: Session) => void; expired: boolean }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      onLogin(
        await api.request<Session>('auth/login', {
          body: { username: data.get('username'), password: data.get('password') },
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="login-brand">Credit Copilot</div>
      <section className="login-panel">
        <h1>Sign in</h1>
        <p className="muted">Your lending workspace, grounded in policy.</p>
        {expired && (
          <p className="notice" role="status">
            Your session ended. Sign in again to continue.
          </p>
        )}
        <ErrorNotice error={error} />
        <form onSubmit={submit}>
          <label>
            Username
            <input name="username" autoComplete="username" required maxLength={100} />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="muted">Synthetic cases only. Human approval is required before issuance.</p>
      </section>
    </main>
  );
}
export function App() {
  const [session, setSession] = useState<Session | null>(null),
    [initializing, setInitializing] = useState(true),
    [expired, setExpired] = useState(false);
  const [initialError, setInitialError] = useState<unknown>(),
    [page, setPage] = useState<Page>('Applications'),
    [logoutBusy, setLogoutBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [restoreRevision, setRestoreRevision] = useState(0);
  function accept(s: Session) {
    api.setCsrf(s.csrfToken);
    setSession(s);
    setExpired(false);
    setError(undefined);
    setPage('Applications');
  }
  useEffect(() => {
    api.onUnauthorized = () => {
      setSession(null);
      setExpired(true);
    };
    const abort = new AbortController();
    setInitializing(true);
    setInitialError(undefined);
    api
      .request<Session>('auth/me', { signal: abort.signal })
      .then((s) => {
        if (!abort.signal.aborted) {
          api.setCsrf(s.csrfToken);
          setSession(s);
          setExpired(false);
        }
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) setExpired(false);
          else setInitialError(e);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setInitializing(false);
      });
    return () => {
      abort.abort();
      api.onUnauthorized = undefined;
    };
  }, [restoreRevision]);
  async function logout() {
    setLogoutBusy(true);
    setError(undefined);
    try {
      await api.request('auth/logout', { body: {} });
      api.setCsrf('');
      setSession(null);
      setExpired(false);
    } catch (e) {
      setError(e);
    } finally {
      setLogoutBusy(false);
    }
  }
  if (initializing)
    return (
      <main className="login">
        <p role="status">Opening your workspace…</p>
      </main>
    );
  if (initialError)
    return (
      <main className="login">
        <ErrorNotice error={initialError} />
        <button onClick={() => setRestoreRevision((r) => r + 1)}>Reconnect</button>
      </main>
    );
  if (!session) return <Login onLogin={accept} expired={expired} />;
  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand">Credit Copilot</div>
        <p className="muted">Lending workspace</p>
        <nav aria-label="Workspace">
          {pages
            .filter((p) => p !== 'Review queue' || session.user.role === 'credit_officer')
            .map((p) => (
              <button
                key={p}
                aria-current={page === p ? 'page' : undefined}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            ))}
        </nav>
        <ModelSwitcher key={session.user.id} actor={session.user} />
        <div className="identity">
          <strong>{session.user.username}</strong>
          <small>
            {session.user.role.replaceAll('_', ' ')} · {session.user.tier}
          </small>
          <button disabled={logoutBusy} onClick={() => void logout()}>
            {logoutBusy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </aside>
      <main className="content">
        <ErrorNotice error={error} />
        {page === 'Applications' && <Applications actor={session.user} />}{' '}
        {page === 'Delta Copilot' && <Questions />}
        {page === 'Affordability calculator' && <Affordability />}
        {page === 'Policy library' && <Knowledge actor={session.user} />}{' '}
        {page === 'Usage' && <Usage />}
        {page === 'Review queue' && <Reviews actor={session.user} />}
      </main>
    </div>
  );
}
