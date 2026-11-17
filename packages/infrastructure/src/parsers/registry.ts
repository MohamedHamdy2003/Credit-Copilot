import { createHash } from 'node:crypto';
import { extname, basename } from 'node:path';
import { parse } from 'csv-parse/sync';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import {
  normalizedDocumentSchema,
  type NormalizedDocument,
} from '../../../contracts/src/documents.js';
import { DomainError, invariant } from '../../../domain/src/errors.js';

export interface RawBlock {
  text: string;
  page: number | null;
  row: number | null;
  section: string;
}
export interface DocumentParser {
  extract(bytes: Uint8Array): Promise<RawBlock[]>;
}
export class PdfParser implements DocumentParser {
  async extract(bytes: Uint8Array): Promise<RawBlock[]> {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      disableFontFace: true,
    });
    const timeout = setTimeout(() => {
      void task.destroy();
    }, 30000);
    try {
      const pdf = await task.promise;
      invariant(pdf.numPages <= 100, 'DocumentTooLong', 'Maximum 100 PDF pages');
      const blocks: RawBlock[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const rows: { y: number; items: { x: number; text: string }[] }[] = [];
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue;
          const y = item.transform[5] as number;
          let row = rows.find((entry) => Math.abs(entry.y - y) < 2);
          if (!row) {
            row = { y, items: [] };
            rows.push(row);
          }
          row.items.push({ x: item.transform[4] as number, text: item.str });
        }
        const text = rows
          .sort((a, b) => b.y - a.y)
          .map((row) =>
            row.items
              .sort((a, b) => a.x - b.x)
              .map((item) => item.text)
              .join(' '),
          )
          .join('\n');
        if (text.trim()) blocks.push({ text, page: i, row: null, section: `Page ${i}` });
      }
      invariant(
        blocks.length > 0,
        'TextLayerMissing',
        'PDF has no extractable text; OCR is not supported',
      );
      return blocks;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'ExtractionFailed',
        error instanceof Error && error.name === 'PasswordException'
          ? 'Encrypted PDFs are not supported'
          : 'PDF extraction failed',
      );
    } finally {
      clearTimeout(timeout);
      await task.destroy();
    }
  }
}
function decode(bytes: Uint8Array) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    invariant(!text.includes('\0'), 'FileTypeMismatch', 'Binary data is not supported as text');
    return text.replace(/^\uFEFF/, '');
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('InvalidEncoding', 'Only valid UTF-8 text is supported');
  }
}
export class CsvParser implements DocumentParser {
  async extract(bytes: Uint8Array): Promise<RawBlock[]> {
    const text = decode(bytes);
    try {
      const records = parse(text, { bom: true, skip_empty_lines: true }) as string[][];
      const header = records.shift();
      invariant(
        header &&
          header.length > 1 &&
          new Set(header).size === header.length &&
          header.every((key) => key.trim()),
        'InvalidCSV',
        'CSV requires unique nonempty headers',
      );
      invariant(records.length > 0, 'InvalidCSV', 'CSV requires at least one data row');
      return records.map((values, i) => ({
        text: header.map((key, col) => `${key}: ${values[col]}`).join('\n'),
        page: null,
        row: i + 2,
        section: `Row ${i + 2}`,
      }));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('InvalidCSV', 'CSV structure is malformed');
    }
  }
}
export class MarkdownParser implements DocumentParser {
  async extract(bytes: Uint8Array): Promise<RawBlock[]> {
    const text = decode(bytes);
    const ast = unified().use(remarkParse).parse(text);
    let section = 'Document';
    return ast.children
      .map((node) => {
        const content = text.slice(
          node.position?.start.offset ?? 0,
          node.position?.end.offset ?? text.length,
        );
        if (node.type === 'heading') section = content.replace(/^#+\s*/, '');
        return { text: content, page: null, row: null, section };
      })
      .filter((block) => block.text.trim());
  }
}

export function normalize(
  blocks: RawBlock[],
  filename: string,
  bytes: Uint8Array,
  format: 'pdf' | 'csv' | 'md',
): NormalizedDocument {
  let offset = 0;
  return normalizedDocumentSchema.parse({
    filename,
    hash: createHash('sha256').update(bytes).digest('hex'),
    format,
    parserVersion: '1',
    warnings: [],
    blocks: blocks
      .map((block) => {
        const startOffset = offset;
        offset += block.text.length + 1;
        return {
          ...block,
          originalText: block.text,
          text: block.text
            .normalize('NFKC')
            .replace(/[ \t]+/g, ' ')
            .replace(/\r\n?/g, '\n')
            .trim(),
          startOffset,
        };
      })
      .filter((block) => block.text),
  });
}
export class ParserRegistry {
  private readonly parsers = {
    pdf: new PdfParser(),
    csv: new CsvParser(),
    md: new MarkdownParser(),
  };
  constructor(private readonly maxBytes = 10485760) {}
  async extract(filename: string, bytes: Uint8Array, mime?: string): Promise<NormalizedDocument> {
    invariant(
      filename === basename(filename) && !/[\\/:]/.test(filename),
      'InvalidFilename',
      'Filename must not contain a path',
    );
    const extension = extname(filename).slice(1).toLowerCase();
    invariant(
      extension === 'pdf' || extension === 'csv' || extension === 'md',
      'UnsupportedFileType',
      'Only PDF, CSV and MD files are allowed',
      415,
    );
    invariant(bytes.length > 0, 'EmptyDocument', 'File is empty');
    invariant(
      bytes.length <= this.maxBytes,
      'FileTooLarge',
      'Upload exceeds configured size limit',
      413,
    );
    const signature = Buffer.from(bytes.slice(0, 5)).toString('ascii');
    invariant(
      extension === 'pdf' ? signature === '%PDF-' : signature !== '%PDF-',
      'FileTypeMismatch',
      'File content does not match its extension',
      415,
    );
    const allowed = {
      pdf: ['application/pdf'],
      csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
      md: ['text/markdown', 'text/plain'],
    };
    invariant(
      !mime || mime === 'application/octet-stream' || allowed[extension].includes(mime),
      'FileTypeMismatch',
      'MIME type does not match extension',
      415,
    );
    const blocks = await this.parsers[extension].extract(bytes);
    invariant(blocks.length > 0, 'EmptyDocument', 'File has no extractable content');
    return normalize(blocks, filename, bytes, extension);
  }
}
