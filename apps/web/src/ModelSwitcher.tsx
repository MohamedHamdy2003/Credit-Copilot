import type { GenerationMode, LlmProviderStatus } from '../../../packages/contracts/src/llm';

const MODE_LABELS: Record<GenerationMode, string> = {
  gemini: 'Gemini',
  auto: 'Auto',
  ollama: 'Ollama',
};

export interface ModelSwitcherProps {
  status: LlmProviderStatus;
  busy: boolean;
  error: string | null;
  onSwitch: (mode: GenerationMode, ollamaModel?: string) => void;
  onRefresh: () => void;
}

export function ModelSwitcher({ status, busy, error, onSwitch, onRefresh }: ModelSwitcherProps) {
  const canSelectOllama = status.ollamaReachable && status.ollamaModels.length > 0;
  const badge =
    status.mode === 'gemini'
      ? {
          label: 'Gemini active',
          online: true,
          title: `Active cloud model: ${status.geminiModel}`,
        }
      : status.mode === 'ollama'
        ? {
            label: 'Ollama local',
            online: canSelectOllama,
            title: `Active local model: ${status.ollamaModel}`,
          }
        : canSelectOllama
          ? {
              label: 'Auto · Gemini + Ollama',
              online: true,
              title: `Primary ${status.geminiModel} with local fallback ${status.ollamaModel}`,
            }
          : {
              label: 'Auto · Gemini only',
              online: false,
              title: 'Local Ollama offline; requests stay on Gemini',
            };

  const readonlySummary =
    status.mode === 'auto' ? `${status.geminiModel} → ${status.ollamaModel}` : status.activeModel;

  return (
    <section className="llm-toggle-bar" aria-label="Active LLM provider">
      {status.canManage ? (
        <>
          <div className="llm-toggle-row">
            <span
              className={`llm-status-pill ${badge.online ? 'is-online' : 'is-muted'}`}
              title={badge.title}
              data-testid="llm-status-badge"
            >
              {badge.label}
            </span>
            <div className="llm-toggle-group" role="group" aria-label="LLM provider mode">
              {(['gemini', 'auto', 'ollama'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={status.mode === mode ? 'active' : ''}
                  aria-pressed={status.mode === mode}
                  disabled={busy || (mode === 'ollama' && !canSelectOllama)}
                  title={
                    mode === 'ollama' && !canSelectOllama
                      ? 'Start local Ollama with a pulled model to enable'
                      : undefined
                  }
                  onClick={() => onSwitch(mode)}
                >
                  {MODE_LABELS[mode]}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="llm-refresh-btn"
              aria-label="Refresh model status"
              title="Refresh Ollama status"
              disabled={busy}
              onClick={onRefresh}
            >
              ↻
            </button>
          </div>
          {status.mode !== 'gemini' && status.ollamaModels.length > 0 && (
            <div className="llm-toggle-meta">
              <label className="llm-model-select">
                <span>Local model</span>
                <select
                  aria-label="Local Ollama model"
                  value={status.ollamaModel}
                  disabled={busy}
                  onChange={(event) => onSwitch(status.mode, event.target.value)}
                >
                  {status.ollamaModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {!status.ollamaReachable && (
            <small className="llm-toggle-hint">
              Ollama offline · <code>docker compose --profile local-llm up -d ollama</code>
            </small>
          )}
          {error && (
            <small className="llm-toggle-error" role="alert">
              {error}
            </small>
          )}
        </>
      ) : (
        <div className="llm-toggle-readonly" data-testid="model-readonly">
          <span
            className={`llm-status-pill ${badge.online ? 'is-online' : 'is-muted'}`}
            title={badge.title}
          >
            {badge.label}
          </span>
          <small className="break">{readonlySummary}</small>
        </div>
      )}
    </section>
  );
}
