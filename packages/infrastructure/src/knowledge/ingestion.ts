import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
  customPolicyMetadataSchema,
  type CustomPolicyMetadata,
  type DocumentMetadata,
  type NormalizedDocument,
} from '../../../contracts/src/documents.js';
import type { IngestionStage } from '../../../contracts/src/streams.js';
import type { EmbeddingPort } from '../../../application/src/ports.js';
import { DomainError, invariant } from '../../../domain/src/errors.js';
import { ParserRegistry } from '../parsers/registry.js';
import { chunkDocument, CHUNKER_VERSION } from '../parsers/chunker.js';
import { extractPricing } from '../parsers/pricing.js';

export interface ManifestEntry extends DocumentMetadata {
  filename: string;
  sha256: string;
}

export interface IngestionStageStatus {
  stage: IngestionStage;
  status: 'running' | 'completed' | 'skipped' | 'failed';
  detail?: string;
  current?: number;
  total?: number;
}

export interface IngestionOptions {
  customMetadata?: CustomPolicyMetadata;
  onProgress?: (event: IngestionStageStatus) => void;
}

function slug(value: string, max: number) {
  return (
    value
      .replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'DOC'
  );
}

function looksLikeCustomerPack(filename: string, document: NormalizedDocument) {
  if (/^(?:APP|AUTO)-\d+/i.test(filename.trim())) return true;
  const fullText = document.blocks.map((block) => block.text).join('\n');
  const hasApplicationRef = /\bapplication reference\b/i.test(fullText);
  const hasCustomerEvidence =
    /\bsalary certificate\b/i.test(fullText) ||
    /\bcredit bureau summary\b/i.test(fullText) ||
    /\bnational id\b/i.test(fullText);
  return hasApplicationRef && hasCustomerEvidence;
}

function resolveCustomMetadata(
  filename: string,
  raw: CustomPolicyMetadata,
): DocumentMetadata & { sourceOrigin: 'custom' } {
  const parsed = customPolicyMetadataSchema.parse(raw);
  const id = parsed.id ?? `CUSTOM-${slug(parsed.edition, 18)}-${slug(filename, 36)}`.slice(0, 64);
  return {
    id,
    edition: parsed.edition,
    effectiveFrom: parsed.effectiveFrom,
    effectiveTo: parsed.effectiveTo ?? null,
    product: parsed.product,
    kind: parsed.kind,
    sourceOrigin: 'custom',
  };
}

export class IngestionService {
  constructor(
    private readonly db: DataSource,
    private readonly embeddings: EmbeddingPort,
    private readonly manifest: ManifestEntry[],
    private readonly parsers = new ParserRegistry(),
    private readonly excludedHashes: ReadonlySet<string> = new Set(),
  ) {}

