import { FakeEmbedding } from './fake-provider.js';
import type { Completion } from '../../packages/application/src/ports.js';
export class WorkflowTestProvider extends FakeEmbedding {
  gate?: Promise<void>;
  onGeneration?: () => void;
  texts: string[] = [];
  override async embed(text: string) {
    this.texts.push(text);
    return super.embed(text);
  }
  async completeStructured(_system: string, data: string): Promise<Completion> {
    this.onGeneration?.();
    await this.gate;
    this.texts.push(data);
    const input = JSON.parse(data);
    if (input.question)
      return {
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1 },
        value: {
          citations: input.question.includes('crypto')
            ? []
            : [{ chunkId: input.evidence[0].chunkId, quote: input.evidence[0].text }],
        },
      };
    return {
      model: 'fake',
      usage: { inputTokens: 12, outputTokens: 8 },
      value: {
        income: { value: '30000.00', quote: 'Net monthly income 30,000.00', section: 'salary' },
        obligations: {
          value: '4000.00',
          quote: 'Total monthly instalments 4,000.00',
          section: 'bureau',
        },
        employmentStart: {
          value: '2019-09-01',
          quote: 'Employment start 1 September 2019',
          section: 'salary',
        },
        bureauScore: { value: 712, quote: 'Bureau score 712', section: 'bureau' },
      },
    };
  }
}
