import { z } from 'zod';
import { normalizedDocumentSchema } from '../../contracts/src/documents.js';
import type { AssessmentStage } from '../../contracts/src/streams.js';
import type { UsageStep } from '../../contracts/src/usage.js';
export { ASSESSMENT_STAGES, type AssessmentStage } from '../../contracts/src/streams.js';
import { applicationFormSchema, parseApplicationForm } from './application-form.js';
import { sanitizeEvidence, extractSanitized } from './extraction.js';
import { deriveEvidenceFacts } from './evidence-facts.js';
import {
  resolveMode,
  evaluateEvidence,
  type AssessmentMode,
} from '../../domain/src/evidence-mode.js';
import {
  selectPolicy,
  selectPricing,
  type Policy,
  type PricingRow,
  type Product,
} from '../../domain/src/policy.js';
import { requiredApprovalTier } from '../../domain/src/access.js';
import { assessRules } from '../../domain/src/rules.js';
import { DomainError, invariant } from '../../domain/src/errors.js';
import type { AssessmentRepository, AssessmentResult } from './assessment-record.js';
import type { Chunk } from '../../contracts/src/documents.js';
import { creditMemo } from './credit-memo.js';
import type { GenerationPort, Usage } from './ports.js';
import type {
  AgentToolCall,
  AssessmentAgent,
  AssessmentAgentInputMap,
  AssessmentAgentOutputMap,
  AssessmentAgentPort,
} from './assessment-agents.js';

export interface AssessmentDependencies {
  provider: GenerationPort;
  prompt: string;
  policies: Policy[];
  product: Product;
  pricing: PricingRow[];
  settings: { allowDemo: boolean; defaultMode?: AssessmentMode };
}

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
  loadRequired(
    edition: string,
    date: string,
    product: string,
    productSource: string,
  ): Promise<Chunk[]>;
}
export interface DocumentAssessmentDependencies extends AssessmentDependencies {
  clauses: AssessmentClausePort;
  agents?: AssessmentAgentPort;
  withUsageStep?<T>(step: UsageStep, work: () => Promise<T>): Promise<T>;
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
  extraction?: Awaited<ReturnType<typeof extractSanitized>>;
  rules?: ReturnType<typeof assessRules>;
  pricing?: import('../../domain/src/policy.js').PricingRow;
  clauses: Chunk[];
  failure?: string;
  result?: AssessmentResult;
  steps: string[];
  usageRecords: NonNullable<AssessmentResult['usageRecords']>;
  agentToolCalls: AgentToolCall[];
  stageEvents: NonNullable<AssessmentResult['stageEvents']>;
}

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
    agentToolCalls: [],
    stageEvents: [],
  };
}
function recordGenerationUsage(
  state: AssessmentState,
  model: string,
  usage: Usage,
  fallbackFrom?: string,
  operation?: 'assessment_agent_planning',
) {
  const purpose = operation ? { operation } : {};
  if (fallbackFrom)
    state.usageRecords.push({
      model: fallbackFrom,
      inputTokens: null,
      outputTokens: null,
      ...purpose,
    });
  state.usageRecords.push({
    model,
    ...usage,
    ...purpose,
    ...(fallbackFrom ? { fallbackFrom } : {}),
  });
}

function meteredGeneration(
  state: AssessmentState,
  deps: DocumentAssessmentDependencies,
  step: UsageStep,
  operation?: 'assessment_agent_planning',
): GenerationPort {
  return {
    completeStructured: async (system, data, schema) => {
      try {
        const request = () => deps.provider.completeStructured(system, data, schema);
        const response = await (deps.withUsageStep?.(step, request) ?? request());
        recordGenerationUsage(
          state,
          response.model,
          response.usage,
          response.fallbackFrom,
          operation,
        );
        return response;
      } catch (error) {
        const details = error instanceof DomainError ? error.details : {};
        recordGenerationUsage(
          state,
          typeof details.model === 'string' ? details.model : 'provider-not-reported',
          {
            inputTokens: typeof details.inputTokens === 'number' ? details.inputTokens : null,
            outputTokens: typeof details.outputTokens === 'number' ? details.outputTokens : null,
          },
          typeof details.fallbackFrom === 'string' ? details.fallbackFrom : undefined,
          operation,
        );
        throw error;
      }
    },
  };
}

const plannerStep: Record<AssessmentAgent, UsageStep> = {
  evidence: 'plan_extract_data',
  policy: 'plan_retrieve_policy_clauses',
  memo: 'plan_prepare_memo',
};

