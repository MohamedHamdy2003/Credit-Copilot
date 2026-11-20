import { useState, type FormEvent } from 'react';
import { api } from './api';
import { Empty, ErrorNotice, ResourceState, useResource } from './components';
import type { Actor, Run } from './types';
interface WrittenReply {
  clause: string;
  policyEdition: string;
  sourceFile: string;
  reason: string;
  decidedAt: string;
  providedAt: string;
  mode: string;
  fullyEvidenceVerified: boolean;
  note: string;
  assumptions: { reason: string }[];
}
interface WrittenReason {
  notice: { clause: string; policy_edition: string; decided_at: string };
  window: { eligible: boolean; deadline: string };
  canRequest: boolean;
  request: { id: string; reply: WrittenReply } | null;
}
export function WrittenReasonPanel({ run }: { run: Run }) {
  const resource = useResource(
    (signal) => api.request<WrittenReason>(`assessments/${run.id}/written-reason`, { signal }),
    [run.id],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await api.request(`assessments/${run.id}/reason-requests`, {
        body: { message: String(form.get('message') ?? '') },
      });
      resource.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const data = resource.data,
    reply = data?.request?.reply;
  return (
    <section className="panel">
      <h2>Written rejection reason</h2>
      <p>
        PM-9: the applicant may request the reason in writing within 30 days. This records a request
        and returns a copy of the original human decision; it does not overturn it.
      </p>
      <ResourceState {...resource} retry={resource.refresh} />
      <ErrorNotice error={error} />
      {data && (
        <>
          <p>
            Original clause: {data.notice.clause} · {data.notice.policy_edition}. Request deadline:{' '}
            {data.window.deadline} (Cairo calendar date, inclusive).
          </p>
          {data.canRequest && (
            <form onSubmit={submit}>
              <label>
                Request message (optional)
                <textarea
                  name="message"
                  maxLength={2000}
                  placeholder="Please provide the reason in writing. Do not include personal identifiers."
                />
              </label>
              <button className="primary" disabled={busy}>
                {busy ? 'Recording request…' : 'Request written reason'}
              </button>
            </form>
          )}
          {!data.window.eligible && !data.request && (
            <p role="status">
              The 30-day request window is closed. A written reply cannot be invented or backdated.
            </p>
          )}
          {reply && (
            <article className="answer" aria-label="Written reply">
              <h3>Written reply</h3>
              <p>
                <strong>
                  {reply.clause} · {reply.policyEdition}
                </strong>
              </p>
              <p>{reply.reason}</p>
              <p>Source: {reply.sourceFile}</p>
              <p className="muted">
                Decision:{' '}
                {new Date(reply.decidedAt).toLocaleDateString('en-GB', {
                  timeZone: 'Africa/Cairo',
                })}{' '}
                · Reply:{' '}
                {new Date(reply.providedAt).toLocaleDateString('en-GB', {
                  timeZone: 'Africa/Cairo',
                })}
              </p>
              {reply.mode === 'demo' && (
                <div className="notice demo">
                  Demo decision — not fully evidence-verified.
                  {reply.assumptions.map((a, i) => (
                    <p key={i}>{a.reason}</p>
                  ))}
                </div>
              )}
              <p>{reply.note}</p>
            </article>
          )}
        </>
      )}
    </section>
  );
}
interface ReferralHistory {
  target: string;
  destination: string;
  notes: { id: string; action: string; comment: string; created_at: string }[];
}
export function ReferralReviewPanel({ run, actor }: { run: Run; actor: Actor }) {
  const history = useResource(
    (signal) => api.request<ReferralHistory>(`referrals/${run.id}`, { signal }),
    [run.id],
  );
  const [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  const canReview =
    actor.id !== run.preparer_id &&
    actor.role === 'credit_officer' &&
    ['senior', 'head'].includes(actor.tier) &&
    run.status === 'pending_review';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(undefined);
    try {
      await api.request(`referrals/${run.id}/reviews`, {
        body: {
          expectedVersion: run.version,
          action: data.get('action'),
          comment: data.get('comment'),
        },
      });
      history.refresh();
      form.reset();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Referral handling</h2>
      <p>
        Senior review under PM-4. Missing evidence needs reassessment; a review note never approves
        or clears a referral.
      </p>
      <ResourceState {...history} retry={history.refresh} />
      {history.data && (
        <>
          <p>
            Destination: {history.data.destination} · Target estimate: {history.data.target}
          </p>
          <p className="muted">
            Two-business-day estimate using configured weekends/holidays. The source corpus supplies
            no public-holiday calendar. Fraud routing is an internal record; no external delivery is
            claimed.
          </p>
          {history.data.notes.length ? (
            <ul className="history">
              {history.data.notes.map((n) => (
                <li key={n.id}>
                  <strong>{n.action.replaceAll('_', ' ')}</strong>
                  <span>{n.comment}</span>
                  <small>
                    {new Date(n.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Cairo' })}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No referral review notes yet.</Empty>
          )}
        </>
      )}
      {canReview && (
        <form onSubmit={submit}>
          <label>
            Referral action
            <select name="action">
              <option value="awaiting_evidence">Awaiting evidence</option>
              <option value="requires_reassessment">Requires reassessment</option>
              {run.result.fraudReferral && (
                <option value="fraud_recorded">Acknowledge internal Fraud Unit record</option>
              )}
            </select>
          </label>
          <label>
            Referral justification
            <textarea name="comment" required maxLength={2000} />
          </label>
          <button disabled={busy}>{busy ? 'Recording…' : 'Record referral review'}</button>
          <ErrorNotice error={error} />
        </form>
      )}
    </section>
  );
}
interface Referral {
  id: string;
  reference: string;
  destination: string;
  target: string;
  overdue: boolean;
}
export function ReferralQueue({ onSelect }: { onSelect: (id: string) => void }) {
  const queue = useResource((signal) => api.request<Referral[]>('referrals', { signal }), []);
  return (
    <section>
      <h2>Senior referral queue</h2>
      <p className="muted">
        PM-4 indicative target only. Friday/Saturday weekends by default; public holidays require
        configuration.
      </p>
      <ResourceState {...queue} retry={queue.refresh} />
      {queue.data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Destination</th>
                <th>Target estimate</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {queue.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.reference}</td>
                  <td>{r.destination}</td>
                  <td>
                    {r.target}
                    {r.overdue ? ' · past estimate' : ''}
                  </td>
                  <td>
                    <button aria-label={`Review referral ${r.id}`} onClick={() => onSelect(r.id)}>
                      Review referral
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!queue.data.length && <Empty>No active referrals.</Empty>}
        </div>
      )}
    </section>
  );
}
