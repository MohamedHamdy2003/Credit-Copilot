import type { NormalizedDocument } from '../../contracts/src/documents.js';
import { DomainError, invariant } from '../../domain/src/errors.js';
import type { EvidenceItem } from '../../domain/src/evidence-mode.js';
import { parseEnglishDate } from './extraction.js';
import { parseApplicationForm } from './application-form.js';

/** Local extraction for supported layouts; unknown/contradictory evidence refers. */
export function deriveEvidenceFacts(document: NormalizedDocument) {
  const text = document.blocks.map((block) => block.text).join('\n');
  const salary = text.split(/^Part 2\b/m)[1]?.split(/^Part 3\b/m)[0] ?? '';
  const bureau = text.split(/^Part 3\b/m)[1] ?? '';
  const form = parseApplicationForm(document);
  const dates = [...salary.matchAll(/Issued:\s*(\d{1,2} [A-Za-z]+ \d{4})/g)].map((m) => m[1]!);
  invariant(
    dates.length === 1,
    'MissingRequiredEvidence',
    'Exactly one salary certificate issue date required',
  );
  const employer = text.match(/^Employer (.+)$/m)?.[1]?.trim();
  const purpose = text.match(/^Purpose (.+)$/m)?.[1]?.trim();
  invariant(
    employer && purpose,
    'MissingRequiredEvidence',
    'Employer and purpose evidence required',
  );
  invariant(
    salary.includes(employer),
    'EvidenceConflict',
    'Salary employer disagrees with application',
  );
  const defaultRows = [...bureau.matchAll(/^Facilities in default (.+)$/gm)].map((m) =>
    m[1]!.trim(),
  );
  invariant(
    defaultRows.length === 1,
    'MissingRequiredEvidence',
    'Exactly one default-status field required',
  );
  // Do not equate permanent employment alone with completed probation.
  const explicitComplete =
    /probation\s+(?:period\s+)?(?:is\s+)?complete(?:d)?|completed\s+(?:his\s+|her\s+|the\s+)?probation/i.test(
      salary,
    );
  const probationActive =
    /(?:on|under|in)\s+probation|probation\s+(?:not completed|incomplete)/i.test(salary);
  if (explicitComplete && probationActive)
    throw new DomainError('EvidenceConflict', 'Contradictory probation evidence');
  const allowedPurposes = [
    'Home renovation',
    'Debt consolidation',
    'Education fees',
    'Furniture and household goods',
    'Medical expenses',
  ];
  const prohibited = /business|commercial|securities/i.test(purpose);
  invariant(
    allowedPurposes.includes(purpose) || prohibited,
    'UnverifiedPurpose',
    'Purpose requires human classification',
  );
  const evidence: EvidenceItem[] = [
    { requirement: 'national_id_copy', present: false, verified: false },
    { requirement: 'salary_certificate', present: Boolean(salary), verified: false },
    {
      requirement: 'employer_stamp',
      present: /Company stamp applied/i.test(salary),
      verified: false,
    },
    { requirement: 'bureau_report', present: Boolean(bureau), verified: false },
  ];
  return {
    evidence,
    facts: {
      certificateDate: parseEnglishDate(dates[0]!),
      confirmed: explicitComplete ? true : probationActive ? false : null,
      hasDefault: !/^None$/i.test(defaultRows[0]!),
      bankEmployee: employer === 'Delta Commercial Bank',
      purposeAllowed: !prohibited,
      plannedDisbursement: form.applicationDate,
    },
    provenance: {
      sourceFile: document.filename,
      certificateDateQuote: `Issued: ${dates[0]}`,
      employmentConfirmation: explicitComplete
        ? 'explicit_probation_completion'
        : 'unknown_or_incomplete',
    },
  };
}
