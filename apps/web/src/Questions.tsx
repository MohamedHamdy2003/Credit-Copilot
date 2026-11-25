import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { questionStreamEvent, QUESTION_REFUSAL } from '../../../packages/contracts/src/streams';
import type { ProductId } from '../../../packages/contracts/src/products';
import { api, ApiError } from './api';
import type { Answer, Citation } from './types';
import { ErrorNotice, Money } from './components';

interface Calculation {
  policyEdition: string;
  annualRatePercent: string;
  maxDbr: string;
  note: string;
  citations: { sourceFile: string; section?: string; row?: number }[];
  calculation: { monthlyInstallment: string; dbrPercent: string; maximumEligibleAmount: string };
}

interface ChatTurn {
  id: string;
  question: string;
  product: ProductId;
  scope: string;
  answer?: Answer;
  error?: unknown;
  pending: boolean;
}

type Tool = 'chat' | 'calculation';

function sourceHref(sourceFile: string, page?: number | null) {
  const pageAnchor = page ? `#page=${page}` : '';
  return `/api/v1/knowledge/source?filename=${encodeURIComponent(sourceFile)}${pageAnchor}`;
}

function productName(product: ProductId) {
  return product === 'PL-100' ? 'Personal loan · PL-100' : 'Auto loan · AL-200';
}

function sourceLocation(citation: Citation) {
  const location = citation.section ?? (citation.row ? `Row ${citation.row}` : 'Source');
  const pages = citation.pageStart
    ? ` · p. ${citation.pageStart}${citation.pageEnd && citation.pageEnd !== citation.pageStart ? `–${citation.pageEnd}` : ''}`
    : '';
  const row = citation.row ? ` · row ${citation.row}` : '';
  return `${location}${pages}${row}`;
}

