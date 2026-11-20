import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import type { Response } from 'express';
import type { StreamFrame } from '../../../packages/contracts/src/streams.js';
import { invariant } from '../../../packages/domain/src/errors.js';

export async function sendEventStream<T extends { kind: string }>(
  res: Response,
  lastEventId: unknown,
  read: () => Promise<StreamFrame<T>[]> | StreamFrame<T>[],
  authorize: () => Promise<unknown>,
) {
  invariant(
    lastEventId === undefined || (typeof lastEventId === 'string' && /^\d{1,9}$/.test(lastEventId)),
    'InvalidEventCursor',
    'Last-Event-ID must be a valid event number',
    422,
  );
  let cursor = Number(lastEventId ?? 0);
  const disconnected = new AbortController();
  const stop = () => disconnected.abort();
  res.once('close', stop);
  let heartbeat = Date.now();
  async function write(frame: string) {
    if (!res.write(frame)) await once(res, 'drain', { signal: disconnected.signal });
  }
  try {
    let frames = await read();
    invariant(
      cursor <= (frames.at(-1)?.id ?? 0),
      'InvalidEventCursor',
      'Last-Event-ID exceeds stream progress',
      422,
    );
    if (disconnected.signal.aborted || res.destroyed) return;
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    while (!disconnected.signal.aborted) {
      for (const frame of frames) {
        if (frame.id <= cursor) continue;
        if (disconnected.signal.aborted) return;
        await write(`id: ${frame.id}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        cursor = frame.id;
      }
      const last = frames.at(-1)?.data.kind;
      if (last === 'completed' || last === 'failed') return;
      if (Date.now() - heartbeat >= 10_000) {
        await write(': keep-alive\n\n');
        heartbeat = Date.now();
      }
      await setTimeout(400, undefined, { signal: disconnected.signal });
      await authorize();
      frames = await read();
    }
  } catch (error) {
    if (!res.headersSent && !disconnected.signal.aborted) throw error;
  } finally {
    res.off('close', stop);
    if (res.headersSent && !res.destroyed) res.end();
  }
}
