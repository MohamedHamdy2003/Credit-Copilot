import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Config } from '../../../contracts/src/config.js';
import {
  ASSESSMENT_AGENT_TOOLS,
  assessmentAgentInputSchemas,
  assessmentAgentOutputSchemas,
  type AgentToolCall,
  type AssessmentAgent,
  type AssessmentAgentInputMap,
  type AssessmentAgentOutputMap,
  type AssessmentAgentPort,
} from '../../../application/src/assessment-agents.js';

const agentPromptSchema = z.strictObject({
  instructions: z.string().trim().min(1),
  tasks: z.record(z.enum(['evidence', 'policy', 'memo']), z.string().trim().min(1)),
});
let agentPrompts: z.infer<typeof agentPromptSchema> | undefined;

type StreamV2 = Awaited<
  ReturnType<Extract<MastraModelConfig, { specificationVersion: 'v2' }>['doStream']>
>['stream'];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function failedReceipt<K extends AssessmentAgent>(agent: K): AssessmentAgentOutputMap[K] {
  if (agent === 'evidence')
    return { completed: false, verifiedFieldCount: 0 } as AssessmentAgentOutputMap[K];
  if (agent === 'policy')
    return { completed: false, clauseCount: 0 } as AssessmentAgentOutputMap[K];
  return { completed: false, lineCount: 0 } as AssessmentAgentOutputMap[K];
}

const mastraAssessmentAgents: AssessmentAgentPort = {
  async run<K extends AssessmentAgent, T>(
    agent: K,
    expectedInput: AssessmentAgentInputMap[K],
    operation: () => Promise<T> | T,
    summarizeOutput: (value: T) => AssessmentAgentOutputMap[K],
    planner: Parameters<AssessmentAgentPort['run']>[4],
    record: (call: AgentToolCall) => void,
  ): Promise<T> {
    const toolName = ASSESSMENT_AGENT_TOOLS[agent];
    const inputSchema = assessmentAgentInputSchemas[agent] as unknown as z.ZodType<
      AssessmentAgentInputMap[K]
    >;
    const outputSchema = assessmentAgentOutputSchemas[agent] as unknown as z.ZodType<
      AssessmentAgentOutputMap[K]
    >;
    const boundInput = inputSchema.parse(expectedInput);
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
    let execution:
      | Promise<{ value: Result; receipt: AssessmentAgentOutputMap[K] } | { error: unknown }>
      | undefined;
    let toolsOpen = true;
    const tool = createTool({
      id: toolName,
      description: tasks[agent],
      inputSchema,
      outputSchema,
      execute: async (receivedInput): Promise<AssessmentAgentOutputMap[K]> => {
        if (!toolsOpen || execution || canonicalJson(receivedInput) !== canonicalJson(boundInput)) {
          return failedReceipt(agent);
        }
        const pending = Promise.resolve().then(async () => {
          try {
            const value = await operation();
            const receipt = outputSchema.parse(summarizeOutput(value));
            return { value, receipt };
          } catch (error) {
            return { error };
          }
        });
        execution = pending;
        // Raw customer records remain on the server; the runner receives a typed receipt.
        const outcome = await pending;
        return 'receipt' in outcome && outcome.receipt !== undefined
          ? outcome.receipt
          : failedReceipt(agent);
      },
    });
    const callSchema = z.strictObject({ tool: z.literal(toolName), arguments: inputSchema });
    const task = JSON.stringify({
      assessmentAgent: agent,
      tool: toolName,
      task: tasks[agent],
      expectedArguments: boundInput,
    });
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
        if (parsed.success) {
          const toolCall = parsed.data as {
            tool: (typeof ASSESSMENT_AGENT_TOOLS)[K];
            arguments: AssessmentAgentInputMap[K];
          };
          if (canonicalJson(toolCall.arguments) === canonicalJson(boundInput)) {
            return {
              content: [
                {
                  type: 'tool-call' as const,
                  toolCallId: randomUUID(),
                  toolName: toolCall.tool,
                  input: JSON.stringify(toolCall.arguments),
                },
              ],
              finishReason: 'tool-calls' as const,
              usage,
              warnings: [],
            };
          }
        }
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
      record({
        agent,
        tool: toolName,
        status: 'value' in outcome ? 'executed' : 'failed',
        input: boundInput,
        ...('receipt' in outcome ? { output: outcome.receipt } : {}),
      });
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
