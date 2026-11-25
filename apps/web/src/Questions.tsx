import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { questionStreamEvent, QUESTION_REFUSAL } from '../../../packages/contracts/src/streams';
import type { ProductId } from '../../../packages/contracts/src/products';
import { api, ApiError } from './api';
import type { Answer, Citation } from './types';
import { ErrorNotice } from './components';

interface ChatTurn {
  id: string;
  question: string;
  product: ProductId;
  scope: string;
  answer?: Answer;
  error?: unknown;
  pending: boolean;
}

const PRODUCTS: { id: ProductId; label: string }[] = [
  { id: 'PL-100', label: 'Personal loan (PL-100)' },
  { id: 'AL-200', label: 'Auto loan (AL-200)' },
];

const SUGGESTIONS: Record<ProductId, string[]> = {
  'PL-100': [
    'What is the maximum DBR under CP-2025?',
    'What is the minimum income for PL-100 under CP-2025?',
    'What happens when a bureau score is below 600?',
  ],
  'AL-200': [
    'What is the minimum down payment for the vehicle loan?',
    'What is the maximum loan amount and tenor for AL-200?',
    'What documents are required for an auto loan application?',
  ],
};

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
  const [product, setProduct] = useState<ProductId>('PL-100');
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
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
  }, [draft]);
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
    const mentionedDate = question.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    const mentionedEdition = question
      .match(/\b(?:CP-20(?:24|25)|AUTO-2025)\b/i)?.[0]
      ?.toUpperCase();
    const referencedYears = [...new Set(question.match(/\b20\d{2}\b/g) ?? [])];
    const scope =
      mentionedDate ||
      mentionedEdition ||
      (referencedYears.length ? `Year ${referencedYears.join(', ')}` : 'Active policies today');
    const body = {
      question,
      product,
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
          'Policy question service is unavailable. Please retry.',
        );
      }
      if (terminal.kind === 'completed') {
        updateTurn((turn) => ({
          ...turn,
          pending: false,
          answer: {
            answer: terminal.answer,
            refused: terminal.refused,
            asOfDate: terminal.asOfDate,
            resolution: terminal.resolution,
            citations: terminal.refused ? [] : (turn.answer?.citations ?? []),
          },
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
      <header className="page-heading copilot-heading">
        <div>
          <h1>Delta Copilot</h1>
          <p>A Grounded RAG Assistant for Personal Loan Underwriting</p>
        </div>
        <div className="copilot-controls">
          <div
            className="llm-toggle-group copilot-product-toggle"
            role="group"
            aria-label="Product"
          >
            {PRODUCTS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={product === item.id ? 'active' : ''}
                aria-pressed={product === item.id}
                disabled={busy}
                onClick={() => setProduct(item.id)}
              >
                {item.label}
              </button>
            ))}
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
      </header>

      <section className="panel policy-chat" aria-label="Delta Copilot chat">
        <div
          className="chat-history"
          ref={transcript}
          aria-live="polite"
          aria-relevant="additions text"
        >
          {!turns.length ? (
            <div className="chat-empty">
              <span className="chat-mark" aria-hidden="true">
                DC
              </span>
              <h3>Start with a policy question</h3>
              <p>
                Ask about current policies or mention an edition or date (e.g. CP-2024) for
                historical rules. Every answer includes verified source citations.
              </p>
              <div className="suggestions" aria-label="Suggested questions">
                {SUGGESTIONS[product].map((question) => (
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
          <p className="chat-privacy muted">
            Ask policy questions only. Do not enter applicant names, IDs, phone numbers, or other
            personal data.
          </p>
        </form>
      </section>
    </>
  );
}
