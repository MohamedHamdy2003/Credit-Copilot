import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ZodError } from 'zod';
import {
  customPolicyMetadataSchema,
  policyMetadataOverrideSchema,
  type DocumentMetadata,
  type NormalizedDocument,
  type PolicyMetadataOverride,
} from '../../../contracts/src/documents.js';
import type { IngestionStage } from '../../../contracts/src/streams.js';
import type { EmbeddingPort } from '../../../application/src/ports.js';
import { DomainError, invariant } from '../../../domain/src/errors.js';
import { ParserRegistry } from '../parsers/registry.js';
import { chunkDocument, CHUNKER_VERSION } from '../parsers/chunker.js';
import { extractPricing } from '../parsers/pricing.js';
import { extractPolicyMetadataFromDocument } from './policy-metadata.js';

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
  customMetadata?: PolicyMetadataOverride;
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

function hasExplicitOverride(override: PolicyMetadataOverride | undefined): boolean {
  if (!override) return false;
  return Object.values(override).some((value) => value !== undefined);
}

function resolveDocumentMetadata(
  filename: string,
  document: NormalizedDocument,
  manifestMatch: ManifestEntry | undefined,
  rawOverride: PolicyMetadataOverride | undefined,
): DocumentMetadata & { sourceOrigin: 'manifest' | 'custom' } {
  const override = rawOverride ? policyMetadataOverrideSchema.parse(rawOverride) : undefined;
  if (manifestMatch && !hasExplicitOverride(override)) {
    return { ...manifestMatch, sourceOrigin: 'manifest' };
  }

  const base: PolicyMetadataOverride = manifestMatch
    ? {
        id: manifestMatch.id,
        edition: manifestMatch.edition,
        effectiveFrom: manifestMatch.effectiveFrom,
        effectiveTo: manifestMatch.effectiveTo,
        product: manifestMatch.product as 'PL-100' | 'AL-200',
        kind: manifestMatch.kind,
      }
    : extractPolicyMetadataFromDocument(filename, document);

  const edition = override?.edition ?? base.edition;
  const effectiveFrom = override?.effectiveFrom ?? base.effectiveFrom;
  if (!edition || !effectiveFrom) {
    throw new DomainError(
      'UntrustedPolicyDocument',
      'Document is not in the reviewed policy manifest and lacks header metadata (edition/document ID and effective date). Open "Override validity dates & metadata" to supply them.',
      403,
    );
  }

  const effectiveTo =
    override?.effectiveTo !== undefined ? override.effectiveTo : (base.effectiveTo ?? null);
  const product = override?.product ?? base.product ?? 'PL-100';
  const kind = override?.kind ?? base.kind ?? (document.format === 'csv' ? 'pricing' : 'policy');
  const explicitId = override?.id ?? base.id;

  let validated;
  try {
    validated = customPolicyMetadataSchema.parse({
      ...(explicitId ? { id: explicitId } : {}),
      edition,
      effectiveFrom,
      effectiveTo,
      product,
      kind,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      throw new DomainError(
        'InvalidPolicyMetadata',
        error.issues[0]?.message ?? 'Invalid policy metadata',
        422,
      );
    }
    throw error;
  }

  const id =
    validated.id ?? `CUSTOM-${slug(validated.edition, 18)}-${slug(filename, 36)}`.slice(0, 64);
  return {
    id,
    edition: validated.edition,
    effectiveFrom: validated.effectiveFrom,
    effectiveTo: validated.effectiveTo ?? null,
    product: validated.product,
    kind: validated.kind,
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
      const metadata = resolveDocumentMetadata(
        filename,
        document,
        manifestMatch,
        options?.customMetadata,
      );
      const pageNumbers = document.blocks
        .map((block) => block.page)
        .filter((page): page is number => page !== null);
      const maxPage = pageNumbers.length ? Math.max(...pageNumbers) : null;
      report({
        stage: 'extract',
        status: 'completed',
        detail: maxPage
          ? `${document.format.toUpperCase()} · ${maxPage} pages · ${document.blocks.length} blocks · ${metadata.edition} (${metadata.effectiveFrom})`
          : `${document.format.toUpperCase()} · ${document.blocks.length} blocks · ${metadata.edition} (${metadata.effectiveFrom})`,
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
        detail: `${chunks.length} chunks (${CHUNKER_VERSION})`,
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
          detail: `Reusing ${chunks.length} existing embeddings`,
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
        detail: `Embedding 0 of ${chunks.length} chunks`,
        current: 0,
        total: chunks.length,
      });
      for (const [index, chunk] of chunks.entries()) {
        vectors.push(await this.embeddings.embed(chunk.text, 'document'));
        report({
          stage: 'embed',
          status: 'running',
          detail: `Embedded ${index + 1} of ${chunks.length} chunks`,
          current: index + 1,
          total: chunks.length,
        });
      }
      report({
        stage: 'embed',
        status: 'completed',
        detail: `${vectors.length} vectors · ${this.embeddings.dimensions}d`,
        current: chunks.length,
        total: chunks.length,
      });

      report({
        stage: 'index',
        status: 'running',
        detail: `Committing ${chunks.length} chunks to knowledge.*`,
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
        detail: `Indexed ${chunks.length} chunks as ${metadata.id}`,
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
