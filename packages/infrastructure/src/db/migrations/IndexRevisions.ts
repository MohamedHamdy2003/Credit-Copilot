import type { MigrationInterface, QueryRunner } from 'typeorm';
export class IndexRevisions1794916800001 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`
      ALTER TABLE knowledge.documents ADD COLUMN pipeline_version text NOT NULL DEFAULT 'legacy-v1';
      ALTER TABLE knowledge.chunks ADD COLUMN pipeline_version text NOT NULL DEFAULT 'legacy-v1';
      ALTER TABLE knowledge.chunks ADD COLUMN active boolean NOT NULL DEFAULT true;
      ALTER TABLE knowledge.chunks DROP CONSTRAINT chunks_document_id_ordinal_key;
      ALTER TABLE knowledge.chunks ADD UNIQUE(document_id,pipeline_version,ordinal);
      CREATE TABLE knowledge.index_revisions (
        document_id text NOT NULL REFERENCES knowledge.documents(id), pipeline_version text NOT NULL,
        source_hash text NOT NULL, normalized jsonb NOT NULL, metadata jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(document_id,pipeline_version)
      );
      INSERT INTO knowledge.index_revisions(document_id,pipeline_version,source_hash,normalized,metadata)
        SELECT id,pipeline_version,hash,normalized,metadata FROM knowledge.documents;
    `);
  }
  async down(q: QueryRunner) {
    const rows = (await q.query(
      'SELECT document_id FROM knowledge.index_revisions GROUP BY document_id HAVING count(*)>1',
    )) as unknown[];
    if (rows.length)
      throw new Error('Rollback would discard historical citations; forward migration required');
    await q.query(`DROP TABLE knowledge.index_revisions;
      ALTER TABLE knowledge.chunks DROP CONSTRAINT chunks_document_id_pipeline_version_ordinal_key;
      ALTER TABLE knowledge.chunks DROP COLUMN active;
      ALTER TABLE knowledge.chunks DROP COLUMN pipeline_version;
      ALTER TABLE knowledge.documents DROP COLUMN pipeline_version;
      ALTER TABLE knowledge.chunks ADD UNIQUE(document_id,ordinal);`);
  }
}