export function Questions() {
  const [tool, setTool] = useState<Tool>('chat');
  const [product, setProduct] = useState<ProductId>('PL-100');
  const [asOfDate, setAsOfDate] = useState('');
  const [edition, setEdition] = useState('');
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [calculation, setCalculation] = useState<Calculation>();
  const [calcError, setCalcError] = useState<unknown>();
  const [calcBusy, setCalcBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const retry = useRef<{ key: string; body: string } | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft, tool]);
  useEffect(() => {
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns]);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || request.current) return;

    const controller = new AbortController();
    const turnId = crypto.randomUUID();
    const context = turns
      .filter((turn) => !turn.error && turn.answer && !turn.answer.refused)
      .slice(-3)
      .map((turn) => turn.question);
    const referencedYears = [...new Set(question.match(/\b20\d{2}\b/g) ?? [])];
    const scope =
      edition ||
      asOfDate ||
      (referencedYears.length ? `Year ${referencedYears.join(', ')}` : 'Current policy date');
    const body = {
      question,
      product,
      ...(asOfDate ? { asOfDate } : {}),
      ...(edition ? { edition } : {}),
      ...(context.length ? { context } : {}),
    };
    const signature = JSON.stringify(body);
    if (retry.current?.body !== signature)
      retry.current = { body: signature, key: crypto.randomUUID() };

    request.current = controller;
    setBusy(true);
    setReconnecting(false);
    setDraft('');
    setTurns((previous) => [...previous, { id: turnId, question, product, scope, pending: true }]);

    const updateTurn = (update: (turn: ChatTurn) => ChatTurn) =>
      setTurns((previous) => previous.map((turn) => (turn.id === turnId ? update(turn) : turn)));

    try {
      const { streamId } = await api.request<{ streamId: string }>('questions/streams', {
        body,
        key: retry.current.key,
        signal: controller.signal,
      });
      const terminal = await api.follow(`question-streams/${streamId}`, questionStreamEvent, {
        signal: controller.signal,
        onReconnect: setReconnecting,
        onEvent: (update) => {
          if (update.kind !== 'citation') return;
          updateTurn((turn) => ({
            ...turn,
            answer: {
              answer: turn.answer?.answer ?? '',
              refused: false,
              asOfDate: update.asOfDate,
              citations: [...(turn.answer?.citations ?? []), update.citation],
            },
          }));
        },
      });
      retry.current = null;
      if (terminal.kind === 'failed') {
        throw new ApiError(
          503,
          terminal.code,
          'Policy question service is unavailable. Try again.',
        );
      }
      if (terminal.kind === 'completed') {
        updateTurn((turn) => ({
          ...turn,
          answer: {
            answer: terminal.answer,
            refused: terminal.refused,
            asOfDate: terminal.asOfDate,
            citations: turn.answer?.citations ?? [],
            ...(terminal.resolution ? { resolution: terminal.resolution } : {}),
          },
          pending: false,
          error: undefined,
        }));
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status > 0 && error.status < 500) retry.current = null;
      updateTurn((turn) => ({ ...turn, pending: false, error }));
    } finally {
      request.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        setReconnecting(false);
      }
    }
  }

  async function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCalcBusy(true);
    setCalcError(undefined);
    setCalculation(undefined);
    const data = new FormData(event.currentTarget);
    try {
      setCalculation(
        await api.request('calculations', {
          body: {
            principal: data.get('principal'),
            income: data.get('income'),
            obligations: data.get('obligations'),
            months: Number(data.get('months')),
            date: data.get('date'),
            payroll: data.get('payroll') === 'on',
          },
        }),
      );
    } catch (error) {
      setCalcError(error);
    } finally {
      setCalcBusy(false);
    }
  }

  function handleQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function clearConversation() {
    if (busy) return;
    retry.current = null;
    setTurns([]);
    setDraft('');
  }

  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Policy questions</h1>
          <p>Ask about policy evidence or calculate affordability from verified inputs.</p>
        </div>
      </header>

      <div className="tabs question-tools" role="group" aria-label="Choose a credit tool">
        <button type="button" aria-pressed={tool === 'chat'} onClick={() => setTool('chat')}>
          Ask a policy question
        </button>
        <button
          type="button"
          aria-pressed={tool === 'calculation'}
          onClick={() => setTool('calculation')}
        >
          Affordability calculator
        </button>
      </div>

      {tool === 'chat' ? (
        <section className="panel policy-chat" aria-label="Policy question chat">
          <div className="chat-heading">
            <div>
              <h2>Ask a policy question</h2>
              <p className="muted">
                Answers use the selected product and date. Recent questions help resolve follow-ups.
              </p>
            </div>
            <button
              type="button"
              className="quiet-button"
              onClick={clearConversation}
              disabled={!turns.length || busy}
            >
              New chat
            </button>
          </div>

          <div className="scope-grid">
            <label>
              Product
              <select
                value={product}
                disabled={busy}
                onChange={(event) => {
                  setProduct(event.target.value as ProductId);
                  setAsOfDate('');
                  setEdition('');
                }}
              >
                <option value="PL-100">Personal loan (PL-100)</option>
                <option value="AL-200">Auto loan (AL-200)</option>
              </select>
            </label>
            <label>
              As-of date
              <input
                type="date"
                value={asOfDate}
                disabled={busy || !!edition}
                onChange={(event) => {
                  setAsOfDate(event.target.value);
                  if (event.target.value) setEdition('');
                }}
              />
            </label>
            <label>
              Policy edition
              <select
                value={edition}
                disabled={busy || !!asOfDate}
                onChange={(event) => {
                  setEdition(event.target.value);
                  if (event.target.value) setAsOfDate('');
                }}
              >
                <option value="">Use the current policy date</option>
                {product === 'PL-100' ? (
                  <>
                    <option value="CP-2024">CP-2024</option>
                    <option value="CP-2025">CP-2025</option>
                  </>
                ) : (
                  <option value="AUTO-2025">AUTO-2025</option>
                )}
              </select>
            </label>
          </div>

          <p className="chat-privacy muted">
            Ask policy questions only. Do not enter applicant names, IDs, phone numbers or other
            personal data. Up to three recent questions may be sent as follow-up context.
          </p>

          <div
            className="chat-history"
            ref={transcript}
            aria-live="polite"
            aria-relevant="additions text"
          >
            {!turns.length ? (
              <div className="chat-empty">
                <span className="chat-mark" aria-hidden="true">
                  CC
                </span>
                <h3>Start with a policy question</h3>
                <p>
                  Choose the product and policy scope above. Your answer will include verified
                  sources.
                </p>
                <div className="suggestions" aria-label="Suggested questions">
                  {[
                    'What is the maximum DBR under CP-2025?',
                    'What is the minimum income for PL-100 under CP-2025?',
                    'What happens when a bureau score is below 600?',
                  ].map((question) => (
                    <button key={question} type="button" onClick={() => setDraft(question)}>
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((turn) => (
                <article className="chat-turn" key={turn.id}>
                  <div className="user-message">
                    <p>{turn.question}</p>
                    <small>
                      {productName(turn.product)} · {turn.scope}
                    </small>
                  </div>
                  <div className={`assistant-message${turn.answer?.refused ? ' refused' : ''}`}>
                    <div className="message-title">
                      <strong>{turn.answer?.refused ? 'Insufficient evidence' : 'Answer'}</strong>
                      {turn.answer && <span>As of {turn.answer.asOfDate}</span>}
                    </div>
                    {turn.pending && (
                      <p className="chat-status" role="status">
                        {reconnecting
                          ? 'Reconnecting to the same question…'
                          : 'Retrieving and checking policy evidence…'}
                      </p>
                    )}
                    {turn.answer && (turn.answer.answer || turn.answer.resolution) && (
                      <div className="answer-copy">
                        <p>{turn.answer.resolution ?? turn.answer.answer ?? QUESTION_REFUSAL}</p>
                      </div>
                    )}
                    {!!turn.error && <ErrorNotice error={turn.error} />}
                    {!!turn.error && (
                      <button type="button" onClick={() => setDraft(turn.question)}>
                        Try this question again
                      </button>
                    )}
                    {!!turn.answer?.citations.length && (
                      <section className="citation-list" aria-label="Citations">
                        <h3>Citations</h3>
                        {turn.answer.citations.map((citation, index) => (
                          <article
                            className="citation-card"
                            key={
                              citation.chunkId ??
                              `${citation.sourceFile}-${citation.section}-${index}`
                            }
                          >
                            <div className="citation-details">
                              <a
                                href={sourceHref(citation.sourceFile, citation.pageStart)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {citation.sourceFile}
                              </a>
                              <span>
                                {citation.edition ?? 'Source'} · {sourceLocation(citation)}
                              </span>
                              <small>
                                Effective {citation.effectiveFrom ?? 'date not specified'}
                                {citation.effectiveTo ? ` · Ends ${citation.effectiveTo}` : ''}
                              </small>
                            </div>
                            {citation.quote && (
                              <details>
                                <summary>View verified excerpt</summary>
                                <blockquote>{citation.quote}</blockquote>
                              </details>
                            )}
                          </article>
                        ))}
                      </section>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>

          <form className="chat-composer" onSubmit={ask}>
            <label htmlFor="policy-question" className="sr-only">
              Your question
            </label>
            <div className="composer-box">
              <textarea
                ref={inputRef}
                id="policy-question"
                name="question"
                rows={1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleQuestionKeyDown}
                required
                maxLength={2000}
                disabled={busy}
                placeholder="Ask about a policy, threshold or procedure…"
              />
              <button className="primary" type="submit" disabled={busy || !draft.trim()}>
                {busy ? 'Searching…' : 'Send question'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <section className="panel calculator-panel">
          <div className="chat-heading">
            <div>
              <h2>Personal-loan affordability</h2>
              <p className="muted">
                Enter verified figures. Policy limits and pricing are selected by date.
              </p>
            </div>
          </div>
          <form onSubmit={calculate}>
            <div className="form-grid">
              {[
                ['principal', 'Requested amount (EGP)'],
                ['income', 'Net monthly income (EGP)'],
                ['obligations', 'Monthly obligations (EGP)'],
              ].map(([name, label]) => (
                <label key={name}>
                  {label}
                  <input name={name} inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" required />
                </label>
              ))}
              <label>
                Tenor (months)
                <input name="months" type="number" min="12" max="60" required />
              </label>
              <label>
                Calculation date
                <input name="date" type="date" required />
              </label>
              <label className="check">
                <input type="checkbox" name="payroll" />
                Salary transferred to bank
              </label>
            </div>
            <button className="primary" disabled={calcBusy}>
              {calcBusy ? 'Calculating…' : 'Calculate affordability'}
            </button>
          </form>

          {!!calcError && <ErrorNotice error={calcError} />}
          {calculation && (
            <div className="calculation-output" aria-live="polite">
              <section className="calculation-result">
                <div className="message-title">
                  <h3>Calculation result</h3>
                  <span>
                    {calculation.policyEdition} · Annual rate {calculation.annualRatePercent}%
                  </span>
                </div>
                <dl className="metrics">
                  <div>
                    <dt>Monthly instalment</dt>
                    <dd>
                      <Money value={calculation.calculation.monthlyInstallment} />
                    </dd>
                  </div>
                  <div>
                    <dt>DBR</dt>
                    <dd>{calculation.calculation.dbrPercent}%</dd>
                  </div>
                  <div>
                    <dt>Maximum eligible</dt>
                    <dd>
                      <Money value={calculation.calculation.maximumEligibleAmount} />
                    </dd>
                  </div>
                </dl>
                <p className="calculation-note">{calculation.note}</p>
              </section>
              <section className="calculation-sources" aria-label="Calculation citations">
                <h3>Citations used</h3>
                <ul>
                  {calculation.citations.map((citation, index) => (
                    <li key={`${citation.sourceFile}-${citation.section}-${citation.row}-${index}`}>
                      <a
                        href={sourceHref(citation.sourceFile)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {citation.sourceFile}
                      </a>
                      <span>{citation.section ?? `Row ${citation.row}`}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}
        </section>
      )}
    </>
  );
}
