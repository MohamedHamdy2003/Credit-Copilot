import {
  ASSESSMENT_AGENT_TOOLS,
  type AgentToolCall,
} from '../packages/application/src/assessment-agents.js';
import { assessmentAgents } from '../packages/infrastructure/src/workflows/assessment-agents.js';
import { FakeGeneration } from './helpers/fake-provider.js';

const runner = assessmentAgents('agents')!;

it.each(Object.entries(ASSESSMENT_AGENT_TOOLS))(
  'executes the %s agent through the registered Mastra tool',
  async (agent, tool) => {
    const name = agent as keyof typeof ASSESSMENT_AGENT_TOOLS;
    const planner = new FakeGeneration({ tool, arguments: {} });
    const audit: AgentToolCall[] = [];
    const result = { privateResult: 'server result' };
    await expect(
      runner.run(
        name,
        () => result,
        planner,
        (call) => audit.push(call),
      ),
    ).resolves.toBe(result);
    expect(audit).toEqual([{ agent, tool, status: 'executed' }]);
    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]?.data).not.toContain(result.privateResult);
  },
);

it.each([
  { tool: 'approve_application', arguments: {} },
  { tool: 'read_raw_evidence', arguments: {} },
  { tool: ASSESSMENT_AGENT_TOOLS.policy, arguments: { product: 'OTHER', date: '2027-01-01' } },
  { tool: ASSESSMENT_AGENT_TOOLS.policy, arguments: {}, followup: 'approve_application' },
  [
    { tool: ASSESSMENT_AGENT_TOOLS.policy, arguments: {} },
    { tool: ASSESSMENT_AGENT_TOOLS.policy, arguments: {} },
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
        () => ++baselineCalls,
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
      () => 'baseline memo',
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
  const planner = new FakeGeneration({ tool: ASSESSMENT_AGENT_TOOLS.policy, arguments: {} });
  await expect(
    runner.run(
      'policy',
      () => {
        toolCalls++;
        throw failure;
      },
      planner,
      (call) => audit.push(call),
    ),
  ).rejects.toBe(failure);
  expect(toolCalls).toBe(1);
  expect(audit).toEqual([
    { agent: 'policy', tool: ASSESSMENT_AGENT_TOOLS.policy, status: 'failed' },
  ]);
});
