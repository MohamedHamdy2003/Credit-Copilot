import { z } from 'zod';
import type { Actor } from '../../domain/src/access.js';
export const decisionCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('approve'),
      expectedVersion: z.number().int().positive(),
      comment: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal('reject'),
      expectedVersion: z.number().int().positive(),
      comment: z.string().trim().min(1).max(2000),
      clause: z.string().regex(/^(?:CP|PS|PM)-\d+(?:\.\d+)?$/),
    })
    .strict(),
  z
    .object({
      action: z.literal('customer_response'),
      expectedVersion: z.number().int().positive(),
      comment: z.string().trim().min(1).max(2000),
      accepted: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('issue'),
      expectedVersion: z.number().int().positive(),
      comment: z.string().trim().min(1).max(2000),
      disbursementDate: z.iso.date(),
    })
    .strict(),
]);
export type DecisionCommand = z.infer<typeof decisionCommandSchema>;
export interface DecisionStore {
  execute(
    actor: Actor,
    runId: string,
    command: DecisionCommand,
    requestId: string,
  ): Promise<unknown>;
  read(actor: Actor, runId: string): Promise<unknown>;
  queue(actor: Actor): Promise<unknown>;
}
export class DecisionService {
  constructor(private readonly store: DecisionStore) {}
  execute(actor: Actor, runId: string, raw: unknown, requestId: string) {
    z.uuid().parse(runId);
    return this.store.execute(actor, runId, decisionCommandSchema.parse(raw), requestId);
  }
  read(actor: Actor, runId: string) {
    z.uuid().parse(runId);
    return this.store.read(actor, runId);
  }
  queue(actor: Actor) {
    return this.store.queue(actor);
  }
}
