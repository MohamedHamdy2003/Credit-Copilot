import { invariant } from './errors.js';

export type AssessmentMode = 'strict' | 'demo';
export interface EvidenceItem {
  requirement: string;
  present: boolean;
  verified: boolean;
}
export function resolveMode(
  requested: AssessmentMode | undefined,
  settings: { defaultMode?: AssessmentMode; allowDemo: boolean },
  synthetic: boolean,
): AssessmentMode {
  const mode = requested ?? settings.defaultMode ?? 'strict';
  invariant(
    mode === 'strict' || mode === 'demo',
    'InvalidAssessmentMode',
    'Unsupported assessment mode',
  );
  invariant(
    mode !== 'demo' || (settings.allowDemo && synthetic),
    'DemoModeDisabled',
    'Demo must be explicitly enabled and limited to synthetic cases',
    403,
  );
  return mode;
}
export function evaluateEvidence(
  items: readonly EvidenceItem[],
  mode: AssessmentMode,
  actorId: string,
  at: string,
) {
  const assumptions = items
    .filter((item) => item.requirement === 'national_id_copy' && !item.present && mode === 'demo')
    .map(() => ({
      requirement: 'national_id_copy',
      actualEvidence: 'missing',
      assumedPresent: true,
      verified: false,
      reason: 'ID-copy presence assumed only for a synthetic demo',
      actorId,
      at,
    }));
  const missing = items
    .filter(
      (item) => !item.present && !(mode === 'demo' && item.requirement === 'national_id_copy'),
    )
    .map((item) => item.requirement);
  return {
    mode,
    assumptions,
    missing,
    evidenceComplete: items.every((item) => item.present),
    fullyEvidenceVerified: items.every((item) => item.present && item.verified),
    referral: missing.length
      ? {
          recommendation: 'REFER_TO_HUMAN' as const,
          reason: 'MISSING_REQUIRED_EVIDENCE',
          citations: ['CP-8', 'PS-7'],
        }
      : null,
    auditEvents: assumptions.map((assumption) => ({
      event: 'DEMO_EVIDENCE_ASSUMPTION',
      ...assumption,
    })),
  };
}
