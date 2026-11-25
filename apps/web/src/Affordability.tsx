import { useState, type FormEvent } from 'react';
import { api } from './api';
import { ErrorNotice, Money } from './components';

interface Calculation {
  policyEdition: string;
  annualRatePercent: string;
  maxDbr: string;
  note: string;
  citations: { sourceFile: string; section?: string; row?: number }[];
  calculation: { monthlyInstallment: string; dbrPercent: string; maximumEligibleAmount: string };
}

function sourceHref(sourceFile: string) {
  return `/api/v1/knowledge/source?filename=${encodeURIComponent(sourceFile)}`;
}

function todayCairo() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
}

export function Affordability() {
  const [calculation, setCalculation] = useState<Calculation>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  async function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
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
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Affordability calculator</h1>
          <p>
            Compute exact monthly instalments, DBR, and eligible limits from dated policy rules.
          </p>
        </div>
      </header>

      <section className="panel calculator-panel">
        <div className="chat-heading">
          <div>
            <h2>Personal-loan affordability</h2>
            <p className="muted">
              Enter verified figures. Policy limits and pricing are selected automatically by date.
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
              <input name="date" type="date" defaultValue={todayCairo()} required />
            </label>
            <label className="check check-card">
              <input type="checkbox" name="payroll" />
              <span className="check-copy">
                <strong>Salary transferred to bank</strong>
                <small>Applies the 2% lower payroll-transfer rate from pricing</small>
              </span>
            </label>
          </div>
          <button className="primary" disabled={busy}>
            {busy ? 'Calculating…' : 'Calculate affordability'}
          </button>
        </form>

        {!!error && <ErrorNotice error={error} />}
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
    </>
  );
}
