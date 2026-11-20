import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Config } from '../../../contracts/src/config.js';
import {
  ASSESSMENT_AGENT_TOOLS,
  type AgentToolCall,
  type AssessmentAgentPort,
} from '../../../application/src/assessment-agents.js';

const agentPromptSchema = z.strictObject({
  instructions: z.string().trim().min(1),
  tasks: z.record(z.enum(['evidence', 'policy', 'memo']), z.string().trim().min(1)),
});
let agentPrompts: z.infer<typeof agentPromptSchema> | undefined;

const toolInput = z.strictObject({});
const toolReceipt = z.strictObject({ completed: z.boolean() });
type StreamV2 = Awaited<
  ReturnType<Extract<MastraModelConfig, { specificationVersion: 'v2' }>['doStream']>
>['stream'];

const mastraAssessmentAgents: AssessmentAgentPort = {
  async run(agent, operation, planner, record) {
    const toolName = ASSESSMENT_AGENT_TOOLS[agent];
    try {
      agentPrompts ??= agentPromptSchema.parse(
        JSON.parse(await readFile('prompts/assessment-agents.json', 'utf8')),
      );
    } catch {
      record({ agent, tool: toolName, status: 'fallback', reason: 'planning_failed' });
      return operation();
    }
    const { instructions, tasks } = agentPrompts;
    type Result = Awaited<ReturnType<typeof operation>>;
    let execution: Promise<{ value: Result } | { error: unknown }> | undefined;
    let toolsOpen = true;
    const tool = createTool({
      id: toolName,
      description: tasks[agent],
      inputSchema: toolInput,
      outputSchema: toolReceipt,
      execute: async () => {
        if (!toolsOpen || execution) return { completed: false };
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
    toolsOpen = false;
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
