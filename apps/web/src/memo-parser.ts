import type { AssessmentResult } from './types.js';

export interface ParsedMemoRule {
  citation: string;
  clause: string;
  source?: string;
  status: 'pass' | 'fail' | 'refer';
  reason: string;
}

export interface ParsedMemoAssumption {
  reason: string;
  actualEvidence?: string;
  verified: boolean;
}

export interface ParsedCreditMemo {
  header: {
    reference: string;
    recommendation: string;
    status: string;
    policyEdition: string;
  } | null;
  mode: {
    mode: 'strict' | 'demo';
    fullyEvidenceVerified: boolean;
  } | null;
  request: {
    amount: string;
    months: number;
    applicationDate: string;
  } | null;
  autoFinance: {
    vehiclePrice: string;
    downPayment: string;
    financedAmount: string;
  } | null;
  referralReason: string | null;
  missingEvidence: string[];
  assumptions: ParsedMemoAssumption[];
  approvalAuthority: string | null;
  pricing: {
    annualRatePercent: string;
    sourceFile: string;
    row: string;
  } | null;
  rules: ParsedMemoRule[];
  sources: string[];
  affordability: {
    emi: string;
    dbrPercent: string;
    maxEligible: string;
  } | null;
  affordabilityNote: string | null;
  disclaimer: string | null;
  otherLines: string[];
}

