import { compareMoney } from './calculations.js';
import { invariant } from './errors.js';
export interface Actor {
  id: string;
  username: string;
  role: 'loan_officer' | 'credit_officer';
  tier: 'none' | 'credit' | 'senior' | 'head';
  canIngest: boolean;
}
export function requireReviewer(actor: Actor) {
  invariant(
    actor.role === 'credit_officer' && actor.tier !== 'none',
    'Forbidden',
    'Credit Officer access required',
    403,
  );
}
export function authorizeApproval(
  actor: Actor,
  preparerId: string,
  amount: string,
  referred: boolean,
  justification: string,
) {
  requireReviewer(actor);
  invariant(compareMoney(amount, '0') > 0, 'InvalidAmount', 'Recommended amount must be positive');
  invariant(
    actor.id !== preparerId,
    'FourEyesViolation',
    'The preparer cannot approve their own assessment',
    403,
  );
  const limit = { none: '0', credit: '250000', senior: '500000', head: '1000000' }[actor.tier];
  invariant(
    compareMoney(amount, limit) <= 0,
    'AuthorityLimitExceeded',
    'Recommended amount exceeds approval authority',
    403,
  );
  invariant(
    !referred || ['senior', 'head'].includes(actor.tier),
    'Forbidden',
    'Referred applications require Senior Credit Officer',
    403,
  );
  invariant(
    justification.trim().length > 0,
    'JustificationRequired',
    'A written decision comment is required',
  );
}
