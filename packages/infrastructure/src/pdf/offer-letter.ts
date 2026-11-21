import type { IssuedOfferDocument } from '../../../contracts/src/offers.js';

const pageWidth = 595.28;
const pageHeight = 841.89;
const left = 48;
const right = pageWidth - left;
const contentWidth = right - left;
const colors = {
  ink: '#162e2a',
  green: '#14604e',
  muted: '#4c6260',
  divider: '#c9d9d5',
  pale: '#eff6f4',
  white: '#ffffff',
  amber: '#694817',
  amberPale: '#fff4dc',
};
type Typeface = 'regular' | 'bold' | 'mono';
const fonts = { regular: 'F1', bold: 'F2', mono: 'F3' } satisfies Record<Typeface, string>;

function rgb(hex: string) {
  return [1, 3, 5]
    .map((offset) => (parseInt(hex.slice(offset, offset + 2), 16) / 255).toFixed(4))
    .join(' ');
}

// The English template uses PDF base fonts. Escape the literal syntax and
// replace unsupported glyphs before measuring or writing a text run.
function printable(value: string) {
  return value.replace(/[\r\n\t]/g, ' ').replace(/[^ -~]/g, '?');
}

class Page {
  private readonly operators: string[] = [];

  text(
    value: string,
    x: number,
    baseline: number,
    size: number,
    font: Typeface = 'regular',
    color = colors.ink,
  ) {
    const escaped = printable(value).replace(/[\\()]/g, '\\$&');
    this.operators.push(
      `BT /${fonts[font]} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${x.toFixed(2)} ${(pageHeight - baseline).toFixed(2)} Tm (${escaped}) Tj ET`,
    );
  }

  right(value: string, x: number, baseline: number, size: number, color = colors.ink) {
    this.text(value, x - printable(value).length * size * 0.6, baseline, size, 'mono', color);
  }

  currency(value: string, x: number, baseline: number) {
    const size = 9.2;
    // Helvetica uses tabular digits and half-width currency punctuation.
    const width = [...value].reduce(
      (sum, char) => sum + (char === ',' || char === '.' ? 0.278 : 0.556),
      0,
    );
    this.text(value, x - width * size, baseline, size);
  }

  fill(x: number, top: number, width: number, height: number, color: string) {
    this.operators.push(
      `${rgb(color)} rg ${x.toFixed(2)} ${(pageHeight - top - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`,
    );
  }

  rule(x1: number, x2: number, top: number, color = colors.divider) {
    const y = (pageHeight - top).toFixed(2);
    this.operators.push(
      `${rgb(color)} RG 0.55 w ${x1.toFixed(2)} ${y} m ${x2.toFixed(2)} ${y} l S`,
    );
  }

  content() {
    return this.operators.join('\n') + '\n';
  }
}

