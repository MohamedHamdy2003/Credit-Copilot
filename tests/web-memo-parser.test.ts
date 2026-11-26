import {
  formatEgpAmount,
  formatIdentifierLabel,
  parseCreditMemo,
  splitRuleCitation,
} from '../apps/web/src/memo-parser.js';

describe('credit memo parser', () => {
  it('parses a full personal-loan approval memo into structured sections', () => {
    const raw = [
      'APP-003: APPROVE; pending_approval; 2025',
      'Mode strict; fully evidence verified: true',
      'Requested EGP 120000; 36 months; application date 2025-03-10',
      'Approval authority required: senior credit officer',
      'Annual rate 24.50%; source pricing-table.csv row 4',
      '2025 CP-3.1: pass; Confirmed employment and completed probation required',
      'product-sheet-personal-loan.md PS-3: pass; Product amount and tenor limits',
      '2025 CP-4.1: pass; Exact debt burden compared against applicable policy limit',
      'Source: credit-policy-2025.pdf CP-3.1',
      'Source: product-sheet-personal-loan.md PS-3',
      'EMI EGP 4708.22; DBR 31.40%; maximum eligible EGP 185000.00',
      'Human decision required. This recommendation is not an issued offer.',
    ].join('\n');

    const parsed = parseCreditMemo(raw);

    expect(parsed.header).toEqual({
      reference: 'APP-003',
      recommendation: 'APPROVE',
      status: 'pending_approval',
      policyEdition: '2025',
    });
    expect(parsed.mode).toEqual({ mode: 'strict', fullyEvidenceVerified: true });
    expect(parsed.request).toEqual({
      amount: '120000',
      months: 36,
      applicationDate: '2025-03-10',
    });
    expect(parsed.approvalAuthority).toBe('senior credit officer');
    expect(parsed.pricing).toEqual({
      annualRatePercent: '24.50',
      sourceFile: 'pricing-table.csv',
      row: '4',
    });
    expect(parsed.rules).toEqual([
      {
        citation: '2025 CP-3.1',
        clause: 'CP-3.1',
        source: '2025',
        status: 'pass',
        reason: 'Confirmed employment and completed probation required',
      },
      {
        citation: 'product-sheet-personal-loan.md PS-3',
        clause: 'PS-3',
        source: 'product-sheet-personal-loan.md',
        status: 'pass',
        reason: 'Product amount and tenor limits',
      },
      {
        citation: '2025 CP-4.1',
        clause: 'CP-4.1',
        source: '2025',
        status: 'pass',
        reason: 'Exact debt burden compared against applicable policy limit',
      },
    ]);
    expect(parsed.sources).toEqual([
      'credit-policy-2025.pdf CP-3.1',
      'product-sheet-personal-loan.md PS-3',
    ]);
    expect(parsed.affordability).toEqual({
      emi: '4708.22',
      dbrPercent: '31.40',
      maxEligible: '185000.00',
    });
    expect(parsed.disclaimer).toBe(
      'Human decision required. This recommendation is not an issued offer.',
    );
    expect(parsed.otherLines).toEqual([]);
  });

  it('parses auto finance, referrals, missing evidence, demo assumptions, and uncalculated affordability', () => {
    const raw = [
      'AUTO-002: REFER_TO_HUMAN; pending_review; AUTO-2025',
      'Mode demo; fully evidence verified: false',
      'Vehicle price EGP 600000; down payment EGP 150000; finance EGP 450000',
      'Referral reason: SuspectedTampering',
      'Missing evidence: national_id_copy, salary_certificate',
      'Assumption: Demo mode assumes national ID presence; actual missing; verified=false',
      'AUTO-2025 CP-6 default: fail; A facility in default prohibits approval',
      'Affordability not calculated: unresolved evidence or eligibility.',
      'Human decision required. This recommendation is not an issued offer.',
    ].join('\n');

    const parsed = parseCreditMemo(raw);

    expect(parsed.mode).toEqual({ mode: 'demo', fullyEvidenceVerified: false });
    expect(parsed.autoFinance).toEqual({
      vehiclePrice: '600000',
      downPayment: '150000',
      financedAmount: '450000',
    });
    expect(parsed.referralReason).toBe('SuspectedTampering');
    expect(parsed.missingEvidence).toEqual(['national_id_copy', 'salary_certificate']);
    expect(parsed.assumptions).toEqual([
      {
        reason: 'Demo mode assumes national ID presence',
        actualEvidence: 'missing',
        verified: false,
      },
    ]);
    expect(parsed.rules[0]).toEqual({
      citation: 'AUTO-2025 CP-6 default',
      clause: 'CP-6 default',
      source: 'AUTO-2025',
      status: 'fail',
      reason: 'A facility in default prohibits approval',
    });
    expect(parsed.affordability).toBeNull();
    expect(parsed.affordabilityNote).toBe('unresolved evidence or eligibility.');
    expect(parsed.otherLines).toEqual([]);
  });

  it('preserves unrecognized custom memo text in otherLines and formats helpers cleanly', () => {
    const parsed = parseCreditMemo('Controlled test-only synthetic age failure memo.');
    expect(parsed.otherLines).toEqual(['Controlled test-only synthetic age failure memo.']);
    expect(formatEgpAmount('120000')).toBe('EGP 120,000.00');
    expect(formatEgpAmount('4708.2')).toBe('EGP 4,708.20');
    expect(formatIdentifierLabel('SuspectedTampering')).toBe('Suspected Tampering');
    expect(formatIdentifierLabel('national_id_copy')).toBe('National id copy');
    expect(splitRuleCitation('2025 CP-3.1')).toEqual({ source: '2025', clause: 'CP-3.1' });
    expect(splitRuleCitation('CP-8')).toEqual({ clause: 'CP-8' });
  });
});
