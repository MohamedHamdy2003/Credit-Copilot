import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EmbeddingDimensions1794916800006 implements MigrationInterface {
  async up(query: QueryRunner) {
    await query.query(`
      ALTER TABLE knowledge.embeddings DROP CONSTRAINT embeddings_pkey,
      ADD PRIMARY KEY (chunk_id, model, dimensions)
    `);
  }

  async down(query: QueryRunner) {
    // PostgreSQL rejects the downgrade if it would collapse distinct vector spaces.
    await query.query(`
      ALTER TABLE knowledge.embeddings DROP CONSTRAINT embeddings_pkey,
      ADD PRIMARY KEY (chunk_id, model)
    `);
  }
}
