import { z } from 'zod';
import { normalizedDocumentSchema } from '../../contracts/src/documents.js';
import { applicationFormSchema, parseApplicationForm } from './application-form.js';
import { sanitizeEvidence, extractVerified } from './extraction.js';
import { deriveEvidenceFacts } from './evidence-facts.js';
import { resolveMode, evaluateEvidence } from '../../domain/src/evidence-mode.js';
import { selectPolicy, selectPricing, type Policy } from '../../domain/src/policy.js';
import { assessRules } from '../../domain/src/rules.js';
import { DomainError, invariant } from '../../domain/src/errors.js';
import type { AssessmentDependencies } from './assessment.js';
import type { AssessmentRepository, AssessmentResult } from './assessment-record.js';
import type { Chunk } from '../../contracts/src/documents.js';
import { creditMemo } from './credit-memo.js';

export const documentAssessmentInputSchema = z
  .object({
    document: normalizedDocumentSchema,
    actorId: z.string().min(1),
    at: z.iso.datetime(),
    requestedMode: z.enum(['strict', 'demo']).optional(),
    synthetic: z.boolean(),
  })
  .strict();
export type DocumentAssessmentInput = z.infer<typeof documentAssessmentInputSchema>;
export interface AssessmentClausePort {
  loadRequired(edition: string, date: string, product: string): Promise<Chunk[]>;
}
export interface DocumentAssessmentDependencies extends AssessmentDependencies {
  clauses: AssessmentClausePort;
  persistence: {
    repository: AssessmentRepository;
    runId: string;
    applicationId: string;
    requestId: string;
  };
}
export interface AssessmentState {
  input: DocumentAssessmentInput;
  form?: z.infer<typeof applicationFormSchema>;
  sanitized?: ReturnType<typeof sanitizeEvidence>;
  derived?: ReturnType<typeof deriveEvidenceFacts>;
  evidence?: ReturnType<typeof evaluateEvidence>;
  mode: 'strict' | 'demo';
  policy?: Policy;
  extraction?: Awaited<ReturnType<typeof extractVerified>>;
  rules?: ReturnType<typeof assessRules>;
  pricing?: import('../../domain/src/policy.js').PricingRow;
  clauses: Chunk[];
  failure?: string;
  result?: AssessmentResult;
  steps: string[];
  usageRecords: NonNullable<AssessmentResult['usageRecords']>;
  stageEvents: NonNullable<AssessmentResult['stageEvents']>;
}
export const ASSESSMENT_STAGES = [
  'load_application',
  'remove_protected_attributes',
  'select_policy',
  'extract_data',
  'retrieve_policy_clauses',
  'calculate_and_check_rules',
  'prepare_memo',
  'record_pending_review',
] as const;
export type AssessmentStage = (typeof ASSESSMENT_STAGES)[number];

