import type { DataSource } from 'typeorm';
import type { Chunk } from '../../../contracts/src/documents.js';
import type { EmbeddingPort } from '../../../application/src/ports.js';
import { validDate } from '../../../domain/src/calculations.js';
export interface SearchHit {
  chunk: Chunk;
  similarity: number;
}
export class RetrievalService {
  constructor(
    private readonly db: DataSource,
    private readonly embeddings: EmbeddingPort,
  ) {}
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
      WHERE c.product=$2 AND c.effective_from <= $3::date AND (c.effective_to IS NULL OR $3::date < c.effective_to)
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