export function formatEgpAmount(raw: string | undefined | null): string {
  if (!raw) return '—';
  const cleaned = raw.replaceAll(',', '').trim();
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric)) return `EGP ${raw.trim()}`;
  return `EGP ${numeric.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatIdentifierLabel(raw: string): string {
  const spaced = raw
    .replaceAll('_', ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!spaced) return raw;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function splitRuleCitation(citation: string): { clause: string; source?: string } {
  const trimmed = citation.trim();
  const match = /^(.+?)\s+((?:CP|PS|PM)-\d+(?:\.\d+)?(?:\s+[a-z]+)?)$/i.exec(trimmed);
  if (match) {
    return {
      source: match[1]!.trim(),
      clause: match[2]!.trim(),
    };
  }
  return { clause: trimmed };
}

export function parseCreditMemo(
  memoText: string,
  result?: Partial<AssessmentResult>,
): ParsedCreditMemo {
  const parsed: ParsedCreditMemo = {
    header: null,
    mode: null,
    request: null,
    autoFinance: null,
    referralReason: null,
    missingEvidence: [],
    assumptions: [],
    approvalAuthority: null,
    pricing: null,
    rules: [],
    sources: [],
    affordability: null,
    affordabilityNote: null,
    disclaimer: null,
    otherLines: [],
  };

  const lines = memoText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const headerMatch =
      /^([^:]+):\s*(APPROVE|DECLINE|REFER_TO_HUMAN|OFFER_ALTERNATIVE)\s*;\s*([^;]+)\s*;\s*(.+)$/.exec(
        line,
      );
    if (headerMatch && !parsed.header) {
      parsed.header = {
        reference: headerMatch[1]!.trim(),
        recommendation: headerMatch[2]!.trim(),
        status: headerMatch[3]!.trim(),
        policyEdition: headerMatch[4]!.trim(),
      };
      continue;
    }

    const modeMatch = /^Mode\s+(strict|demo)\s*;\s*fully evidence verified:\s*(true|false)$/i.exec(
      line,
    );
    if (modeMatch && !parsed.mode) {
      parsed.mode = {
        mode: modeMatch[1]!.toLowerCase() as 'strict' | 'demo',
        fullyEvidenceVerified: modeMatch[2]!.toLowerCase() === 'true',
      };
      continue;
    }

    const requestMatch =
      /^Requested\s+EGP\s+([^;]+);\s*(\d+)\s+months;\s*application date\s+(.+)$/i.exec(line);
    if (requestMatch && !parsed.request) {
      parsed.request = {
        amount: requestMatch[1]!.trim(),
        months: Number(requestMatch[2]),
        applicationDate: requestMatch[3]!.trim(),
      };
      continue;
    }

    const autoMatch =
      /^Vehicle price\s+EGP\s+([^;]+);\s*down payment\s+EGP\s+([^;]+);\s*finance\s+EGP\s+(.+)$/i.exec(
        line,
      );
    if (autoMatch && !parsed.autoFinance) {
      parsed.autoFinance = {
        vehiclePrice: autoMatch[1]!.trim(),
        downPayment: autoMatch[2]!.trim(),
        financedAmount: autoMatch[3]!.trim(),
      };
      continue;
    }

    const referralMatch = /^Referral reason:\s*(.+)$/i.exec(line);
    if (referralMatch) {
      parsed.referralReason = referralMatch[1]!.trim();
      continue;
    }

    const missingMatch = /^Missing evidence:\s*(.+)$/i.exec(line);
    if (missingMatch) {
      for (const item of missingMatch[1]!.split(',')) {
        const clean = item.trim();
        if (clean && !parsed.missingEvidence.includes(clean)) {
          parsed.missingEvidence.push(clean);
        }
      }
      continue;
    }

    const assumptionMatch =
      /^Assumption:\s*([^;]+)(?:;\s*actual\s+([^;]+))?(?:;\s*verified=(true|false))?$/i.exec(line);
    if (assumptionMatch) {
      parsed.assumptions.push({
        reason: assumptionMatch[1]!.trim(),
        ...(assumptionMatch[2] ? { actualEvidence: assumptionMatch[2].trim() } : {}),
        verified: assumptionMatch[3]?.toLowerCase() === 'true',
      });
      continue;
    }

    const authorityMatch = /^Approval authority required:\s*(.+)$/i.exec(line);
    if (authorityMatch) {
      parsed.approvalAuthority = authorityMatch[1]!.trim();
      continue;
    }

    const pricingMatch = /^Annual rate\s+([^%]+)%;\s*source\s+(.+?)\s+row\s+(\d+)$/i.exec(line);
    if (pricingMatch && !parsed.pricing) {
      parsed.pricing = {
        annualRatePercent: pricingMatch[1]!.trim(),
        sourceFile: pricingMatch[2]!.trim(),
        row: pricingMatch[3]!.trim(),
      };
      continue;
    }

    const sourceMatch = /^Source:\s*(.+)$/i.exec(line);
    if (sourceMatch) {
      const value = sourceMatch[1]!.trim();
      if (value && !parsed.sources.includes(value)) {
        parsed.sources.push(value);
      }
      continue;
    }

    const affordabilityMatch =
      /^EMI\s+EGP\s+([^;]+);\s*DBR\s+([^%]+)%;\s*maximum eligible\s+EGP\s+(.+)$/i.exec(line);
    if (affordabilityMatch && !parsed.affordability) {
      parsed.affordability = {
        emi: affordabilityMatch[1]!.trim(),
        dbrPercent: affordabilityMatch[2]!.trim(),
        maxEligible: affordabilityMatch[3]!.trim(),
      };
      continue;
    }

    const noAffordabilityMatch = /^Affordability not calculated:\s*(.+)$/i.exec(line);
    if (noAffordabilityMatch) {
      parsed.affordabilityNote = noAffordabilityMatch[1]!.trim();
      continue;
    }

    if (/^Human decision required\b/i.test(line)) {
      parsed.disclaimer = line;
      continue;
    }

    const ruleMatch = /^(.+?):\s*(pass|fail|refer)\s*;\s*(.+)$/i.exec(line);
    if (ruleMatch) {
      const citation = ruleMatch[1]!.trim();
      const { clause, source } = splitRuleCitation(citation);
      parsed.rules.push({
        citation,
        clause,
        ...(source ? { source } : {}),
        status: ruleMatch[2]!.toLowerCase() as 'pass' | 'fail' | 'refer',
        reason: ruleMatch[3]!.trim(),
      });
      continue;
    }

    parsed.otherLines.push(line);
  }

  if (!parsed.header && result?.reference && result.recommendation) {
    parsed.header = {
      reference: result.reference,
      recommendation: result.recommendation,
      status: result.status ?? 'pending_review',
      policyEdition: result.policyEdition ?? 'Policy unresolved',
    };
  }
  if (!parsed.mode && result?.mode && result.evidence) {
    parsed.mode = {
      mode: result.mode,
      fullyEvidenceVerified: result.evidence.fullyEvidenceVerified,
    };
  }
  if (!parsed.autoFinance && result?.autoFinance) {
    parsed.autoFinance = {
      vehiclePrice: result.autoFinance.vehiclePrice,
      downPayment: result.autoFinance.downPayment,
      financedAmount: result.autoFinance.financedAmount,
    };
  }
  if (!parsed.pricing && result?.pricing) {
    parsed.pricing = {
      annualRatePercent: result.pricing.annualRatePercent,
      sourceFile: result.pricing.sourceFile,
      row: String(result.pricing.row),
    };
  }
  if (!parsed.affordability && result?.calculation) {
    parsed.affordability = {
      emi: result.calculation.monthlyInstallment,
      dbrPercent: result.calculation.dbrPercent,
      maxEligible: result.calculation.maximumEligibleAmount,
    };
  }
  if (!parsed.rules.length && result?.results?.length) {
    parsed.rules = result.results.map((r) => {
      const { clause, source } = splitRuleCitation(r.citation);
      return {
        citation: r.citation,
        clause: r.rule || clause,
        ...(source ? { source } : {}),
        status: r.result,
        reason: r.reason,
      };
    });
  }
  if (!parsed.sources.length) {
    for (const c of result?.citations ?? result?.evidence?.referral?.citations ?? []) {
      if (c && !parsed.sources.includes(c)) parsed.sources.push(c);
    }
  }

  return parsed;
}
