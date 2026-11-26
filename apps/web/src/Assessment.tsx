import { useState, type FormEvent } from 'react';
import { api } from './api';
import type { Actor, Offer, Run } from './types';
import { Empty, ErrorNotice, Money, Status } from './components';
import { WrittenReasonPanel, ReferralReviewPanel } from './CaseReview';
import { AssessmentPipeline } from './AssessmentPipeline';
import { CreditMemoCard } from './CreditMemo';
import type { AssessmentStage } from '../../../packages/contracts/src/streams';

function DecisionForm({
  run,
  actor,
  onChanged,
}: {
  run: Run;
  actor: Actor;
  onChanged: () => void;
}) {
  const owner = actor.id === run.preparer_id;
  const customer = owner && run.status === 'pending_customer_acceptance';
  const reviewer = actor.role === 'credit_officer' && !owner;
  const senior = ['senior', 'head'].includes(actor.tier);
  const blockedReferral = run.result.fraudReferral || run.result.evidence.missing.length > 0;
  const reviewableReferral =
    run.result.recommendation === 'REFER_TO_HUMAN' &&
    !blockedReferral &&
    Boolean(run.result.extraction) &&
    !run.result.results?.some((r) => r.result === 'fail');
  const actions = customer
    ? ['customer_response']
    : reviewer && run.status === 'approved'
      ? ['issue']
      : reviewer && ['pending_review', 'pending_approval'].includes(run.status)
        ? blockedReferral
          ? []
          : run.result.recommendation === 'REFER_TO_HUMAN'
            ? senior && reviewableReferral
              ? ['approve', 'reject']
              : []
            : run.result.recommendation === 'DECLINE'
              ? ['reject']
              : ['approve', 'reject']
        : [];
  const [action, setAction] = useState(actions[0] ?? 'approve'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    const body = {
      action,
      expectedVersion: run.version,
      comment: String(form.get('comment')),
      ...(action === 'reject' ? { clause: String(form.get('clause')) } : {}),
      ...(action === 'issue' ? { disbursementDate: String(form.get('date')) } : {}),
      ...(action === 'customer_response' ? { accepted: form.get('accepted') === 'yes' } : {}),
    };
    try {
      await api.request(`assessments/${run.id}/decisions`, { body });
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  if (!actions.length) return null;
  return (
    <section className="panel">
      <h2>{customer ? 'Customer response' : 'Human decision'}</h2>
      <p>
        Authority and evidence are checked by the server. An unresolved referral cannot be approved.
      </p>
      <ErrorNotice error={error} />
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>
            Action
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setError(undefined);
              }}
            >
              {actions.map((a) => (
                <option key={a} value={a}>
                  {a === 'customer_response'
                    ? 'Record customer response'
                    : a === 'issue'
                      ? 'Issue approved offer'
                      : a === 'approve'
                        ? 'Approve'
                        : 'Reject'}
                </option>
              ))}
            </select>
          </label>
          {action === 'reject' && (
            <label>
              Policy clause
              <input
                name="clause"
                required
                placeholder="e.g. CP-8"
                pattern="(CP|PS|PM)-[0-9]+(\.[0-9]+)?"
              />
            </label>
          )}
          {action === 'issue' && (
            <label>
              Disbursement date
              <input name="date" type="date" required />
            </label>
          )}
          {customer && (
            <label>
              Customer response
              <select name="accepted">
                <option value="yes">Accepted alternative</option>
                <option value="no">Declined alternative</option>
              </select>
            </label>
          )}
        </div>
        <label>
          Written justification
          <textarea name="comment" required minLength={1} maxLength={2000} />
        </label>
        <label className="check">
          <input type="checkbox" required />I reviewed the evidence, policy and{' '}
          {run.result.mode === 'demo' ? 'Demo assumptions' : 'recommendation'} before recording this
          decision.
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>
            {busy ? 'Recording…' : 'Record decision'}
          </button>
          <button type="button" disabled={busy} onClick={onChanged}>
            Reload latest assessment
          </button>
        </div>
      </form>
    </section>
  );
}
export function Assessment({
  run,
  actor,
  onChanged,
}: {
  run: Run & { offer_id?: string | null };
  actor: Actor;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState('Summary'),
    [offer, setOffer] = useState<Offer>(),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  const result = run.result;
  async function loadOffer() {
    setBusy(true);
    setError(undefined);
    try {
      setOffer(await api.request<Offer>(`offers/${run.offer_id}`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {result.mode === 'demo' && (
        <div className="notice demo">
          <strong>Demo assessment — not fully evidence-verified.</strong>
          <p>ID-copy presence is assumed only. No ID document was fabricated or verified.</p>
          {result.evidence.assumptions.map((a, i) => (
            <p key={i}>
              {a.reason} · actual evidence: {a.actualEvidence} · verified: false
            </p>
          ))}
        </div>
      )}
      {result.fraudReferral && (
        <div className="notice error">
          Suspected tampering. Referred to the Fraud Unit; approval is blocked.
        </div>
      )}
      <section className="panel result">
        <div className="tabs" role="tablist" aria-label="Assessment details">
          {['Summary', 'Rules & sources', 'Workflow'].map((t) => (
            <button
              key={t}
              id={`tab-${t.replaceAll(' ', '-')}`}
              role="tab"
              aria-selected={tab === t}
              aria-controls="assessment-panel"
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <div
          className="tab-content"
          id="assessment-panel"
          role="tabpanel"
          aria-labelledby={`tab-${tab.replaceAll(' ', '-')}`}
        >
          {tab === 'Summary' && (
            <>
              <h2>{result.reference}</h2>
              <dl>
                <div>
                  <dt>Recommendation</dt>
                  <dd>
                    <Status value={result.recommendation} />
                  </dd>
                </div>
                <div>
                  <dt>Lifecycle</dt>
                  <dd>
                    <Status value={run.status} />
                  </dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd>{result.policyEdition ?? 'Unresolved'}</dd>
                </div>
                <div>
                  <dt>Recommended amount</dt>
                  <dd>
                    <Money value={result.recommendedAmount} />
                  </dd>
                </div>
                {result.approvalRequiredFrom && (
                  <div>
                    <dt>Required authority</dt>
                    <dd>{result.approvalRequiredFrom.replaceAll('_', ' ')}</dd>
                  </div>
                )}
                {result.autoFinance && (
                  <div>
                    <dt>Vehicle price less documented down payment</dt>
                    <dd>
                      <Money value={result.autoFinance.financedAmount} />
                    </dd>
                  </div>
                )}
              </dl>
              {result.reason && <p>{result.reason.replaceAll('_', ' ')}</p>}
              {result.evidence.missing.length > 0 && (
                <p>Missing evidence: {result.evidence.missing.join(', ').replaceAll('_', ' ')}</p>
              )}
              {result.calculation && (
                <dl className="metrics">
                  <div>
                    <dt>Monthly instalment</dt>
                    <dd>
                      <Money value={result.calculation.monthlyInstallment} />
                    </dd>
                  </div>
                  <div>
                    <dt>DBR</dt>
                    <dd>{result.calculation.dbrPercent}%</dd>
                  </div>
                  <div>
                    <dt>Maximum eligible</dt>
                    <dd>
                      <Money value={result.calculation.maximumEligibleAmount} />
                    </dd>
                  </div>
                </dl>
              )}
              <CreditMemoCard result={result} />
            </>
          )}
          {tab === 'Rules & sources' && (
            <>
              <h2>Source references</h2>
              <p>Policy: {result.policyEdition ?? 'Unresolved'}</p>
              {result.results?.map((r) => (
                <article className="rule" key={r.rule}>
                  <strong>{r.citation}</strong>
                  <Status value={r.result} />
                  <p>{r.reason}</p>
                </article>
              ))}
              <ul>
                {(result.citations ?? result.evidence.referral?.citations ?? []).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              {!!result.retrievedChunkIds?.length && (
                <details>
                  <summary>Retrieved chunk references</summary>
                  <ul>
                    {result.retrievedChunkIds.map((id) => (
                      <li className="break" key={id}>
                        {id}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {tab === 'Workflow' && (
            <>
              {result.stageEvents?.length ? (
                <AssessmentPipeline
                  heading="Recorded workflow"
                  compact
                  stages={Object.fromEntries(
                    result.stageEvents.map((e) => [e.stage as AssessmentStage, e.status]),
                  )}
                />
              ) : (
                <>
                  <h2>Recorded workflow</h2>
                  <Empty>No detailed stage events recorded.</Empty>
                </>
              )}
            </>
          )}
        </div>
      </section>
      <DecisionForm
        key={`${run.id}-${run.version}`}
        run={run}
        actor={actor}
        onChanged={onChanged}
      />
      {run.result.recommendation === 'REFER_TO_HUMAN' && (
        <ReferralReviewPanel run={run} actor={actor} />
      )}
      {run.status === 'rejected' && <WrittenReasonPanel run={run} />}
      {run.status === 'issued' && run.offer_id && (
        <section className="panel">
          <h2>Issued offer</h2>
          <button disabled={busy} onClick={() => void loadOffer()}>
            {busy ? 'Loading…' : 'View issued offer'}
          </button>
          <ErrorNotice error={error} />
          {offer && (
            <div>
              <p>
                <Money value={offer.data.amount} /> · Disbursement {offer.data.disbursementDate}
              </p>
              <p>
                {offer.data.mode === 'demo'
                  ? 'Demo offer — not fully evidence-verified.'
                  : offer.data.fullyEvidenceVerified
                    ? 'Evidence verified.'
                    : 'Not fully evidence-verified.'}
              </p>
              {offer.data.assumptions.map((a, i) => (
                <p key={i}>{a.reason}</p>
              ))}
              {offer.documentAvailable ? (
                <a href={`/api/v1/offers/${offer.id}/document`} download>
                  Download offer letter and repayment schedule (PDF)
                </a>
              ) : (
                <p className="muted">PDF source details are unavailable for this offer.</p>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
