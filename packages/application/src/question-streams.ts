import {
  questionStreamEvent,
  type QuestionStreamEvent,
  type StreamFrame,
} from '../../contracts/src/streams.js';
import { invariant } from '../../domain/src/errors.js';
import type { answerPolicyQuestion } from './questions.js';

const REPLAY_MS = 5 * 60_000;
const MAX_PENDING_MS = 3 * 60_000;
const CAPACITY = 128;
interface QuestionJob {
  id: string;
  owner: string;
  fingerprint: string;
  deadline: number;
  frames: StreamFrame<QuestionStreamEvent>[];
}

/** Short-lived replay of verified source excerpts. The question and provider output are transient. */
export class QuestionStreams {
  private readonly jobs = new Map<string, QuestionJob>();

  start(
    owner: string,
    key: string,
    fingerprint: string,
    newId: () => string,
    ask: () => ReturnType<typeof answerPolicyQuestion>,
  ) {
    this.prune();
    const streamKey = `${owner}:${key}`;
    const existing = this.jobs.get(streamKey);
    if (existing) {
      invariant(
        existing.fingerprint === fingerprint,
        'IdempotencyConflict',
        'Use a different key for a different question',
        409,
      );
      return { streamId: existing.id };
    }
    invariant(
      this.jobs.size < CAPACITY,
      'QuestionStreamsBusy',
      'Question streaming is busy. Please retry shortly.',
      503,
    );
    const job: QuestionJob = {
      id: newId(),
      owner,
      fingerprint,
      deadline: Date.now() + MAX_PENDING_MS,
      frames: [],
    };
    this.jobs.set(streamKey, job);
    void Promise.resolve()
      .then(ask)
      .then((answer) => {
        const citations = answer.refused
          ? []
          : answer.citations.map((citation) =>
              questionStreamEvent.parse({ kind: 'citation', asOfDate: answer.asOfDate, citation }),
            );
        this.finish(job, [
          ...citations,
          questionStreamEvent.parse({
            kind: 'completed',
            asOfDate: answer.asOfDate,
            refused: answer.refused,
            resolution: 'resolution' in answer ? answer.resolution : undefined,
          }),
        ]);
      })
      .catch(() => this.fail(job));
    return { streamId: job.id };
  }

  read(owner: string, id: string) {
    this.prune();
    const job = [...this.jobs.values()].find((entry) => entry.id === id && entry.owner === owner);
    invariant(job, 'NotFound', 'Question stream not found or expired', 404);
    return job.frames;
  }

  private finish(job: QuestionJob, events: QuestionStreamEvent[]) {
    if (job.frames.length) return;
    job.frames = events.map((data, index) => ({ id: index + 1, data }));
    job.deadline = Date.now() + REPLAY_MS;
  }

  private fail(job: QuestionJob) {
    this.finish(job, [{ kind: 'failed', code: 'QuestionUnavailable' }]);
  }

  private prune() {
    const now = Date.now();
    for (const [key, job] of this.jobs) {
      if (job.deadline > now) continue;
      if (job.frames.length) this.jobs.delete(key);
      else this.fail(job);
    }
  }
}
