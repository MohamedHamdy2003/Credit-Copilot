import {
  ingestionStreamEvent,
  type IngestionStreamEvent,
  type StreamFrame,
} from '../../contracts/src/streams.js';
import { invariant } from '../../domain/src/errors.js';

const REPLAY_MS = 5 * 60_000;
const MAX_PENDING_MS = 10 * 60_000;
const CAPACITY = 32;

interface IngestionJob {
  id: string;
  owner: string;
  deadline: number;
  done: boolean;
  frames: StreamFrame<IngestionStreamEvent>[];
}

/** Short-lived in-memory replay of live ingestion stage progress per actor. */
export class IngestionStreams {
  private readonly jobs = new Map<string, IngestionJob>();

  start(
    owner: string,
    newId: () => string,
    run: (emit: (event: IngestionStreamEvent) => void) => Promise<void>,
  ) {
    this.prune();
    invariant(
      this.jobs.size < CAPACITY,
      'IngestionStreamsBusy',
      'Ingestion streaming is busy. Please retry shortly.',
      503,
    );
    const job: IngestionJob = {
      id: newId(),
      owner,
      deadline: Date.now() + MAX_PENDING_MS,
      done: false,
      frames: [],
    };
    this.jobs.set(job.id, job);
    const push = (event: IngestionStreamEvent) => {
      if (job.done) return;
      const parsed = ingestionStreamEvent.parse(event);
      job.frames.push({ id: job.frames.length + 1, data: parsed });
      if (parsed.kind === 'completed' || parsed.kind === 'failed') {
        job.done = true;
        job.deadline = Date.now() + REPLAY_MS;
      }
    };
    void Promise.resolve()
      .then(() => run(push))
      .catch(() => push({ kind: 'failed', code: 'IngestionStreamFailed' }));
    return { streamId: job.id };
  }

  read(owner: string, id: string) {
    this.prune();
    const job = this.jobs.get(id);
    invariant(job && job.owner === owner, 'NotFound', 'Ingestion stream not found or expired', 404);
    return job.frames;
  }

  private prune() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.deadline > now) continue;
      if (job.done) this.jobs.delete(id);
      else {
        job.frames.push({
          id: job.frames.length + 1,
          data: { kind: 'failed', code: 'IngestionTimedOut' },
        });
        job.done = true;
        job.deadline = now + REPLAY_MS;
      }
    }
  }
}
