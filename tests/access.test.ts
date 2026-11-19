import { authorizeApproval, type Actor } from '../packages/domain/src/access.js';
import { decisionCommandSchema } from '../packages/application/src/decisions.js';
const actor = (tier: Actor['tier']): Actor => ({
  id: 'reviewer',
  username: 'reviewer',
  role: 'credit_officer',
  tier,
  canIngest: false,
});
it.each([
  ['credit', '250000'],
  ['senior', '500000'],
  ['head', '1000000'],
] as const)('allows exact %s boundary from the recommended amount', (tier, amount) => {
  expect(() => authorizeApproval(actor(tier), 'preparer', amount, false, 'Reviewed')).not.toThrow();
  expect(() =>
    authorizeApproval(actor(tier), 'preparer', `${Number(amount) + 1}`, false, 'Reviewed'),
  ).toThrow('authority');
});
it('requires senior authority for referrals and a written justification', () => {
  expect(() => authorizeApproval(actor('credit'), 'preparer', '100000', true, 'Reviewed')).toThrow(
    'Senior',
  );
  expect(() => authorizeApproval(actor('senior'), 'preparer', '100000', true, ' ')).toThrow(
    'written',
  );
  expect(() => authorizeApproval(actor('head'), 'preparer', '0', false, 'Reviewed')).toThrow(
    'positive',
  );
});
it('rejects authority, amount and approver identity supplied inside decision requests', () => {
  expect(() =>
    decisionCommandSchema.parse({
      action: 'approve',
      expectedVersion: 1,
      comment: 'Reviewed',
      amount: '1',
      tier: 'head',
      actorId: 'head',
    }),
  ).toThrow();
});
