import { z } from 'zod';
import { productIds } from '../../contracts/src/products.js';
import type { GenerationPort } from './ports.js';

export const ASSESSMENT_AGENT_TOOLS = {
  evidence: 'extract_verified_evidence',
  policy: 'read_operative_policy_clauses',
  memo: 'render_credit_memo',
} as const;

export const assessmentAgentInputSchemas = {
  evidence: z
    .object({
      applicationReference: z.string().min(1),
      expectedSections: z.array(z.enum(['salary', 'bureau'])).min(1),
    })
    .strict(),
  policy: z
    .object({
      policyEdition: z.string().min(1),
      productId: z.enum(productIds),
      asOfDate: z.iso.date(),
    })
    .strict(),
  memo: z
    .object({
      applicationReference: z.string().min(1),
      recommendation: z.enum(['APPROVE', 'DECLINE', 'REFER_TO_HUMAN', 'OFFER_ALTERNATIVE']),
      policyEdition: z.string().min(1).nullable(),
    })
    .strict(),
} as const;

export const assessmentAgentOutputSchemas = {
  evidence: z
    .object({
      completed: z.boolean(),
      verifiedFieldCount: z.number().int().nonnegative(),
    })
    .strict(),
  policy: z
    .object({
      completed: z.boolean(),
      clauseCount: z.number().int().nonnegative(),
    })
    .strict(),
  memo: z
    .object({
      completed: z.boolean(),
      lineCount: z.number().int().nonnegative(),
    })
    .strict(),
} as const;

export type AssessmentAgent = keyof typeof ASSESSMENT_AGENT_TOOLS;
export type AssessmentAgentInputMap = {
  [K in AssessmentAgent]: z.infer<(typeof assessmentAgentInputSchemas)[K]>;
};
export type AssessmentAgentOutputMap = {
  [K in AssessmentAgent]: z.infer<(typeof assessmentAgentOutputSchemas)[K]>;
};

export type AgentToolCall = {
  agent: AssessmentAgent;
  tool: (typeof ASSESSMENT_AGENT_TOOLS)[AssessmentAgent];
  status: 'executed' | 'failed' | 'fallback';
  reason?: 'invalid_call' | 'planning_failed' | 'tool_not_executed';
  input?: AssessmentAgentInputMap[AssessmentAgent];
  output?: AssessmentAgentOutputMap[AssessmentAgent];
};

export interface AssessmentAgentPort {
  run<K extends AssessmentAgent, T>(
    agent: K,
    expectedInput: AssessmentAgentInputMap[K],
    operation: () => Promise<T> | T,
    summarizeOutput: (value: T) => AssessmentAgentOutputMap[K],
    planner: GenerationPort,
    record: (call: AgentToolCall) => void,
  ): Promise<T>;
}
