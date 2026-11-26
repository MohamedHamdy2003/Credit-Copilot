import { useState } from 'react';
import { api } from './api';
import type { Actor, ReviewRow, Run } from './types';
import { Empty, Money, ResourceState, Status, useResource } from './components';
import { Assessment } from './Assessment';
import { ReferralQueue } from './CaseReview';
function Review({ id, actor, changed }: { id: string; actor: Actor; changed: () => void }) {
  const run = useResource((signal) => api.request<Run>(`assessments/${id}`, { signal }), [id]);
  return (
    <>
      <ResourceState {...run} retry={run.refresh} />
      {run.data && (
        <section>
          <p>
            <a href={`/api/v1/applications/${run.data.application_id}/evidence`}>
              Download original for {run.data.result.reference}
            </a>
          </p>
          <Assessment
            key={id}
            run={run.data}
            actor={actor}
            onChanged={() => {
              run.refresh();
              changed();
            }}
          />
        </section>
      )}
    </>
  );
}
export function Reviews({ actor }: { actor: Actor }) {
  const queue = useResource((signal) => api.request<ReviewRow[]>('reviews', { signal }), []);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Review queue</h1>
          <p>Independent review. Recorded decisions.</p>
        </div>
        <button onClick={queue.refresh}>Refresh queue</button>
      </header>
      {['senior', 'head'].includes(actor.tier) && <ReferralQueue onSelect={setSelected} />}
      <ResourceState {...queue} retry={queue.refresh} />
      {queue.data && (
        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Application</th>
                <th>Status</th>
                <th>Recommended</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {queue.data.map((r) => (
                <tr className={selected === r.id ? 'selected' : ''} key={r.id}>
                  <td title={`Assessment ${r.id}`}>
                    <strong>{r.reference}</strong>
                  </td>
                  <td>
                    <Status value={r.status} />
                  </td>
                  <td>
                    <Money value={r.recommended_amount} />
                  </td>
                  <td>
                    <button aria-label={`Review ${r.id}`} onClick={() => setSelected(r.id)}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!queue.data.length && <Empty>No assessments awaiting review.</Empty>}
        </section>
      )}
      {selected && <Review key={selected} id={selected} actor={actor} changed={queue.refresh} />}
    </>
  );
}
