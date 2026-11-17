import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [status, setStatus] = useState('Connecting…');
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/v1/health', { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Unavailable');
        return response.json();
      })
      .then(() => setStatus('API connected'))
      .catch(() => {
        if (!abort.signal.aborted) setStatus('API unavailable');
      });
    return () => abort.abort();
  }, []);
  return (
    <main>
      <h1>Credit Copilot</h1>
      <p>Synthetic personal-loan underwriting workspace.</p>
      <p role="status">{status}</p>
      <p>Foundation milestone. Assessment workflows are under implementation.</p>
      <a href="/api/docs">REST API documentation</a>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
