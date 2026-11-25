import { useState } from 'react';
import type { GenerationMode, LlmProviderStatus } from '../../../packages/contracts/src/llm';
import { api } from './api';
import type { Actor } from './types';
import { useResource } from './components';

const MODE_LABELS: Record<GenerationMode, string> = {
  gemini: 'Gemini',
  auto: 'Auto',
  ollama: 'Ollama',
};

export function ModelSwitcher({ actor }: { actor: Actor }) {
  const resource = useResource(
    (signal) => api.request<LlmProviderStatus>('llm/status', { signal }),
    [actor.id],
  );
  const [override, setOverride] = useState<LlmProviderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = override ?? resource.data;

  async function apply(mode: GenerationMode, ollamaModel?: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.request<LlmProviderStatus>('llm/provider', {
        body: { mode, ...(ollamaModel ? { ollamaModel } : {}) },
      });
      setOverride(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch model provider.');
    } finally {
      setBusy(false);
    }
  }

  function refresh() {
    setOverride(null);
    setError(null);
    resource.refresh();
  }

  if (!status) return null;

  const canSelectOllama = status.ollamaReachable && status.ollamaModels.length > 0;
  const modeSummary =
    status.mode === 'auto'
      ? `Auto · ${status.geminiModel} → ${status.ollamaModel}`
      : status.activeModel;

  return (
    <section className="model-switcher" aria-label="Model provider">
      <div className="model-switcher-head">
        <span className="model-switcher-title">Model</span>
        <span
          className={`model-dot ${status.ollamaReachable ? 'dot-online' : 'dot-offline'}`}
          title={
            status.ollamaReachable
              ? `Ollama online (${status.ollamaModels.length} local model(s))`
              : 'Ollama offline'
          }
        >
          {status.ollamaReachable ? 'Ollama ready' : 'Ollama off'}
        </span>
        {status.canManage && (
          <button
            type="button"
            className="model-refresh"
            aria-label="Refresh model status"
            title="Refresh Ollama status"
            disabled={busy}
            onClick={refresh}
          >
            ↻
          </button>
        )}
      </div>

      {status.canManage ? (
        <>
          <div className="model-modes" role="group" aria-label="LLM provider mode">
            {(['gemini', 'auto', 'ollama'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={status.mode === mode ? 'primary' : ''}
                aria-pressed={status.mode === mode}
                disabled={busy || (mode === 'ollama' && !canSelectOllama)}
                title={
                  mode === 'ollama' && !canSelectOllama
                    ? 'Start local Ollama with a pulled model to enable'
                    : undefined
                }
                onClick={() => void apply(mode)}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          {status.mode !== 'gemini' && status.ollamaModels.length > 0 && (
            <label className="model-select-label">
              <span>Local model</span>
              <select
                aria-label="Local Ollama model"
                value={status.ollamaModel}
                disabled={busy}
                onChange={(event) => void apply(status.mode, event.target.value)}
              >
                {status.ollamaModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          )}
          <small className="model-active">{modeSummary}</small>
          {!status.ollamaReachable && (
            <small className="model-hint">
              Start Ollama: <code>docker compose --profile local-llm up -d ollama</code>
            </small>
          )}
          {error && (
            <small className="model-error" role="alert">
              {error}
            </small>
          )}
        </>
      ) : (
        <small className="model-active" data-testid="model-readonly">
          {MODE_LABELS[status.mode]} · {status.activeModel}
        </small>
      )}
    </section>
  );
}
