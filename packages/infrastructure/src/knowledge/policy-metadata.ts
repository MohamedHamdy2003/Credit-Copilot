import type {
  DocumentMetadata,
  NormalizedDocument,
  PolicyMetadataOverride,
} from '../../../contracts/src/documents.js';

const MONTHS: Record<string, string> = {
  january: '01',
  jan: '01',
  february: '02',
  feb: '02',
  march: '03',
  mar: '03',
  april: '04',
  apr: '04',
  may: '05',
  june: '06',
  jun: '06',
  july: '07',
  jul: '07',
  august: '08',
  aug: '08',
  september: '09',
  sep: '09',
  sept: '09',
  october: '10',
  oct: '10',
  november: '11',
  nov: '11',
  december: '12',
  dec: '12',
};

const DATE_CAPTURE =
  '(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+[A-Za-z]+\\s+\\d{4}|[A-Za-z]+\\s+\\d{1,2},\\s*\\d{4})';

function isValidIsoDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return false;
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

export function parsePolicyHeaderDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/[.,;]+$/, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return isValidIsoDate(trimmed) ? trimmed : null;
  }
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(trimmed);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2]!.toLowerCase()];
    if (!month) return null;
    const iso = `${dayFirst[3]}-${month}-${dayFirst[1]!.padStart(2, '0')}`;
    return isValidIsoDate(iso) ? iso : null;
  }
  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(trimmed);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1]!.toLowerCase()];
    if (!month) return null;
    const iso = `${monthFirst[3]}-${month}-${monthFirst[2]!.padStart(2, '0')}`;
    return isValidIsoDate(iso) ? iso : null;
  }
  return null;
}

function sanitizeId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .replace(/^[*`_]+|[*`_]+$/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return /^[A-Za-z0-9._-]{2,64}$/.test(cleaned) ? cleaned : undefined;
}

function sanitizeEdition(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .replace(/^[*`_]+|[*`_]+$/g, '')
    .replace(/[.,;]+$/, '')
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : undefined;
}

function detectProduct(combined: string): 'PL-100' | 'AL-200' | undefined {
  if (
    /\bAL-200\b|\b(?:auto|vehicle|motor)[\s-]?(?:loan|finance|financing|policy|pricing)\b/i.test(
      combined,
    )
  ) {
    return 'AL-200';
  }
  if (/\bPL-100\b|\bpersonal[\s-]?loan\b|\bunsecured\s+personal\b/i.test(combined)) {
    return 'PL-100';
  }
  return undefined;
}

function detectKind(
  filename: string,
  format: NormalizedDocument['format'],
  headerText: string,
  documentId?: string,
): DocumentMetadata['kind'] | undefined {
  const lower = filename.toLowerCase();
  const titleHead = headerText.slice(0, 260);
  if (format === 'csv' || /\bpricing\b/i.test(lower) || /^PT-/i.test(documentId ?? '')) {
    return 'pricing';
  }
  if (/^C-\d{4}/i.test(documentId ?? '')) return 'circular';
  if (/^PM-/i.test(documentId ?? '')) return 'procedure';
  if (/^PS-/i.test(documentId ?? '')) return 'product';
  if (/^(?:CP|AUTO)-/i.test(documentId ?? '')) return 'policy';

  if (/\bcircular\b/i.test(lower) || /\bcircular\s+\d{4}\/\d{2}\b/i.test(titleHead)) {
    return 'circular';
  }
  if (/\bprocedure/i.test(lower) || /\bprocedures?\s+manual\b/i.test(titleHead)) {
    return 'procedure';
  }
  if (/\bproduct\b/i.test(lower) || /\bproduct[\s-]?sheet\b/i.test(titleHead)) {
    return 'product';
  }
  if (/\bpolicy\b/i.test(lower) || /\b(?:credit\s+)?policy\b/i.test(titleHead)) {
    return 'policy';
  }
  return undefined;
}

function parseCsvBlocks(filename: string, document: NormalizedDocument): PolicyMetadataOverride {
  const fieldsByRow = document.blocks.map((block) => {
    const map = new Map<string, string>();
    for (const line of block.text.split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key && value) map.set(key, value);
    }
    return map;
  });

  const firstId = fieldsByRow.map((row) => row.get('document_id')).find(Boolean);
  const firstVersion = fieldsByRow
    .map((row) => row.get('version') ?? row.get('edition'))
    .find(Boolean);
  const firstProduct = fieldsByRow.map((row) => row.get('product')).find(Boolean);
  const effectiveFromDates = fieldsByRow
    .map((row) => parsePolicyHeaderDate(row.get('effective_from')))
    .filter((date): date is string => Boolean(date))
    .sort();
  const effectiveToDates = fieldsByRow
    .map((row) => parsePolicyHeaderDate(row.get('effective_to')))
    .filter((date): date is string => Boolean(date))
    .sort();

  const id = sanitizeId(firstId);
  const edition = sanitizeEdition(firstVersion ?? id);
  const effectiveFrom = effectiveFromDates[0];
  const candidateTo = effectiveToDates.at(-1);
  const effectiveTo =
    candidateTo && effectiveFrom && candidateTo > effectiveFrom ? candidateTo : undefined;
  const combined = `${filename}\n${firstProduct ?? ''}\n${firstId ?? ''}`;
  const product = detectProduct(combined);

  return {
    ...(id ? { id } : {}),
    ...(edition ? { edition } : {}),
    ...(effectiveFrom ? { effectiveFrom } : {}),
    ...(effectiveTo ? { effectiveTo } : {}),
    ...(product ? { product } : {}),
    kind: 'pricing',
  };
}

