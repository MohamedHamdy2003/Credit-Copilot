import type { DataSource } from 'typeorm';
import type { Chunk } from '../../../contracts/src/documents.js';
import type { EmbeddingPort } from '../../../application/src/ports.js';
import { validDate } from '../../../domain/src/calculations.js';
import { isApprovalBypass, maskPolicyQuestion } from '../../../application/src/questions.js';
import type { Config } from '../../../contracts/src/config.js';
import { rewritePolicyQuery } from '../../../application/src/query-rewrite.js';
import {
  eligibleChunks,
  hybridRanking,
  hybridSearch,
  hybridSearchWithRewrite,
} from './hybrid-search.js';
export interface SearchHit {
  chunk: Chunk;
  similarity: number;
  ranking?: {
    vectorRank: number | null;
    bm25Rank: number | null;
    bm25Score: number | null;
    rrfScore: number;
  };
}
interface RewriteTrace {
  expansions: string[];
  originalChunkIds: string[];
  rewrittenChunkIds: string[];
  promotedChunkIds: string[];
}

export class RetrievalService {
  constructor(
    private readonly db: DataSource,
    private readonly embeddings: EmbeddingPort,
    private readonly strategy: Config['RETRIEVAL_STRATEGY'] = 'hybrid',
    private readonly rewriteSettings?: Pick<
      Config,
      'QUERY_REWRITE_MAX_EXPANSIONS' | 'RETRIEVAL_MIN_SIMILARITY'
    >,
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
    return (await this.searchWithTrace(question, date, product, limit)).hits;
  }
  async searchWithTrace(
    rawQuestion: string,
    date: string,
    product = 'PL-100',
    limit = 5,
  ): Promise<{ hits: SearchHit[]; rewrite?: RewriteTrace }> {
    validDate(date);
    const question = maskPolicyQuestion(rawQuestion);
    const vector = await this.embeddings.embed(question, 'query');
    const parameters = [
      JSON.stringify(vector),
      product,
      date,
      this.embeddings.model,
      this.embeddings.dimensions,
      Math.max(1, Math.min(limit, 20)),
    ];
    if (this.strategy === 'vector') {
      const hits = (await this.db.query(
        `SELECT c.metadata AS chunk, 1-(e.embedding <=> $1::vector) AS similarity
        ${eligibleChunks}
        ORDER BY e.embedding <=> $1::vector, c.id LIMIT $6`,
        parameters,
      )) as SearchHit[];
      return { hits };
    }
    const hybridParameters = [...parameters, hybridRanking.branchLimit, question];
    const settings = this.rewriteSettings;
    const rewritten =
      settings && !isApprovalBypass(question)
        ? rewritePolicyQuery(question, settings.QUERY_REWRITE_MAX_EXPANSIONS)
        : undefined;
    if (!settings || !rewritten) {
      const hits = (await this.db.query(hybridSearch, hybridParameters)) as SearchHit[];
      return { hits };
    }

    const rows = (await this.db.query(hybridSearchWithRewrite, [
      ...hybridParameters,
      rewritten.query,
    ])) as (SearchHit & { kind: 'original' | 'rewrite' })[];
    const original: SearchHit[] = [];
    const alternate: SearchHit[] = [];
    for (const { kind, ...hit } of rows) {
      (kind === 'original' ? original : alternate).push(hit);
    }
    const floor = settings.RETRIEVAL_MIN_SIMILARITY;
    const qualifies = (hit: SearchHit) =>
      Number.isFinite(hit.similarity) && hit.similarity >= floor;
    const originals = new Set(original.map((hit) => hit.chunk.id));
    const replacements = alternate.filter((hit) => qualifies(hit) && !originals.has(hit.chunk.id));
    // Retain all original evidence that already meets the same cosine floor.
    const hits = original.map((hit) => (qualifies(hit) ? hit : (replacements.shift() ?? hit)));
    return {
      hits,
      rewrite: {
        expansions: rewritten.expansions,
        originalChunkIds: [...originals],
        rewrittenChunkIds: alternate.map((hit) => hit.chunk.id),
        promotedChunkIds: hits
          .filter((hit) => !originals.has(hit.chunk.id))
          .map((hit) => hit.chunk.id),
      },
    };
  }
}
