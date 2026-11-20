import { z } from 'zod';
import type { Actor } from '../../domain/src/access.js';
export const referralNoteSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: z.enum(['awaiting_evidence', 'requires_reassessment', 'fraud_recorded']),
    comment: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ReferralNote = z.infer<typeof referralNoteSchema>;
export interface CaseReviewStore {
  reason(actor: Actor, runId: string): Promise<unknown>;
  requestReason(actor: Actor, runId: string, message: string, requestId: string): Promise<unknown>;
  referrals(actor: Actor): Promise<unknown>;
  referral(actor: Actor, runId: string): Promise<unknown>;
  note(actor: Actor, runId: string, command: ReferralNote, requestId: string): Promise<unknown>;
}
export class CaseReviewService {
  constructor(private readonly store: CaseReviewStore) {}
  reason(actor: Actor, id: string) {
    z.uuid().parse(id);
    return this.store.reason(actor, id);
  }
  requestReason(actor: Actor, id: string, raw: unknown, requestId: string) {
    z.uuid().parse(id);
    const body = z
      .object({ message: z.string().trim().max(2000).default('') })
      .strict()
      .parse(raw);
    return this.store.requestReason(actor, id, body.message, requestId);
  }
  referrals(actor: Actor) {
    return this.store.referrals(actor);
  }
  referral(actor: Actor, id: string) {
    z.uuid().parse(id);
    return this.store.referral(actor, id);
  }
  note(actor: Actor, id: string, raw: unknown, requestId: string) {
    z.uuid().parse(id);
    return this.store.note(actor, id, referralNoteSchema.parse(raw), requestId);
  }
}