export function initialAssessmentState(
  raw: unknown,
  deps: DocumentAssessmentDependencies,
): AssessmentState {
  const input = documentAssessmentInputSchema.parse(raw);
  return {
    input,
    mode: resolveMode(input.requestedMode, deps.settings, input.synthetic),
    clauses: [],
    steps: [],
    usageRecords: [],
    stageEvents: [],
  };
}
export async function executeAssessmentStage(
  stage: AssessmentStage,
  state: AssessmentState,
  deps: DocumentAssessmentDependencies,
): Promise<AssessmentState> {
  state.steps.push(stage);
  const event: { stage: string; status: 'executed' | 'skipped' | 'failed' } = {
    stage,
    status: 'executed',
  };
  state.stageEvents.push(event);
  if (
    state.failure &&
    stage !== 'prepare_memo' &&
    stage !== 'record_pending_review' &&
    !(stage === 'select_policy' && state.form)
  ) {
    event.status = 'skipped';
    return state;
  }
  try {
    switch (stage) {
      case 'load_application':
        state.form = parseApplicationForm(state.input.document);
        break;
      case 'remove_protected_attributes': {
        state.sanitized = sanitizeEvidence(state.input.document);
        if (state.sanitized.tampered)
          throw new DomainError('SuspectedTampering', 'Refer tampered evidence to Fraud Unit');
        state.derived = deriveEvidenceFacts(state.input.document);
        state.evidence = evaluateEvidence(
          state.derived.evidence,
          state.mode,
          state.input.actorId,
          state.input.at,
        );
        break;
      }
      case 'select_policy': {
        state.policy = selectPolicy(deps.policies, state.form!.applicationDate);
        if (state.evidence?.referral && !state.failure)
          state.failure = state.evidence.referral.reason;
        break;
      }
      case 'extract_data':
        state.extraction = await extractVerified(
          state.input.document,
          {
            completeStructured: async (system, data) => {
              try {
                const response = await deps.provider.completeStructured(system, data);
                state.usageRecords.push({ model: response.model, ...response.usage });
                return response;
              } catch (error) {
                const details = error instanceof DomainError ? error.details : {};
                state.usageRecords.push({
                  model:
                    typeof details.model === 'string' ? details.model : 'provider-not-reported',
                  inputTokens: typeof details.inputTokens === 'number' ? details.inputTokens : null,
                  outputTokens:
                    typeof details.outputTokens === 'number' ? details.outputTokens : null,
                });
                throw error;
              }
            },
          },
          deps.prompt,
        );
        break;
      case 'retrieve_policy_clauses': {
        state.clauses = await deps.clauses.loadRequired(
          state.policy!.edition,
          state.form!.applicationDate,
          deps.product.id,
        );
        for (const section of [
          'CP-3.1',
          'CP-3.2',
          'CP-3.3',
          'CP-3.4',
          'CP-3.5',
          'CP-4.1',
          'CP-4.2',
          'CP-4.3',
          'CP-5',
          'CP-6',
          'CP-8',
          'CP-11',
        ]) {
          invariant(
            state.clauses.some(
              (c) =>
                c.edition === state.policy!.edition &&
                c.section === section &&
                c.effectiveFrom <= state.form!.applicationDate &&
                (!c.effectiveTo || state.form!.applicationDate < c.effectiveTo),
            ),
            'MissingPolicyClause',
            `Missing applicable ${section}`,
          );
        }
        // Guard executable configuration against drift from the indexed source.
        // Ordered operative clause first: an annex's old50% value must not
        // validate an incorrect2025 executable configuration.
        const dbr = state.clauses.find((c) => c.section === 'CP-4.1')!.text;
        const expected = Number(state.policy!.maxDbr) * 100;
        invariant(
          dbr.includes(`${expected}%`),
          'PolicyConfigurationMismatch',
          'DBR configuration disagrees with source',
        );
        break;
      }
      case 'calculate_and_check_rules': {
        const f = state.form!,
          x = state.extraction!.fields;
        const price = selectPricing(deps.pricing, f.applicationDate, f.months, f.payrollTransfer);
        state.pricing = price;
        state.rules = assessRules(
          {
            ...state.derived!.facts,
            applicationDate: f.applicationDate,
            birthDate: f.birthDate,
            amount: f.amount,
            months: f.months,
            income: x.income.value,
            obligations: x.obligations.value,
            employmentStart: x.employmentStart.value,
            bureauScore: x.bureauScore.value,
          },
          state.policy!,
          deps.product,
          price,
        );
        break;
      }
      case 'prepare_memo': {
        const evidence =
          state.evidence ??
          evaluateEvidence(
            [{ requirement: 'national_id_copy', present: false, verified: false }],
            state.mode,
            state.input.actorId,
            state.input.at,
          );
        const base = {
          reference: state.form?.reference ?? 'unparsed',
          mode: state.mode,
          evidence,
          policyEdition: state.policy?.edition ?? null,
          maxDbr: state.policy?.maxDbr ?? null,
          removedFields: state.sanitized?.removedFields ?? [],
          steps: state.steps,
        };
        if (state.failure)
          state.result = {
            ...base,
            recommendation: 'REFER_TO_HUMAN',
            reason: state.failure,
            fraudReferral: state.failure === 'SuspectedTampering',
            calculation: null,
            status: 'pending_review',
            citations:
              state.failure === 'SuspectedTampering'
                ? ['PM-7', 'CP-8']
                : (evidence.referral?.citations ?? ['CP-8']),
          };
        else {
          const r = state.rules!;
          state.result = {
            ...base,
            ...r,
            extraction: state.extraction!,
            fraudReferral: false,
            status:
              r.recommendation === 'REFER_TO_HUMAN'
                ? 'pending_review'
                : r.recommendation === 'OFFER_ALTERNATIVE'
                  ? 'pending_customer_acceptance'
                  : 'pending_approval',
            pricing: state.pricing,
          };
        }
        state.result.memo = creditMemo(state.result, state.form);
        break;
      }
      case 'record_pending_review': {
        invariant(state.result, 'InvalidWorkflowState', 'Missing assessment result');
        state.result = {
          ...state.result,
          retrievedChunkIds: state.clauses.map((c) => c.id),
          usageRecords: state.usageRecords,
          stageEvents: state.stageEvents,
        };
        await deps.persistence.repository.save({
          id: deps.persistence.runId,
          applicationId: deps.persistence.applicationId,
          requestId: deps.persistence.requestId,
          actorId: state.input.actorId,
          at: state.input.at,
          result: state.result,
        });
        break;
      }
    }
  } catch (error) {
    event.status = 'failed';
    if (stage === 'record_pending_review') throw error;
    state.failure = error instanceof DomainError ? error.code : 'AssessmentStepFailed';
  }
  return state;
}
