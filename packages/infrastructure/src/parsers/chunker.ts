import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
const tokenizer = getEncoding('cl100k_base');
export const CHUNKER_VERSION = 'clause-cl100k-v3';
export const tokenCount = (text: string) => tokenizer.encode(text).length;

export function splitWithOverlap(text: string, maximum = 800, overlap = 60): string[] {
  const tokens = tokenizer.encode(text);
  if (tokens.length <= maximum) return [text];
  const parts: string[] = [];
  for (let start = 0; start < tokens.length; start += maximum - overlap) {
    parts.push(tokenizer.decode(tokens.slice(start, start + maximum)));
    if (start + maximum >= tokens.length) break;
  }
  return parts;
}
import type {
  Chunk,
  DocumentMetadata,
  NormalizedDocument,
} from '../../../contracts/src/documents.js';

export function chunkDocument(document: NormalizedDocument, metadata: DocumentMetadata): Chunk[] {
  const groups: { text: string; section: string; pages: number[]; row: number | null }[] = [];
  let current = {
    text: '',
    section: 'Document',
    pages: [] as number[],
    row: null as number | null,
  };
  const flush = () => {
    if (current.text.trim()) groups.push(current);
  };
  let currentPrefix: string | null = null;
  let currentMajor = -1;
  for (const block of document.blocks) {
    for (const line of block.text.split('\n')) {
      const clauseMatch = line.match(/^\s*(?:#+\s*)?((CP|PM|PS|C)-(\d+)(?:\.\d+)?)(?:[.\s]|$)/);
      const clause = clauseMatch?.[1];
      const prefix = clauseMatch?.[2] ?? null;
      const major = clauseMatch ? Number(clauseMatch[3]) : -1;
      // Comparison tables (e.g., CP-13 summarizing earlier CP-4.1/CP-3.3/CP-9 clauses)
      // reference lower clause numbers and stay inside the enclosing clause chunk.
      const startsNewClause =
        Boolean(clause) && !(prefix === currentPrefix && major < currentMajor);
      if (startsNewClause || (block.row !== null && current.row !== block.row)) {
        flush();
        current = {
          text: '',
          section: startsNewClause ? clause! : block.section,
          pages: [],
          row: block.row,
        };
        if (startsNewClause) {
          currentPrefix = prefix;
          currentMajor = major;
        } else {
          currentPrefix = null;
          currentMajor = -1;
        }
      }
      current.text += `${line}\n`;
      if (block.page !== null && !current.pages.includes(block.page))
        current.pages.push(block.page);
    }
  }
  flush();
  const chunks: Chunk[] = [];
  for (const group of groups) {
    // Paragraph/line boundaries first; oversized text is split at word boundaries.
    const parts = splitWithOverlap(group.text.trim());
    for (const part of parts) {
      const text = part.trim();
      const ordinal = chunks.length;
      const contentHash = createHash('sha256').update(text).digest('hex');
      chunks.push({
        ...metadata,
        id: createHash('sha256')
          .update(`${metadata.id}:${document.hash}:${CHUNKER_VERSION}:${ordinal}:${contentHash}`)
          .digest('hex'),
        ordinal,
        sourceFile: document.filename,
        documentId: metadata.id,
        text,
        section: group.section,
        pageStart: group.pages[0] ?? null,
        pageEnd: group.pages.at(-1) ?? null,
        row: group.row,
        contentHash,
      });
    }
  }
  return chunks;
}