async function runAssessmentOperation<K extends AssessmentAgent, T>(
  agent: K,
  expectedInput: AssessmentAgentInputMap[K],
  state: AssessmentState,
  deps: DocumentAssessmentDependencies,
  operation: () => Promise<T> | T,
  summarizeOutput: (value: T) => AssessmentAgentOutputMap[K],
): Promise<T> {
  if (!deps.agents || state.failure) return operation();
  return deps.agents.run(
    agent,
    expectedInput,
    operation,
    summarizeOutput,
    meteredGeneration(state, deps, plannerStep[agent], 'assessment_agent_planning'),
    (call) => state.agentToolCalls.push(call),
  );
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
        if (state.evidence.missing.includes('vehicle_quotation'))
          state.evidence.referral?.citations.push('PS-9');
        break;
      }
      case 'select_policy': {
        invariant(
          (state.form!.productId ?? 'PL-100') === deps.product.id,
          'ProductMismatch',
          'Selected product does not match the application',
        );
        state.policy = selectPolicy(deps.policies, state.form!.applicationDate);
        if (state.evidence?.referral && !state.failure)
          state.failure = state.evidence.referral.reason;
        break;
      }
      case 'extract_data':
        state.extraction = await runAssessmentOperation(
          'evidence',
          {
            applicationReference: state.form!.reference,
            expectedSections: ['salary', 'bureau'],
          },
          state,
          deps,
          () =>
            extractSanitized(
              state.sanitized!,
              meteredGeneration(state, deps, 'extract_data'),
              deps.prompt,
            ),
          (extracted) => ({
            completed: true,
            verifiedFieldCount: Object.keys(extracted.fields).length,
          }),
        );
        break;
      case 'retrieve_policy_clauses': {
        state.clauses = await runAssessmentOperation(
          'policy',
          {
            policyEdition: state.policy!.edition,
            productId: state.form!.productId,
            asOfDate: state.form!.applicationDate,
          },
          state,
          deps,
          () =>
            deps.clauses.loadRequired(
              state.policy!.edition,
              state.form!.applicationDate,
              deps.product.id,
              deps.product.sourceFile,
            ),
          (loaded) => ({
            completed: true,
            clauseCount: loaded.length,
          }),
        );
        const active = state.clauses.filter(
          (clause) =>
            clause.product === deps.product.id &&
            clause.effectiveFrom <= state.form!.applicationDate &&
            (!clause.effectiveTo || state.form!.applicationDate < clause.effectiveTo),
        );
        const policyClauses = active.filter(
          (clause) =>
            clause.edition === state.policy!.edition &&
            clause.sourceFile === state.policy!.sourceFile,
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
            policyClauses.some((clause) => clause.section === section),
            'MissingPolicyClause',
            `Missing applicable ${section}`,
          );
        }
        // Guard executable configuration against drift from the indexed source.
        // Ordered operative clause first: an annex's old50% value must not
        // validate an incorrect2025 executable configuration.
        const dbr = policyClauses.find((clause) => clause.section === 'CP-4.1')!.text;
        const expected = Number(state.policy!.maxDbr) * 100;
        invariant(
          dbr.includes(`${expected}%`),
          'PolicyConfigurationMismatch',
          'DBR configuration disagrees with source',
        );
        for (const section of ['PS-3', 'PS-7', ...(deps.product.auto ? ['PS-9'] : [])]) {
          const clause = active.find(
            (candidate) =>
              candidate.sourceFile === deps.product.sourceFile && candidate.section === section,
          );
          invariant(clause, 'MissingPolicyClause', `Missing applicable ${section}`);
          if (section === 'PS-9') {
            const minimum = Number(deps.product.auto!.minimumDownPaymentPercent);
            invariant(
              clause.text.includes(`${minimum}%`),
              'PolicyConfigurationMismatch',
              'Down payment configuration disagrees with source',
            );
          }
        }
        break;
      }
      case 'calculate_and_check_rules': {
        const f = state.form!,
          x = state.extraction!.fields;
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
            vehiclePrice: f.vehiclePrice,
            downPayment: f.downPayment,
          },
          state.policy!,
          deps.product,
          () => selectPricing(deps.pricing, f.applicationDate, f.months, f.payrollTransfer),
        );
        state.pricing = 'pricing' in state.rules ? state.rules.pricing : undefined;
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
          ...(state.form
            ? {
                productId: state.form.productId,
                ...(state.form.productId === deps.product.id
                  ? { productSource: deps.product.sourceFile }
                  : {}),
              }
            : {}),
          removedFields: state.sanitized?.removedFields ?? [],
          steps: state.steps,
        };
        if (state.failure)
          state.result = {
            ...base,
            recommendation: 'REFER_TO_HUMAN',
            approvalRequiredFrom: requiredApprovalTier(null, true),
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
          const referred = r.recommendation === 'REFER_TO_HUMAN';
          const authorityAmount = referred ? state.form?.amount : r.recommendedAmount;
          state.result = {
            ...base,
            ...r,
            approvalRequiredFrom: requiredApprovalTier(authorityAmount, referred),
            extraction: state.extraction!,
            fraudReferral: false,
            status: referred
              ? 'pending_review'
              : r.recommendation === 'OFFER_ALTERNATIVE'
                ? 'pending_customer_acceptance'
                : 'pending_approval',
            pricing: state.pricing,
          };
        }
        state.result.memo = await runAssessmentOperation(
          'memo',
          {
            applicationReference: state.result.reference,
            recommendation: state.result.recommendation,
            policyEdition: state.result.policyEdition,
          },
          state,
          deps,
          () => creditMemo(state.result!, state.form),
          (rendered) => ({
            completed: true,
            lineCount: rendered.split('\n').length,
          }),
        );
        break;
      }
      case 'record_pending_review': {
        invariant(state.result, 'InvalidWorkflowState', 'Missing assessment result');
        state.result = {
          ...state.result,
          retrievedChunkIds: state.clauses.map((c) => c.id),
          usageRecords: state.usageRecords,
          stageEvents: state.stageEvents,
          ...(state.agentToolCalls.length ? { agentToolCalls: state.agentToolCalls } : {}),
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
