import { createHash } from 'node:crypto';
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
  for (const block of document.blocks) {
    for (const line of block.text.split('\n')) {
      const clause = line.match(/^\s*(?:#+\s*)?((?:CP|PM|PS|C)-\d+(?:\.\d+)?)(?:[.\s]|$)/)?.[1];
      if (clause || (block.row !== null && current.row !== block.row)) {
        flush();
        current = { text: '', section: clause ?? block.section, pages: [], row: block.row };
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
    const parts = group.text.trim().match(/[\s\S]{1,2200}(?:\s|$)|\S{1,2200}/g) ?? [];
    for (const part of parts) {
      const text = part.trim();
      const ordinal = chunks.length;
      const contentHash = createHash('sha256').update(text).digest('hex');
      chunks.push({
        ...metadata,
        id: createHash('sha256')
          .update(`${metadata.id}:${document.hash}:chunker1:${ordinal}:${contentHash}`)
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
