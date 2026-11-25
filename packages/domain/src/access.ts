import { compareMoney } from './calculations.js';
import { invariant } from './errors.js';
export interface Actor {
  id: string;
  username: string;
  role: 'loan_officer' | 'credit_officer';
  tier: 'none' | 'credit' | 'senior' | 'head';
  canIngest: boolean;
}
export function requireReviewer(
  actor: Actor,
): asserts actor is Actor & { role: 'credit_officer'; tier: Exclude<Actor['tier'], 'none'> } {
  invariant(
    actor.role === 'credit_officer' && actor.tier !== 'none',
    'Forbidden',
    'Credit Officer access required',
    403,
  );
}
export type ApprovalAuthorityRole =
  'credit_officer' | 'senior_credit_officer' | 'head_of_consumer_credit';

export function approvalAuthorityLimit(tier: Actor['tier']): string {
  return { none: '0.00', credit: '250000.00', senior: '500000.00', head: '1000000.00' }[tier];
}

export function requiredApprovalTier(
  amount: string | null | undefined,
  referred: boolean,
): ApprovalAuthorityRole | null {
  if (amount && compareMoney(amount, '0') > 0) {
    if (compareMoney(amount, '500000.00') > 0) return 'head_of_consumer_credit';
    if (referred || compareMoney(amount, '250000.00') > 0) return 'senior_credit_officer';
    return 'credit_officer';
  }
  return referred ? 'senior_credit_officer' : null;
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
  const limit = approvalAuthorityLimit(actor.tier);
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
