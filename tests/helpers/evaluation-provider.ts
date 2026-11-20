import type { DataSource } from 'typeorm';
import type { Chunk } from '../../packages/contracts/src/documents.js';
import type { Completion } from '../../packages/application/src/ports.js';
import { parseEnglishDate } from '../../packages/application/src/extraction.js';
import { FakeEmbedding } from './fake-provider.js';
/** Deterministic fixtures for workflow/verification regressions, NEVER semantic quality evidence. */
export class OfflineEvaluationProvider extends FakeEmbedding {
  async completeStructured(_system: string, data: string): Promise<Completion> {
    const value = JSON.parse(data) as {
      question?: string;
      evidence: { text: string; chunkId?: string; section?: string }[];
    };
    if (value.question)
      return {
        model: 'test-only-evaluation',
        usage: { inputTokens: null, outputTokens: null },
        value: {
          citations: /crypto|SME|2027/i.test(value.question)
            ? []
            : value.evidence.map((e) => ({ chunkId: e.chunkId, quote: e.text })),
        },
      };
    const field = (label: string) => {
      const e = value.evidence.find((e) => e.text.startsWith(label + ' '))!;
      const raw = e.text.slice(label.length + 1);
      return { value: raw.replace(/,/g, ''), quote: e.text, section: e.section };
    };
    const employment = field('Employment start');
    return {
      model: 'test-only-evaluation',
      usage: { inputTokens: null, outputTokens: null },
      value: {
        income: field('Net monthly income'),
        obligations: field('Total monthly instalments'),
        employmentStart: { ...employment, value: parseEnglishDate(employment.value) },
        bureauScore: { ...field('Bureau score'), value: Number(field('Bureau score').value) },
      },
    };
  }
}
export function offlineEvaluationSearch(db: DataSource) {
  return {
    search: async (question: string, date: string) => {
      const sections = /crypto|SME|2027/i.test(question)
        ? []
        : /income/i.test(question)
          ? ['CP-3.3', 'PS-2', 'CP-14']
          : /72|tenor/i.test(question)
            ? ['CP-14', 'PS-3', 'C-1']
            : ['PM-1', 'PM-2'];
      const rows = (await db.query(
        "SELECT metadata FROM knowledge.chunks WHERE active AND metadata->>'section'=ANY($1) AND effective_from<=$2::date AND (effective_to IS NULL OR $2::date<effective_to) ORDER BY ordinal",
        [sections, date],
      )) as { metadata: Chunk }[];
      return rows
        .filter(
          (r) =>
            r.metadata.effectiveFrom <= date &&
            (!r.metadata.effectiveTo || date < r.metadata.effectiveTo),
        )
        .slice(0, 5)
        .map((r) => ({ chunk: r.metadata, similarity: 1 }));
    },
  };
}
