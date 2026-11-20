import { randomUUID } from 'node:crypto';
import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Config } from '../../../contracts/src/config.js';
import {
  ASSESSMENT_AGENT_TOOLS,
  type AgentToolCall,
  type AssessmentAgent,
  type AssessmentAgentPort,
} from '../../../application/src/assessment-agents.js';

const tasks: Record<AssessmentAgent, string> = {
  evidence: 'Extract and verify the allowlisted evidence prepared for this assessment.',
  policy: 'Read the trusted policy clauses for the server-selected edition, date and product.',
  memo: 'Render the credit memo from the verified assessment and code-calculated results.',
};

const toolInput = z.strictObject({});
const toolReceipt = z.strictObject({ completed: z.boolean() });
type StreamV2 = Awaited<
  ReturnType<Extract<MastraModelConfig, { specificationVersion: 'v2' }>['doStream']>
>['stream'];

const mastraAssessmentAgents: AssessmentAgentPort = {
  async run(agent, operation, planner, record) {
    const toolName = ASSESSMENT_AGENT_TOOLS[agent];
    type Result = Awaited<ReturnType<typeof operation>>;
    let execution: Promise<{ value: Result } | { error: unknown }> | undefined;
    const tool = createTool({
      id: toolName,
      description: tasks[agent],
      inputSchema: toolInput,
      outputSchema: toolReceipt,
      execute: async () => {
        if (execution) return { completed: false };
        const pending = Promise.resolve().then(async () => {
          try {
            return { value: await operation() };
          } catch (error) {
            return { error };
          }
        });
        execution = pending;
        // Tool data remains on the server. The model runner receives a receipt.
        return { completed: 'value' in (await pending) };
      },
    });
    const callSchema = z.strictObject({ tool: z.literal(toolName), arguments: toolInput });
    const instructions =
      'Request exactly one tool by returning a JSON object with only tool and arguments. ' +
      'Use the tool name provided and an empty arguments object {}. The server supplies all data.';
    const task = JSON.stringify({ assessmentAgent: agent, tool: toolName, task: tasks[agent] });
    let planned = false;
    let reason: AgentToolCall['reason'] = 'tool_not_executed';
    const translate = async () => {
      if (planned)
        return {
          content: [],
          finishReason: 'stop' as const,
          usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
          warnings: [],
        };
      planned = true;
      try {
        const completion = await planner.completeStructured(
          instructions,
          task,
          z.toJSONSchema(callSchema),
        );
        const parsed = callSchema.safeParse(completion.value);
        const usage = {
          inputTokens: completion.usage.inputTokens ?? undefined,
          outputTokens: completion.usage.outputTokens ?? undefined,
          totalTokens: undefined,
        };
        if (parsed.success)
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: randomUUID(),
                toolName: parsed.data.tool,
                input: JSON.stringify(parsed.data.arguments),
              },
            ],
            finishReason: 'tool-calls' as const,
            usage,
            warnings: [],
          };
        reason = 'invalid_call';
        return { content: [], finishReason: 'stop' as const, usage, warnings: [] };
      } catch {
        reason = 'planning_failed';
        return {
          content: [],
          finishReason: 'stop' as const,
          usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
          warnings: [],
        };
      }
    };
    const model = {
      specificationVersion: 'v2',
      provider: 'credit-copilot',
      modelId: 'assessment-tool-planner',
      supportedUrls: {},
      doGenerate: translate,
      doStream: async () => {
        const response = await translate();
        const stream: StreamV2 = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            for (const item of response.content) controller.enqueue(item);
            controller.enqueue({
              type: 'finish',
              finishReason: response.finishReason,
              usage: response.usage,
            });
            controller.close();
          },
        });
        return { stream };
      },
    } satisfies MastraModelConfig;
    const runner = new Agent({
      id: `credit-${agent}`,
      name: `Credit ${agent} agent`,
      instructions,
      model,
      maxRetries: 0,
      tools: { [toolName]: tool },
    });
    try {
      await runner.generate(task, { maxSteps: 1, toolChoice: 'required' });
    } catch {
      // A runner failure before tool execution leaves the baseline operation available.
    }
    const outcome = await execution;
    if (outcome) {
      record({ agent, tool: toolName, status: 'value' in outcome ? 'executed' : 'failed' });
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    }
    record({ agent, tool: toolName, status: 'fallback', reason });
    return operation();
  },
};

export function assessmentAgents(mode: Config['ASSESSMENT_ORCHESTRATION']) {
  return mode === 'agents' ? mastraAssessmentAgents : undefined;
}
