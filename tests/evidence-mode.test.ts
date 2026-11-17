import { resolveMode, evaluateEvidence } from '../packages/domain/src/evidence-mode.js';
const missingId = [{ requirement: 'national_id_copy', present: false, verified: false }];
describe('strict and demo evidence', () => {
  it('defaults to strict and refers citing both authoritative clauses', () => {
    const mode = resolveMode(undefined, { allowDemo: false }, true);
    const result = evaluateEvidence(missingId, mode, 'user', '2025-04-01T00:00:00Z');
    expect(result.referral).toEqual({
      recommendation: 'REFER_TO_HUMAN',
      reason: 'MISSING_REQUIRED_EVIDENCE',
      citations: ['CP-8', 'PS-7'],
    });
    expect(result.assumptions).toEqual([]);
  });
  it('requires explicit demo enablement and synthetic data', () => {
    expect(() => resolveMode('demo', { allowDemo: false }, true)).toThrow();
    expect(() => resolveMode('demo', { allowDemo: true }, false)).toThrow();
  });
  it('records the assumption without fabricating or verifying evidence', () => {
    const before = structuredClone(missingId);
    const mode = resolveMode('demo', { allowDemo: true }, true);
    const result = evaluateEvidence(missingId, mode, 'user', '2025-04-01T00:00:00Z');
    expect(result.referral).toBeNull();
    expect(result.fullyEvidenceVerified).toBe(false);
    expect(result.evidenceComplete).toBe(false);
    expect(result.assumptions[0]?.verified).toBe(false);
    expect(result.auditEvents[0]?.requirement).toBe('national_id_copy');
    expect(missingId).toEqual(before);
  });
  it('never assumes probation or other evidence', () => {
    const result = evaluateEvidence(
      [...missingId, { requirement: 'probation_completed', present: false, verified: false }],
      'demo',
      'user',
      'now',
    );
    expect(result.missing).toEqual(['probation_completed']);
    expect(result.referral?.recommendation).toBe('REFER_TO_HUMAN');
  });
});
