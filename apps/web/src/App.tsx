import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import type { Session } from './types';
import { ErrorNotice } from './components';
import { Applications } from './Applications';
import { Questions } from './Questions';
import { Affordability } from './Affordability';
import { Knowledge } from './Knowledge';
import { Reviews } from './Reviews';
import { Usage } from './Usage';
const pages = [
  'Applications',
  'Delta Copilot',
  'Affordability calculator',
  'Policy library',
  'LLM Usage',
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
    [restoreRevision, setRestoreRevision] = useState(0),
    [fullscreen, setFullscreen] = useState(false),
    [nativeFullscreen, setNativeFullscreen] = useState(false),
    [showExitButton, setShowExitButton] = useState(false);
  const exitHideTimer = useRef<number | null>(null);

  const exitFullscreen = useCallback(async () => {
    setShowExitButton(false);
    setFullscreen(false);
    setNativeFullscreen(false);
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore if browser already exited fullscreen.
      }
    }
  }, []);

  async function enterFullscreen() {
    setFullscreen(true);
    setShowExitButton(false);
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
        setNativeFullscreen(Boolean(document.fullscreenElement));
      } catch {
        setNativeFullscreen(false);
      }
    }
  }

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setNativeFullscreen(active);
      if (!active) {
        setFullscreen(false);
        setShowExitButton(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!fullscreen || nativeFullscreen) return;
    const clearHide = () => {
      if (exitHideTimer.current !== null) {
        window.clearTimeout(exitHideTimer.current);
        exitHideTimer.current = null;
      }
    };
    const onMouseMove = (event: MouseEvent) => {
      if (event.clientY <= 36) {
        clearHide();
        setShowExitButton(true);
      } else if (event.clientY > 92 && exitHideTimer.current === null) {
        exitHideTimer.current = window.setTimeout(() => {
          setShowExitButton(false);
          exitHideTimer.current = null;
        }, 260);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void exitFullscreen();
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearHide();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [fullscreen, nativeFullscreen, exitFullscreen]);
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
    <div className={`workspace${fullscreen ? ' is-fullscreen' : ''}`}>
      {fullscreen && !nativeFullscreen && (
        <button
          type="button"
          className={`fullscreen-exit${showExitButton ? ' is-visible' : ''}`}
          aria-label="Exit full screen"
          title="Exit full screen (Esc)"
          onMouseEnter={() => setShowExitButton(true)}
          onClick={() => void exitFullscreen()}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path
              d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
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
        <div className="identity">
          <span className="identity-role">
            {session.user.role.replaceAll('_', ' ')} · {session.user.tier}
          </span>
          <button className="signout-button" disabled={logoutBusy} onClick={() => void logout()}>
            {logoutBusy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </aside>
      <main className="content">
        {!fullscreen && (
          <div className="workspace-utilities">
            <button
              type="button"
              className="fullscreen-trigger"
              aria-label="Enter full screen"
              title="Full screen"
              onClick={() => void enterFullscreen()}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M2.5 6V3.5C2.5 2.95 2.95 2.5 3.5 2.5H6M10 2.5H12.5C13.05 2.5 13.5 2.95 13.5 3.5V6M13.5 10V12.5C13.5 13.05 13.05 13.5 12.5 13.5H10M6 13.5H3.5C2.95 13.5 2.5 13.05 2.5 12.5V10"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}
        <ErrorNotice error={error} />
        {page === 'Applications' && <Applications actor={session.user} />}{' '}
        {page === 'Delta Copilot' && <Questions />}
        {page === 'Affordability calculator' && <Affordability />}
        {page === 'Policy library' && <Knowledge actor={session.user} />}{' '}
        {page === 'LLM Usage' && <Usage actor={session.user} />}
        {page === 'Review queue' && <Reviews actor={session.user} />}
      </main>
    </div>
  );
}
