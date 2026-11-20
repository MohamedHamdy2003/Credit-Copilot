import type { DataSource } from 'typeorm';
import type { Chunk } from '../../../contracts/src/documents.js';
import type { EmbeddingPort } from '../../../application/src/ports.js';
import { validDate } from '../../../domain/src/calculations.js';
import { isApprovalBypass } from '../../../application/src/questions.js';
export interface SearchHit {
  chunk: Chunk;
  similarity: number;
}
export class RetrievalService {
  constructor(
    private readonly db: DataSource,
    private readonly embeddings: EmbeddingPort,
  ) {}
  async related(question: string, date: string, product: string, hits: SearchHit[]) {
    const approval =
      isApprovalBypass(question) &&
      hits.some(
        (h) => h.chunk.documentId.startsWith('PM-') && ['PM-1', 'PM-2'].includes(h.chunk.section),
      );
    const income =
      /\bincome\b|minimum salary/i.test(question) &&
      hits.some((h) => ['CP-3.3', 'PS-2'].includes(h.chunk.section));
    const tenor =
      /\btenor\b|\bmonths\b/i.test(question) &&
      hits.some((h) => ['CP-14', 'PS-3', 'C-1'].includes(h.chunk.section));
    if (!income && !tenor && !approval) return { chunks: [], reason: 'No linked source context' };
    const sections = approval
      ? ['PM-1', 'PM-2', 'PM-3']
      : income
        ? ['CP-3.3', 'PS-2', 'CP-14']
        : ['CP-14', 'PS-3', 'C-1'];
    const rows = (await this.db.query(
      "SELECT c.metadata AS chunk FROM knowledge.chunks c JOIN knowledge.documents d ON d.id=c.document_id WHERE c.active AND c.product=$1 AND c.effective_from<=$2::date AND (c.effective_to IS NULL OR $2::date<c.effective_to) AND c.metadata->>'section'=ANY($3) AND d.metadata->>'kind'=ANY($4) ORDER BY c.ordinal,c.id",
      [product, date, sections, ['policy', 'product', 'circular', 'procedure']],
    )) as { chunk: Chunk }[];
    const chunks: Chunk[] = [];
    for (const section of sections) {
      const chunk = rows.find((r) => r.chunk.section === section)?.chunk;
      if (chunk) chunks.push(chunk);
    }
    return {
      chunks,
      reason: approval
        ? 'Read-only human approval boundary'
        : income
          ? 'Operative income, product eligibility and policy precedence'
          : 'Operative product tenor, regulator condition and policy precedence',
    };
  }
  async search(
    question: string,
    date: string,
    product = 'PL-100',
    limit = 5,
  ): Promise<SearchHit[]> {
    validDate(date);
    const vector = await this.embeddings.embed(question, 'query');
    const rows = (await this.db.query(
      `SELECT c.metadata AS chunk, 1-(e.embedding <=> $1::vector) AS similarity
      FROM knowledge.chunks c JOIN knowledge.embeddings e ON e.chunk_id=c.id
      WHERE c.active AND c.product=$2 AND c.effective_from <= $3::date AND (c.effective_to IS NULL OR $3::date < c.effective_to)
      AND e.model=$4 AND e.dimensions=$5
      ORDER BY e.embedding <=> $1::vector, c.id LIMIT $6`,
      [
        JSON.stringify(vector),
        product,
        date,
        this.embeddings.model,
        this.embeddings.dimensions,
        Math.max(1, Math.min(limit, 20)),
      ],
    )) as SearchHit[];
    return rows;
  }
}
