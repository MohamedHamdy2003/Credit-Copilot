import type { DataSource } from 'typeorm';
import type { AssessmentClausePort } from '../../../application/src/document-assessment.js';
import type { Chunk } from '../../../contracts/src/documents.js';
export class PostgresAssessmentClauses implements AssessmentClausePort {
  constructor(private readonly db: DataSource) {}
  async loadRequired(edition: string, date: string, product: string): Promise<Chunk[]> {
    const rows = (await this.db.query(
      'SELECT metadata FROM knowledge.chunks WHERE active AND edition=$1 AND product=$2 AND effective_from <= $3::date AND (effective_to IS NULL OR $3::date < effective_to) ORDER BY ordinal',
      [edition, product, date],
    )) as { metadata: Chunk }[];
    return rows.map((row) => row.metadata);
  }
}
