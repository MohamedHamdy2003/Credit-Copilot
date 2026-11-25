import {
  reasonWindow,
  referralTarget,
  rejectionClauses,
  requireSenior,
} from '../packages/domain/src/review-policy.js';
import type { Actor } from '../packages/domain/src/access.js';
it('accepts days zero and thirty, rejects future/late requests, and crosses leap/month boundaries', () => {
  expect(reasonWindow('2024-02-28', '2024-02-28')).toEqual({
    deadline: '2024-03-29',
    eligible: true,
  });
  expect(reasonWindow('2024-02-28', '2024-03-29').eligible).toBe(true);
  expect(reasonWindow('2024-02-28', '2024-03-30').eligible).toBe(false);
  expect(reasonWindow('2024-02-28', '2024-02-27').eligible).toBe(false);
  expect(() => reasonWindow('2024-02-30', '2024-03-01')).toThrow('Invalid calendar');
});
it('estimates two business days with configured weekends/holidays without acting on the result', () => {
  expect(referralTarget('2026-11-19', { weekendDays: [5, 6], holidays: [] })).toBe('2026-11-23');
  expect(referralTarget('2026-11-19', { weekendDays: [5, 6], holidays: ['2026-11-22'] })).toBe(
    '2026-11-24',
  );
  expect(() =>
    referralTarget('2026-11-19', { weekendDays: [0, 1, 2, 3, 4, 5, 6], holidays: [] }),
  ).toThrow('working weekday');
});
it('keeps missing evidence, tampering and below-minimum score as referrals rather than rejection clauses', () => {
  const base = {
    fraudReferral: false,
    missing: [] as string[],
    results: [{ rule: 'CP-6', result: 'refer' }],
    customerDeclined: false,
  };
  expect(rejectionClauses(base)).toEqual([]);
  expect(rejectionClauses({ ...base, allowReferredClauses: true })).toEqual(['CP-6']);
  expect(() => rejectionClauses({ ...base, missing: ['national_id_copy'] })).toThrow(
    'requires referral',
  );
  expect(() => rejectionClauses({ ...base, fraudReferral: true })).toThrow('requires referral');
  expect(
    rejectionClauses({
      ...base,
      results: [
        { rule: 'CP-3.5', result: 'fail' },
        { rule: 'CP-6 default', result: 'fail' },
      ],
    }),
  ).toEqual(['CP-3.5', 'CP-6']);
  expect(rejectionClauses({ ...base, results: [{ rule: 'CP-4.1', result: 'fail' }] })).toEqual([]);
  expect(rejectionClauses({ ...base, customerDeclined: true })).toEqual(['CP-4.1']);
});
it('reserves referral handling to senior/head server identities', () => {
  const actor: Actor = {
    id: 'a',
    username: 'a',
    role: 'credit_officer',
    tier: 'credit',
    canIngest: false,
  };
  expect(() => requireSenior(actor)).toThrow('Senior');
  expect(() => requireSenior({ ...actor, tier: 'senior' })).not.toThrow();
  expect(() => requireSenior({ ...actor, tier: 'head', role: 'loan_officer' })).toThrow('Senior');
});
