import type { GenerationPort } from './ports.js';

export const ASSESSMENT_AGENT_TOOLS = {
  evidence: 'extract_verified_evidence',
  policy: 'read_operative_policy_clauses',
  memo: 'render_credit_memo',
} as const;

export type AssessmentAgent = keyof typeof ASSESSMENT_AGENT_TOOLS;
export type AgentToolCall = {
  agent: AssessmentAgent;
  tool: (typeof ASSESSMENT_AGENT_TOOLS)[AssessmentAgent];
  status: 'executed' | 'failed' | 'fallback';
  reason?: 'invalid_call' | 'planning_failed' | 'tool_not_executed';
};

export interface AssessmentAgentPort {
  run<T>(
    agent: AssessmentAgent,
    operation: () => Promise<T> | T,
    planner: GenerationPort,
    record: (call: AgentToolCall) => void,
  ): Promise<T>;
}
