import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { DocumentMetadata } from '../../../contracts/src/documents.js';
import type { EmbeddingPort } from '../../../application/src/ports.js';
import { DomainError, invariant } from '../../../domain/src/errors.js';
import { ParserRegistry } from '../parsers/registry.js';
import { chunkDocument, CHUNKER_VERSION } from '../parsers/chunker.js';
import { extractPricing } from '../parsers/pricing.js';

export interface ManifestEntry extends DocumentMetadata {
  filename: string;
  sha256: string;
}
export class IngestionService {
  constructor(
    private readonly db: DataSource,
    private readonly embeddings: EmbeddingPort,
    private readonly manifest: ManifestEntry[],
    private readonly parsers = new ParserRegistry(),
  ) {}
  async ingest(filename: string, bytes: Uint8Array) {
    const attempt = randomUUID();
    await this.db.query(
      'INSERT INTO knowledge.ingestion_attempts(id,filename,status) VALUES($1,$2,$3)',
      [attempt, filename, 'processing'],
    );
    try {
      const document = await this.parsers.extract(filename, bytes);
      const metadata = this.manifest.find(
        (entry) => entry.filename === filename && entry.sha256 === document.hash,
      );
      invariant(
        metadata,
        'UntrustedPolicyDocument',
        'Only reviewed manifest documents may enter the policy knowledge base',
        403,
      );
      const chunks = chunkDocument(document, metadata);
      const pricing = metadata.kind === 'pricing' ? extractPricing(document) : [];
      const existing = (await this.db.query(
        'SELECT hash,pipeline_version FROM knowledge.documents WHERE id=$1',
        [metadata.id],
      )) as { hash: string; pipeline_version: string }[];
      invariant(
        !existing.length || existing[0]!.hash === document.hash,
        'DocumentVersionConflict',
        'Document version already exists with different content',
        409,
      );
      const missing = (await this.db.query(
        'SELECT c.id FROM knowledge.chunks c LEFT JOIN knowledge.embeddings e ON e.chunk_id=c.id AND e.model=$2 WHERE c.document_id=$1 AND c.active AND e.chunk_id IS NULL',
        [metadata.id, this.embeddings.model],
      )) as { id: string }[];
      if (existing[0]?.pipeline_version === CHUNKER_VERSION && missing.length === 0) {
        await this.db.query('UPDATE knowledge.ingestion_attempts SET status=$2 WHERE id=$1', [
          attempt,
          'skipped',
        ]);
        return { id: attempt, filename, status: 'skipped', chunks: chunks.length };
      }
      const vectors: number[][] = [];
      for (const chunk of chunks) vectors.push(await this.embeddings.embed(chunk.text, 'document'));
      await this.db.transaction(async (manager) => {
        // Serialize concurrent ingestion for this logical document, then recheck conflicts.
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [metadata.id]);
        const current = (await manager.query('SELECT hash FROM knowledge.documents WHERE id=$1', [
          metadata.id,
        ])) as { hash: string }[];
        invariant(
          !current.length || current[0]!.hash === document.hash,
          'DocumentVersionConflict',
          'Concurrent content conflict',
          409,
        );
        await manager.query(
          'INSERT INTO knowledge.documents(id,filename,hash,metadata,normalized) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
          [metadata.id, filename, document.hash, metadata, document],
        );
        await manager.query(
          'INSERT INTO knowledge.index_revisions(document_id,pipeline_version,source_hash,normalized,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [metadata.id, CHUNKER_VERSION, document.hash, document, metadata],
        );
        await manager.query('UPDATE knowledge.chunks SET active=false WHERE document_id=$1', [
          metadata.id,
        ]);
        for (const [index, chunk] of chunks.entries()) {
          const vector = vectors[index]!;
          invariant(
            vector.length === this.embeddings.dimensions && vector.every(Number.isFinite),
            'EmbeddingFailure',
            'Invalid vector',
          );
          await manager.query(
            'INSERT INTO knowledge.chunks(id,document_id,ordinal,text,metadata,edition,product,effective_from,effective_to,pipeline_version,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) ON CONFLICT(id) DO UPDATE SET active=true',
            [
              chunk.id,
              metadata.id,
              chunk.ordinal,
              chunk.text,
              chunk,
              chunk.edition,
              chunk.product,
              chunk.effectiveFrom,
              chunk.effectiveTo,
              CHUNKER_VERSION,
            ],
          );
          await manager.query(
            'INSERT INTO knowledge.embeddings(chunk_id,model,dimensions,embedding) VALUES($1,$2,$3,$4::vector) ON CONFLICT(chunk_id,model) DO NOTHING',
            [chunk.id, this.embeddings.model, this.embeddings.dimensions, JSON.stringify(vector)],
          );
        }
        await manager.query('UPDATE knowledge.documents SET pipeline_version=$2 WHERE id=$1', [
          metadata.id,
          CHUNKER_VERSION,
        ]);
        for (const row of pricing)
          await manager.query(
            'INSERT INTO knowledge.pricing(document_id,row_number,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [metadata.id, row.row, row],
          );
        await manager.query('UPDATE knowledge.ingestion_attempts SET status=$2 WHERE id=$1', [
          attempt,
          'succeeded',
        ]);
      });
      return { id: attempt, filename, status: 'succeeded', chunks: chunks.length };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'IngestionFailed';
      await this.db.query(
        'UPDATE knowledge.ingestion_attempts SET status=$2,error_code=$3 WHERE id=$1',
        [attempt, 'failed', code],
      );
      throw error instanceof DomainError
        ? error
        : new DomainError(code, 'Document ingestion failed');
    }
  }
}
