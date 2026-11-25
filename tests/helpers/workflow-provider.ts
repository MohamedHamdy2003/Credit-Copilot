import { FakeEmbedding } from './fake-provider.js';
import type { Completion } from '../../packages/application/src/ports.js';
import { parseEnglishDate } from '../../packages/application/src/extraction.js';

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
    const input = JSON.parse(data) as {
      question?: string;
      evidence: { text: string; chunkId?: string; section?: 'salary' | 'bureau' }[];
    };
    if (input.question)
      return {
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1 },
        value: {
          citations: /crypto|2027/i.test(input.question)
            ? []
            : [{ chunkId: input.evidence[0]!.chunkId, quote: input.evidence[0]!.text }],
        },
      };
    const field = (label: string) => {
      const entry = input.evidence.find((e) => e.text.startsWith(`${label} `))!;
      const raw = entry.text.slice(label.length + 1);
      return { value: raw.replace(/,/g, ''), quote: entry.text, section: entry.section };
    };
    const employment = field('Employment start');
    const score = field('Bureau score');
    return {
      model: 'fake',
      usage: { inputTokens: 12, outputTokens: 8 },
      value: {
        income: field('Net monthly income'),
        obligations: field('Total monthly instalments'),
        employmentStart: { ...employment, value: parseEnglishDate(employment.value) },
        bureauScore: { ...score, value: Number(score.value) },
      },
    };
  }
}