  async ingest(filename: string, bytes: Uint8Array, mime?: string, options?: IngestionOptions) {
    const attempt = randomUUID();
    const stages: IngestionStageStatus[] = [];
    let currentStage: IngestionStage = 'extract';
    const report = (event: IngestionStageStatus) => {
      currentStage = event.stage;
      const existingIndex = stages.findIndex((entry) => entry.stage === event.stage);
      if (existingIndex >= 0) stages[existingIndex] = event;
      else stages.push(event);
      options?.onProgress?.(event);
    };
    await this.db.query(
      'INSERT INTO knowledge.ingestion_attempts(id,filename,status) VALUES($1,$2,$3)',
      [attempt, filename, 'processing'],
    );
    try {
      report({ stage: 'extract', status: 'running', detail: `Extracting ${filename}` });
      const document = await this.parsers.extract(filename, bytes, mime);
      invariant(
        !this.excludedHashes.has(document.hash) && !looksLikeCustomerPack(filename, document),
        'UntrustedPolicyDocument',
        'Customer application packs are not in the reviewed policy manifest and may never enter the policy knowledge base',
        403,
      );
      const manifestMatch = this.manifest.find(
        (entry) => entry.filename === filename && entry.sha256 === document.hash,
      );
      const metadata: DocumentMetadata & { sourceOrigin?: 'manifest' | 'custom' } = manifestMatch
        ? { ...manifestMatch, sourceOrigin: 'manifest' }
        : options?.customMetadata
          ? resolveCustomMetadata(filename, options.customMetadata)
          : (() => {
              throw new DomainError(
                'UntrustedPolicyDocument',
                'Only reviewed manifest documents or explicitly tagged custom policies may enter the policy knowledge base',
                403,
              );
            })();
      const pageNumbers = document.blocks
        .map((block) => block.page)
        .filter((page): page is number => page !== null);
      const maxPage = pageNumbers.length ? Math.max(...pageNumbers) : null;
      report({
        stage: 'extract',
        status: 'completed',
        detail: maxPage
          ? `${document.format.toUpperCase()} · ${maxPage} page(s) · ${document.blocks.length} block(s)`
          : `${document.format.toUpperCase()} · ${document.blocks.length} block(s)`,
      });

      report({ stage: 'chunk', status: 'running', detail: `Chunking (${CHUNKER_VERSION})` });
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
      report({
        stage: 'chunk',
        status: 'completed',
        detail: `${chunks.length} chunk(s) (${CHUNKER_VERSION})`,
      });

      const indexed = (await this.db.query(
        'SELECT c.id FROM knowledge.chunks c JOIN knowledge.embeddings e ON e.chunk_id=c.id WHERE c.document_id=$1 AND e.model=$2 AND e.dimensions=$3 AND c.active AND c.id=ANY($4)',
        [
          metadata.id,
          this.embeddings.model,
          this.embeddings.dimensions,
          chunks.map((chunk) => chunk.id),
        ],
      )) as { id: string }[];
      if (existing[0]?.pipeline_version === CHUNKER_VERSION && indexed.length === chunks.length) {
        report({
          stage: 'embed',
          status: 'skipped',
          detail: `Reusing ${chunks.length} existing embedding(s)`,
        });
        report({
          stage: 'index',
          status: 'skipped',
          detail: `Already indexed as ${metadata.id}`,
        });
        await this.db.query('UPDATE knowledge.ingestion_attempts SET status=$2 WHERE id=$1', [
          attempt,
          'skipped',
        ]);
        return {
          id: attempt,
          documentId: metadata.id,
          filename,
          status: 'skipped' as const,
          chunks: chunks.length,
          stages,
        };
      }

      const vectors: number[][] = [];
      report({
        stage: 'embed',
        status: 'running',
        detail: `Embedding 0 of ${chunks.length} chunk(s)`,
        current: 0,
        total: chunks.length,
      });
      for (const [index, chunk] of chunks.entries()) {
        vectors.push(await this.embeddings.embed(chunk.text, 'document'));
        report({
          stage: 'embed',
          status: 'running',
          detail: `Embedded ${index + 1} of ${chunks.length} chunk(s)`,
          current: index + 1,
          total: chunks.length,
        });
      }
      report({
        stage: 'embed',
        status: 'completed',
        detail: `${vectors.length} vector(s) · ${this.embeddings.dimensions}d`,
        current: chunks.length,
        total: chunks.length,
      });

      report({
        stage: 'index',
        status: 'running',
        detail: `Committing ${chunks.length} chunk(s) to knowledge.*`,
      });
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
            'INSERT INTO knowledge.embeddings(chunk_id,model,dimensions,embedding) VALUES($1,$2,$3,$4::vector) ON CONFLICT(chunk_id,model,dimensions) DO NOTHING',
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
      report({
        stage: 'index',
        status: 'completed',
        detail: `Indexed ${chunks.length} chunk(s) as ${metadata.id}`,
      });
      return {
        id: attempt,
        documentId: metadata.id,
        filename,
        status: 'succeeded' as const,
        chunks: chunks.length,
        stages,
      };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'IngestionFailed';
      report({
        stage: currentStage,
        status: 'failed',
        detail: error instanceof DomainError ? error.message : 'Document ingestion failed',
      });
      await this.db.query(
        'UPDATE knowledge.ingestion_attempts SET status=$2,error_code=$3 WHERE id=$1',
        [attempt, 'failed', code],
      );
      throw error instanceof DomainError
        ? error
        : new DomainError(code, 'Document ingestion failed');
    }
  }

  async deleteDocument(documentId: string) {
    const id = documentId.trim();
    invariant(id.length > 0 && id.length <= 64, 'InvalidDocumentId', 'Valid document ID required');
    return this.db.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
      const rows = (await manager.query(
        'SELECT id, filename FROM knowledge.documents WHERE id=$1',
        [id],
      )) as { id: string; filename: string }[];
      const doc = rows[0];
      invariant(doc, 'NotFound', 'Policy document not found', 404);
      await manager.query(
        'DELETE FROM knowledge.embeddings WHERE chunk_id IN (SELECT id FROM knowledge.chunks WHERE document_id=$1)',
        [id],
      );
      await manager.query('DELETE FROM knowledge.chunks WHERE document_id=$1', [id]);
      await manager.query('DELETE FROM knowledge.index_revisions WHERE document_id=$1', [id]);
      await manager.query('DELETE FROM knowledge.pricing WHERE document_id=$1', [id]);
      await manager.query('DELETE FROM knowledge.documents WHERE id=$1', [id]);
      await manager.query(
        'INSERT INTO knowledge.ingestion_attempts(id,filename,status) VALUES($1,$2,$3)',
        [randomUUID(), doc.filename, 'deleted'],
      );
      return { deleted: true as const, id: doc.id, filename: doc.filename };
    });
  }
}