/**
 * Extracts dated policy metadata from a normalized PDF, Markdown, or CSV document header.
 * Returns only fields explicitly evidenced by the document content or filename.
 */
export function extractPolicyMetadataFromDocument(
  filename: string,
  document: NormalizedDocument,
): PolicyMetadataOverride {
  if (document.format === 'csv') {
    return parseCsvBlocks(filename, document);
  }

  const headerText = document.blocks
    .slice(0, 8)
    .map((block) => block.text)
    .join('\n')
    .slice(0, 4500);
  const normalizedHeader = headerText.replace(/\*\*/g, '');

  const titleHead = normalizedHeader.slice(0, 260);
  const docIdMatch =
    /\b(?:Document|Doc)\s+ID\s*:\s*([A-Za-z0-9._/-]{2,64})/i.exec(normalizedHeader) ??
    /\bDocument[ \t]+([A-Z]{2,6}-[A-Za-z0-9._-]*\d[A-Za-z0-9._-]{0,40})\b/.exec(titleHead);
  const circularMatch = /\bCircular\s+(20\d{2})\/(\d{2})\b/i.exec(titleHead);
  const editionLabelMatch =
    /\bEdition\s*:\s*([A-Za-z0-9._/-]*\d[A-Za-z0-9._/-]{0,39})/i.exec(normalizedHeader) ??
    /\bEdition[ \t]+((?:[A-Za-z]{2,10}-)?20\d{2}(?:[./-]\d+)?)\b/i.exec(normalizedHeader);
  const versionLabelMatch = /\bVersion\s*:?[ \t]+(\d+(?:\.\d+){0,2})\b/i.exec(normalizedHeader);
  const knownCodeMatch = /\b((?:CP|AUTO)-20\d{2})\b/i.exec(`${filename}\n${normalizedHeader}`);

  let id = sanitizeId(docIdMatch?.[1]);
  if (!id && circularMatch) {
    id = sanitizeId(`C-${circularMatch[1]}-${circularMatch[2]}`);
  }
  if (!id && knownCodeMatch) {
    id = sanitizeId(knownCodeMatch[1]!.toUpperCase());
  }

  let edition: string | undefined;
  if (!docIdMatch && circularMatch) {
    edition = sanitizeEdition(`${circularMatch[1]}/${circularMatch[2]}`);
  } else if (versionLabelMatch) {
    edition = sanitizeEdition(versionLabelMatch[1]);
  } else if (editionLabelMatch) {
    const rawEdition = editionLabelMatch[1]!.trim();
    // If header says "Document ID: CP-2025 | Edition: 2025", preserve full "CP-2025".
    if (/^20\d{2}$/.test(rawEdition) && id && id.endsWith(rawEdition)) {
      edition = sanitizeEdition(id);
    } else {
      edition = sanitizeEdition(rawEdition);
    }
  } else if (knownCodeMatch) {
    edition = sanitizeEdition(knownCodeMatch[1]!.toUpperCase());
  } else if (id) {
    edition = sanitizeEdition(id);
  }

  const effectivePatterns = [
    new RegExp(
      `\\bEffective\\s+for\\s+applications\\s+received\\s+from\\s*:\\s*${DATE_CAPTURE}`,
      'i',
    ),
    new RegExp(`\\bEffective\\s+(?:from|date)\\s*:\\s*${DATE_CAPTURE}`, 'i'),
    new RegExp(`\\bIN\\s+FORCE\\s+from\\s+${DATE_CAPTURE}`, 'i'),
    new RegExp(`\\bEffective\\s*:?\\s*${DATE_CAPTURE}`, 'i'),
    new RegExp(`\\bIssued\\s*:\\s*${DATE_CAPTURE}`, 'i'),
  ];
  let effectiveFrom: string | undefined;
  for (const pattern of effectivePatterns) {
    const match = pattern.exec(normalizedHeader);
    const parsed = parsePolicyHeaderDate(match?.[1]);
    if (parsed) {
      effectiveFrom = parsed;
      break;
    }
  }

  const expiryPatterns = [
    new RegExp(
      `\\bSuperseded\\s+for\\s+applications\\s+received\\s+from\\s*:\\s*${DATE_CAPTURE}`,
      'i',
    ),
    new RegExp(`\\bSuperseded[^.\\n]*?\\bon\\s+${DATE_CAPTURE}`, 'i'),
    new RegExp(
      `\\b(?:Effective\\s+(?:to|until)|Valid\\s+until|Expires?)\\s*:\\s*${DATE_CAPTURE}`,
      'i',
    ),
  ];
  let effectiveTo: string | undefined;
  for (const pattern of expiryPatterns) {
    const match = pattern.exec(normalizedHeader);
    const parsed = parsePolicyHeaderDate(match?.[1]);
    if (parsed && (!effectiveFrom || parsed > effectiveFrom)) {
      effectiveTo = parsed;
      break;
    }
  }

  const combined = `${filename}\n${normalizedHeader}`;
  const product = detectProduct(combined);
  const kind = detectKind(filename, document.format, normalizedHeader, id);

  return {
    ...(id ? { id } : {}),
    ...(edition ? { edition } : {}),
    ...(effectiveFrom ? { effectiveFrom } : {}),
    ...(effectiveTo ? { effectiveTo } : {}),
    ...(product ? { product } : {}),
    ...(kind ? { kind } : {}),
  };
}
