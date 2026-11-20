import type { DataSource } from 'typeorm';
import type { AssessmentClausePort } from '../../../application/src/document-assessment.js';
import type { Chunk } from '../../../contracts/src/documents.js';
export class PostgresAssessmentClauses implements AssessmentClausePort {
  constructor(private readonly db: DataSource) {}
  async loadRequired(
    edition: string,
    date: string,
    product: string,
    productSource: string,
  ): Promise<Chunk[]> {
    const rows = (await this.db.query(
      `SELECT c.metadata FROM knowledge.chunks c JOIN knowledge.documents d ON d.id=c.document_id
       WHERE c.active AND c.product=$2 AND c.effective_from <= $3::date
         AND (c.effective_to IS NULL OR $3::date < c.effective_to)
         AND ((d.metadata->>'kind'='policy' AND c.edition=$1)
           OR d.metadata->>'kind'='circular'
           OR (d.metadata->>'kind'='product' AND d.filename=$4))
       ORDER BY c.document_id,c.ordinal`,
      [edition, product, date, productSource],
    )) as { metadata: Chunk }[];
    return rows.map((row) => row.metadata);
  }
}
