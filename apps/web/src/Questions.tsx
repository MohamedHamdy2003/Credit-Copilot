import { useState, type FormEvent } from 'react';
import { api } from './api';
import type { Answer } from './types';
import { ErrorNotice, Money } from './components';
interface Calculation {
  policyEdition: string;
  annualRatePercent: string;
  maxDbr: string;
  note: string;
  citations: { sourceFile: string; section?: string; row?: number }[];
  calculation: { monthlyInstallment: string; dbrPercent: string; maximumEligibleAmount: string };
}
export function Questions() {
  const [answer, setAnswer] = useState<Answer>(),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [calculation, setCalculation] = useState<Calculation>(),
    [calcError, setCalcError] = useState<unknown>(),
    [calcBusy, setCalcBusy] = useState(false);
  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setAnswer(undefined);
    const data = new FormData(event.currentTarget);
    try {
      setAnswer(
        await api.request('questions', {
          body: {
            question: data.get('question'),
            ...(data.get('date') ? { asOfDate: data.get('date') } : {}),
            ...(data.get('edition') ? { edition: data.get('edition') } : {}),
          },
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
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
    } catch (e) {
      setCalcError(e);
    } finally {
      setCalcBusy(false);
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Policy questions</h1>
          <p>Answers supported by the documents.</p>
        </div>
      </header>
      <section className="panel">
        <h2>Ask a policy question</h2>
        <p>Use policy questions only; do not enter customer identifiers or personal information.</p>
        <form onSubmit={ask}>
          <label>
            Question
            <textarea
              name="question"
              required
              maxLength={2000}
              placeholder="What is the maximum DBR in CP-2025?"
            />
          </label>
          <div className="form-grid">
            <label>
              As-of date (optional)
              <input type="date" name="date" />
            </label>
            <label>
              Policy edition
              <select name="edition">
                <option value="">Resolve from question / date</option>
                <option>CP-2024</option>
                <option>CP-2025</option>
              </select>
            </label>
          </div>
          <p className="muted">
            Uses a date or edition in your question, otherwise today's Cairo date. Conflicting
            selectors are rejected.
          </p>
          <button className="primary" disabled={busy}>
            {busy ? 'Finding evidence…' : 'Ask question'}
          </button>
        </form>
        <ErrorNotice error={error} />
        {answer && (
          <section aria-live="polite" className="answer">
            <h3>{answer.refused ? 'Insufficient evidence' : 'Verified source excerpts'}</h3>
            <p className="muted">As of {answer.asOfDate}</p>
            {answer.refused ? (
              <p>{answer.answer}</p>
            ) : (
              answer.citations.map((c, i) => (
                <article className="source" key={c.chunkId ?? i}>
                  <blockquote>{c.quote}</blockquote>
                  <p>
                    <strong>{c.sourceFile}</strong> · {c.edition} · {c.section}
                    {c.pageStart
                      ? ` · p.${c.pageStart}${c.pageEnd && c.pageEnd !== c.pageStart ? `–${c.pageEnd}` : ''}`
                      : ''}
                    {c.row ? ` · row ${c.row}` : ''}
                  </p>
                  <small>
                    Effective {c.effectiveFrom ?? 'not specified'}
                    {c.effectiveTo ? ` to ${c.effectiveTo} (exclusive)` : ''}
                  </small>
                </article>
              ))
            )}
          </section>
        )}
      </section>
      <section className="panel">
        <h2>Affordability calculation</h2>
        <p>Figures are calculated by code using the selected policy and pricing table.</p>
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
          <button disabled={calcBusy}>
            {calcBusy ? 'Calculating…' : 'Calculate affordability'}
          </button>
        </form>
        <ErrorNotice error={calcError} />
        {calculation && (
          <div className="answer" aria-live="polite">
            <p>
              {calculation.policyEdition} · Annual rate {calculation.annualRatePercent}%
            </p>
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
            <p>{calculation.note}</p>
            <ul>
              {calculation.citations.map((c, i) => (
                <li key={i}>
                  {c.sourceFile} · {c.section ?? `row ${c.row}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </>
  );
}