/** Serialize the fixed template as a static PDF with no active content or attachments. */
function serializePdf(pages: Page[]): Buffer {
  const firstPageObject = 7;
  const ids = pages.map((_, index) => firstPageObject + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] >>`,
    ...['Helvetica', 'Helvetica-Bold', 'Courier'].map(
      (name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`,
    ),
    '<< /Title (Issued loan offer and repayment schedule) /Producer (Credit Copilot) >>',
  ];
  for (const [index, page] of pages.entries()) {
    const content = page.content();
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${ids[index]! + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    );
  }
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = ['0000000000 65535 f \n'];
  let position = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(position).padStart(10, '0')} 00000 n \n`);
    const bytes = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'latin1');
    parts.push(bytes);
    position += bytes.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${position}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

const tierNames = {
  credit: 'Credit Officer',
  senior: 'Senior Credit Officer',
  head: 'Head of Credit',
};

function currency(amount: string) {
  const [units, cents] = amount.split('.');
  return `${units!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

const amount = (value: string) => `EGP ${currency(value)}`;
const timestamp = (value: string) => value.replace('T', ' ').replace(/Z$/, ' UTC');

function wrapped(value: string, columns: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of printable(value).trim().split(/ +/)) {
    for (let start = 0; start < word.length; start += columns) {
      const part = word.slice(start, start + columns);
      if (line && line.length + part.length + 1 > columns) {
        lines.push(line);
        line = '';
      }
      line = line ? `${line} ${part}` : part;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function header(page: Page, document: IssuedOfferDocument) {
  page.text('CREDIT COPILOT', left, 51, 12, 'bold', colors.green);
  page.right(
    `${document.applicationReference} / ${document.productId}`,
    right,
    51,
    9,
    colors.muted,
  );
  page.rule(left, right, 65);
}

function footer(page: Page, document: IssuedOfferDocument, pageNumber: number, total: number) {
  page.rule(left, right, 799);
  page.text(
    `${document.mode === 'demo' ? 'SYNTHETIC DEMO' : 'SYNTHETIC'}  /  ${document.offerId}`,
    left,
    816,
    8.5,
    'mono',
    colors.muted,
  );
  page.right(`Page ${pageNumber} of ${total}`, right, 816, 8.5, colors.muted);
}

function labelValue(page: Page, x: number, y: number, label: string, value: string, size = 14) {
  page.text(label, x, y, 9, 'regular', colors.muted);
  page.text(value, x, y + 18, size, 'bold');
}

function auditValue(page: Page, x: number, y: number, label: string, value: string) {
  page.text(label, x, y, 8.5, 'regular', colors.muted);
  page.text(value, x, y + 13, 8.5, 'mono');
}

function renderLetter(document: IssuedOfferDocument) {
  const page = new Page();
  header(page, document);
  page.text('Loan offer', left, 110, 34, 'bold');
  page.text(
    document.productId === 'AL-200' ? 'Vehicle loan' : 'Personal loan',
    left,
    133,
    13,
    'regular',
    colors.muted,
  );
  page.fill(right - 67, 87, 67, 26, colors.green);
  page.text('ISSUED', right - 55, 104, 11, 'bold', colors.white);

  const demo = document.mode === 'demo';
  page.fill(left, 152, contentWidth, 49, demo ? colors.amberPale : colors.pale);
  page.text(
    demo ? 'Synthetic Demo offer' : 'Synthetic test offer',
    left + 12,
    171,
    11,
    'bold',
    demo ? colors.amber : colors.green,
  );
  page.text(
    demo
      ? 'ID-copy presence was assumed for Demo. Evidence was not fully verified.'
      : document.fullyEvidenceVerified
        ? 'Generated with synthetic test data.'
        : 'Generated with synthetic test data. Evidence was not fully verified.',
    left + 12,
    187,
    9.5,
    'regular',
    demo ? colors.amber : colors.ink,
  );

  page.text('Loan terms', left, 229, 17, 'bold');
  page.fill(left, 241, contentWidth, 109, colors.pale);
  page.rule(left + 12, right - 12, 294);
  const columns = [left + 12, left + 177, left + 343] as const;
  labelValue(page, columns[0], 261, 'Approved principal', amount(document.principal));
  labelValue(page, columns[1], 261, 'Fixed annual rate', `${document.annualRatePercent}%`);
  labelValue(page, columns[2], 261, 'Repayment term', `${document.months} months`);
  labelValue(page, columns[0], 314, 'Disbursement date', document.disbursementDate);
  labelValue(page, columns[1], 314, 'Regular instalment', amount(document.schedule.installment));
  labelValue(page, columns[2], 314, 'First due date', document.schedule.rows[0]!.dueDate);

  page.text('Disbursement and repayment', left, 380, 17, 'bold');
  page.fill(left, 392, contentWidth, 97, colors.pale);
  page.rule(left + 12, right - 12, 438);
  labelValue(
    page,
    columns[0],
    409,
    `Administrative fee (${document.administrativeFeePercent}%)`,
    amount(document.schedule.administrativeFee),
    12,
  );
  labelValue(
    page,
    columns[1],
    409,
    'Net disbursement',
    amount(document.schedule.netDisbursement),
    12,
  );
  labelValue(
    page,
    columns[2],
    409,
    'Total repayment',
    amount(document.schedule.totalRepayment),
    12,
  );
  labelValue(page, columns[0], 456, 'Total interest', amount(document.schedule.totalInterest), 12);
  labelValue(
    page,
    columns[1],
    456,
    'Early settlement fee',
    `${document.earlySettlementFeePercent}% of outstanding ${document.productId === 'AL-200' ? 'principal' : 'balance'}`,
    9,
  );
  labelValue(page, columns[2], 456, 'Late fee per missed payment', amount(document.lateFee), 12);

  page.text('Recorded human decision', left, 521, 17, 'bold');
  const second = left + 253;
  auditValue(page, left, 543, 'Approval record', document.approval.id);
  auditValue(page, second, 543, 'Approver ID', document.approval.approverId);
  auditValue(page, left, 574, 'Preparer ID', document.approval.preparerId);
  auditValue(page, second, 574, 'Issuer ID', document.issuance.issuerId);
  auditValue(page, left, 605, 'Approved at', timestamp(document.approval.approvedAt));
  auditValue(page, second, 605, 'Issued at', timestamp(document.issuance.issuedAt));
  const approver = document.approval.approverTier
    ? tierNames[document.approval.approverTier]
    : 'Recorded independent approver';
  const authority = document.approval.approverAuthorityLimit
    ? ` / ${amount(document.approval.approverAuthorityLimit)}`
    : '';
  auditValue(page, left, 636, 'Approving authority', approver + authority);
  auditValue(
    page,
    second,
    636,
    'Issuing authority',
    document.issuance.issuerTier ? tierNames[document.issuance.issuerTier] : 'Recorded issuer',
  );

  let baseline = 673;
  const pricingReference = sourceReference(document.pricing, `row ${document.pricing.row}`);
  for (const line of wrapped(
    `Policy ${document.policyEdition} / Pricing ${pricingReference}`,
    94,
  )) {
    page.text(line, left, baseline, 8.5, 'mono', colors.green);
    baseline += 12;
  }
  page.text(`Assessment ${document.runId}`, left, baseline + 3, 8.5, 'mono', colors.muted);
  return page;
}

function sourceReference(
  source: { sourceFile: string; documentId?: string; version?: string },
  location: string,
) {
  const version =
    source.version && source.version !== source.documentId ? `v${source.version}` : undefined;
  const identifiers = [source.documentId, version].filter(Boolean).join(' ');
  return `${source.sourceFile} / ${location}${identifiers ? ` / ${identifiers}` : ''}`;
}

function renderConditions(pages: Page[], document: IssuedOfferDocument) {
  function startPage() {
    const page = new Page();
    header(page, document);
    page.text('Offer conditions', left, 108, 30, 'bold');
    page.text(
      `Issued terms for ${document.applicationReference}`,
      left,
      132,
      11,
      'regular',
      colors.muted,
    );
    pages.push(page);
    return page;
  }
  let page = startPage();
  let baseline = 167;
  for (const condition of document.conditions) {
    const body = wrapped(condition.description, 75);
    const source = wrapped(sourceReference(condition, condition.clause), 94);
    const blockHeight = body.length * 13 + source.length * 11 + 16;
    if (baseline + blockHeight > 784) {
      page = startPage();
      baseline = 167;
    }
    for (const line of body) {
      page.text(line, left, baseline, 10);
      baseline += 13;
    }
    for (const line of source) {
      page.text(line, left, baseline, 8.5, 'mono', colors.green);
      baseline += 11;
    }
    baseline += 16;
  }
}

const rowsPerPage = 31;
const rowHeight = 17;
const scheduleColumns = [
  left + 9,
  left + 36,
  left + 210,
  left + 302,
  left + 394,
  right - 9,
] as const;

function renderSchedule(pages: Page[], document: IssuedOfferDocument) {
  const { rows, totalRepayment, totalInterest } = document.schedule;
  for (let start = 0; start < rows.length; start += rowsPerPage) {
    const page = new Page();
    const pageRows = rows.slice(start, start + rowsPerPage);
    const lastRow = pageRows.at(-1)!;
    header(page, document);
    page.text('Repayment schedule', left, 108, 30, 'bold');
    page.text(
      `${amount(document.principal)} over ${document.months} months at ${document.annualRatePercent}% p.a.`,
      left,
      133,
      11,
      'regular',
      colors.muted,
    );
    page.text(
      `Payments ${pageRows[0]!.number}-${lastRow.number} of ${rows.length}`,
      left,
      158,
      10,
      'bold',
    );
    page.right('All amounts in EGP', right, 158, 8.5, colors.muted);
    page.fill(left, 171, contentWidth, 26, colors.green);
    page.text('#', scheduleColumns[0], 187, 8.5, 'bold', colors.white);
    page.text('DUE DATE', scheduleColumns[1], 187, 8.5, 'bold', colors.white);
    for (const [index, title] of ['PAYMENT', 'PRINCIPAL', 'INTEREST', 'BALANCE'].entries()) {
      page.right(title, scheduleColumns[index + 2]!, 187, 8.5, colors.white);
    }
    for (const [index, row] of pageRows.entries()) {
      const top = 197 + index * rowHeight;
      if (index % 2 === 0) page.fill(left, top, contentWidth, rowHeight, colors.pale);
      const y = top + 11;
      page.text(String(row.number), scheduleColumns[0], y, 9.2);
      page.text(row.dueDate, scheduleColumns[1], y, 9.2);
      for (const [column, value] of [
        row.installment,
        row.principal,
        row.interest,
        row.balance,
      ].entries()) {
        page.currency(currency(value), scheduleColumns[column + 2]!, y);
      }
    }
    const bottom = 197 + pageRows.length * rowHeight;
    page.rule(left, right, bottom);
    if (start + pageRows.length === rows.length) {
      page.fill(left, bottom + 1, contentWidth, 24, colors.pale);
      page.text('TOTALS', left + 9, bottom + 16, 9, 'bold');
      for (const [column, value] of [
        totalRepayment,
        document.principal,
        totalInterest,
        lastRow.balance,
      ].entries()) {
        page.currency(currency(value), scheduleColumns[column + 2]!, bottom + 16);
      }
      page.text(
        'The final instalment includes any cent-rounding adjustment.',
        left,
        bottom + 43,
        9,
        'regular',
        colors.muted,
      );
    }
    pages.push(page);
  }
}

export function renderOfferLetter(document: IssuedOfferDocument): Buffer {
  const pages = [renderLetter(document)];
  renderConditions(pages, document);
  renderSchedule(pages, document);
  for (const [index, page] of pages.entries()) footer(page, document, index + 1, pages.length);
  return serializePdf(pages);
}
