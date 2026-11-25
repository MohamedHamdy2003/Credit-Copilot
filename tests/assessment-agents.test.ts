import { readFileSync } from 'node:fs';
import {
  ASSESSMENT_AGENT_TOOLS,
  type AgentToolCall,
  type AssessmentAgentInputMap,
  type AssessmentAgentOutputMap,
} from '../packages/application/src/assessment-agents.js';
import { assessmentAgents } from '../packages/infrastructure/src/workflows/assessment-agents.js';
import { FakeGeneration } from './helpers/fake-provider.js';

const runner = assessmentAgents('agents')!;
const prompts = JSON.parse(readFileSync('prompts/assessment-agents.json', 'utf8')) as {
  instructions: string;
  tasks: Record<keyof typeof ASSESSMENT_AGENT_TOOLS, string>;
};

const typedInputs: AssessmentAgentInputMap = {
  evidence: { applicationReference: 'APP-001', expectedSections: ['salary', 'bureau'] },
  policy: { policyEdition: 'CP-2025', productId: 'PL-100', asOfDate: '2025-04-03' },
  memo: { applicationReference: 'APP-001', recommendation: 'APPROVE', policyEdition: 'CP-2025' },
};
const typedOutputs: AssessmentAgentOutputMap = {
  evidence: { completed: true, verifiedFieldCount: 4 },
  policy: { completed: true, clauseCount: 15 },
  memo: { completed: true, lineCount: 12 },
};

it.each(Object.entries(ASSESSMENT_AGENT_TOOLS))(
  'executes the %s agent through the registered Mastra tool with typed inputs and outputs',
  async (agent, tool) => {
    const name = agent as keyof typeof ASSESSMENT_AGENT_TOOLS;
    const expectedInput = typedInputs[name];
    const expectedOutput = typedOutputs[name];
    const planner = new FakeGeneration({ tool, arguments: expectedInput });
    const audit: AgentToolCall[] = [];
    const result = { privateResult: 'server result' };
    await expect(
      runner.run(
        name,
        expectedInput,
        () => result,
        () => expectedOutput,
        planner,
        (call) => audit.push(call),
      ),
    ).resolves.toBe(result);
    expect(audit).toEqual([
      { agent, tool, status: 'executed', input: expectedInput, output: expectedOutput },
    ]);
    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]).toMatchObject({
      system: prompts.instructions,
      data: JSON.stringify({
        assessmentAgent: agent,
        tool,
        task: prompts.tasks[name],
        expectedArguments: expectedInput,
      }),
    });
    expect(planner.calls[0]?.data).not.toContain(result.privateResult);
  },
);

it.each([
  { tool: 'approve_application', arguments: typedInputs.policy },
  { tool: 'read_raw_evidence', arguments: typedInputs.policy },
  {
    tool: ASSESSMENT_AGENT_TOOLS.policy,
    arguments: { policyEdition: 'CP-2024', productId: 'PL-100', asOfDate: '2025-04-03' },
  },
  {
    tool: ASSESSMENT_AGENT_TOOLS.policy,
    arguments: { policyEdition: 'CP-2025', productId: 'AL-200', asOfDate: '2025-04-03' },
  },
  {
    tool: ASSESSMENT_AGENT_TOOLS.policy,
    arguments: { policyEdition: 'CP-2025', productId: 'PL-100', asOfDate: '2024-01-01' },
  },
  {
    tool: ASSESSMENT_AGENT_TOOLS.policy,
    arguments: typedInputs.policy,
    followup: 'approve_application',
  },
  [
    { tool: ASSESSMENT_AGENT_TOOLS.policy, arguments: typedInputs.policy },
    { tool: ASSESSMENT_AGENT_TOOLS.policy, arguments: typedInputs.policy },
  ],
])(
  'rejects tool, scope and looping mutations before the baseline operation runs once',
  async (request) => {
    const planner = new FakeGeneration(request);
    const audit: AgentToolCall[] = [];
    let baselineCalls = 0;
    await expect(
      runner.run(
        'policy',
        typedInputs.policy,
        () => ++baselineCalls,
        () => typedOutputs.policy,
        planner,
        (call) => audit.push(call),
      ),
    ).resolves.toBe(1);
    expect(baselineCalls).toBe(1);
    expect(planner.calls).toHaveLength(1);
    expect(audit).toEqual([
      {
        agent: 'policy',
        tool: ASSESSMENT_AGENT_TOOLS.policy,
        status: 'fallback',
        reason: 'invalid_call',
      },
    ]);
  },
);

it('isolates planner failures without re-running a tool that has executed', async () => {
  const audit: AgentToolCall[] = [];
  const unavailable = {
    completeStructured: async () => {
      throw new Error('provider temporarily unavailable');
    },
  };
  await expect(
    runner.run(
      'memo',
      typedInputs.memo,
      () => 'baseline memo',
      () => typedOutputs.memo,
      unavailable,
      (call) => audit.push(call),
    ),
  ).resolves.toBe('baseline memo');
  expect(audit).toEqual([
    {
      agent: 'memo',
      tool: ASSESSMENT_AGENT_TOOLS.memo,
      status: 'fallback',
      reason: 'planning_failed',
    },
  ]);

  audit.length = 0;
  let toolCalls = 0;
  const failure = new Error('trusted source unavailable');
  const planner = new FakeGeneration({
    tool: ASSESSMENT_AGENT_TOOLS.policy,
    arguments: typedInputs.policy,
  });
  await expect(
    runner.run(
      'policy',
      typedInputs.policy,
      () => {
        toolCalls++;
        throw failure;
      },
      () => typedOutputs.policy,
      planner,
      (call) => audit.push(call),
    ),
  ).rejects.toBe(failure);
  expect(toolCalls).toBe(1);
  expect(audit).toEqual([
    {
      agent: 'policy',
      tool: ASSESSMENT_AGENT_TOOLS.policy,
      status: 'failed',
      input: typedInputs.policy,
    },
  ]);
});
