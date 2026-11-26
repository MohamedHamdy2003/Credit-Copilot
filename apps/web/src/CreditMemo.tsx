import { useEffect, useRef, useState } from 'react';
import type { AssessmentResult } from './types';
import { Status } from './components';
import {
  formatEgpAmount,
  formatIdentifierLabel,
  parseCreditMemo,
  type ParsedMemoRule,
} from './memo-parser';

type MemoRuleChip = {
  code: string;
  status: 'pass' | 'fail' | 'refer';
  reason?: string;
};

function extractMemoRuleChips(
  result: AssessmentResult,
  parsedRules: ParsedMemoRule[],
): MemoRuleChip[] {
  if (result.results?.length) {
    return result.results.map((r) => ({
      code: r.rule,
      status: r.result,
      reason: r.reason,
    }));
  }
  if (parsedRules.length) {
    return parsedRules.map((r) => ({
      code: r.clause,
      status: r.status,
      reason: r.reason,
    }));
  }
  return [];
}

function recommendationTone(recommendation: string): 'pass' | 'fail' | 'refer' {
  if (recommendation === 'APPROVE') return 'pass';
  if (recommendation === 'DECLINE') return 'fail';
  return 'refer';
}

export function CreditMemoCard({ result }: { result: AssessmentResult }) {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  if (!result.memo) return null;

  const memoText = result.memo;
  const parsed = parseCreditMemo(memoText, result);
  const ruleChips = extractMemoRuleChips(result, parsed.rules);
  const passCount = ruleChips.filter((r) => r.status === 'pass').length;
  const failCount = ruleChips.filter((r) => r.status === 'fail').length;
  const referCount = ruleChips.filter((r) => r.status === 'refer').length;
  const recTone = recommendationTone(parsed.header?.recommendation ?? result.recommendation);

  const hasAlerts = Boolean(
    parsed.referralReason || parsed.missingEvidence.length || parsed.assumptions.length,
  );
  const hasMetadata = Boolean(
    parsed.mode ||
    parsed.request ||
    parsed.approvalAuthority ||
    parsed.pricing ||
    parsed.autoFinance,
  );

  async function copyMemo() {
    try {
      await navigator.clipboard.writeText(memoText);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="memo-card" aria-label="Credit memo">
      <div className="memo-card-head">
        <div className="memo-card-title">
          <h3>Credit memo</h3>
          <span className={`memo-pill memo-tone-${recTone}`}>
            {result.recommendation.replaceAll('_', ' ')}
          </span>
          {result.policyEdition && (
            <span className="memo-pill memo-neutral">{result.policyEdition}</span>
          )}
          {result.pricing && (
            <span className="memo-pill memo-neutral">
              {result.pricing.annualRatePercent}% · row {result.pricing.row}
            </span>
          )}
        </div>
        {ruleChips.length > 0 && (
          <span className="memo-tally">
            {passCount}/{ruleChips.length} passed
            {failCount > 0 ? ` · ${failCount} failed` : ''}
            {referCount > 0 ? ` · ${referCount} referred` : ''}
          </span>
        )}
      </div>
      {ruleChips.length > 0 && (
        <ul className="memo-rules">
          {ruleChips.map((r) => (
            <li key={r.code} className={`memo-rule memo-tone-${r.status}`} title={r.reason}>
              <span>{r.code}</span>
              <b>{r.status}</b>
            </li>
          ))}
        </ul>
      )}
      <div className="memo-card-foot">
        <small>
          {result.calculation
            ? `EMI: ${formatEgpAmount(result.calculation.monthlyInstallment)} · DBR: ${result.calculation.dbrPercent}% · Human decision required.`
            : 'Human decision required. This recommendation is not an issued offer.'}
        </small>
        <details
          className="memo-raw"
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary className="memo-raw-summary">
            <span className="memo-raw-summary-left">
              <svg
                className="memo-summary-icon"
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4.25 2.25H9.75L12.75 5.25V13.25C12.75 13.5261 12.5261 13.75 12.25 13.75H4.25C3.97386 13.75 3.75 13.5261 3.75 13.25V2.75C3.75 2.47386 3.97386 2.25 4.25 2.25Z"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinejoin="round"
                />
                <path
                  d="M9.5 2.5V5.5H12.5M5.75 8H10.75M5.75 10.5H9.25"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Full memo text</span>
              {parsed.rules.length > 0 && (
                <span className="memo-summary-meta">
                  {parsed.rules.length} {parsed.rules.length === 1 ? 'rule' : 'rules'}
                  {parsed.sources.length > 0
                    ? ` · ${parsed.sources.length} ${parsed.sources.length === 1 ? 'source' : 'sources'}`
                    : ''}
                </span>
              )}
            </span>
            <svg
              className="memo-summary-chevron"
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 6.25L8 10.25L12 6.25"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </summary>

          {open && (
            <article className={`memo-doc memo-doc-${recTone}`} aria-label="Full credit memorandum">
              <header className="memo-doc-header">
                <div className="memo-doc-heading">
                  <span className="memo-doc-eyebrow">Credit underwriting memorandum</span>
                  <div className="memo-doc-title-row">
                    <h4>{parsed.header?.reference ?? result.reference}</h4>
                    <span className={`memo-pill memo-tone-${recTone}`}>
                      {(parsed.header?.recommendation ?? result.recommendation).replaceAll(
                        '_',
                        ' ',
                      )}
                    </span>
                    {parsed.header?.status && <Status value={parsed.header.status} />}
                    {parsed.header?.policyEdition && (
                      <span className="memo-pill memo-neutral">{parsed.header.policyEdition}</span>
                    )}
                  </div>
                </div>
                <div className="memo-doc-actions">
                  <button
                    type="button"
                    className="memo-action-btn"
                    aria-pressed={showRaw}
                    onClick={() => setShowRaw((current) => !current)}
                  >
                    {showRaw ? 'Formatted' : 'Raw text'}
                  </button>
                  <button
                    type="button"
                    className={`memo-action-btn${copied ? ' is-copied' : ''}`}
                    onClick={() => void copyMemo()}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </header>

              {showRaw ? (
                <div className="memo-doc-raw-wrap">
                  <pre className="memo">{memoText}</pre>
                </div>
              ) : (
                <div className="memo-doc-body">
                  {hasMetadata && (
                    <dl className="memo-doc-meta">
                      {parsed.mode && (
                        <div className="memo-meta-cell">
                          <dt>Verification mode</dt>
                          <dd>
                            <strong>{formatIdentifierLabel(parsed.mode.mode)}</strong>
                            <span
                              className={`memo-inline-badge ${
                                parsed.mode.fullyEvidenceVerified
                                  ? 'memo-tone-pass'
                                  : 'memo-tone-refer'
                              }`}
                            >
                              {parsed.mode.fullyEvidenceVerified
                                ? 'Evidence verified'
                                : 'Not fully verified'}
                            </span>
                          </dd>
                        </div>
                      )}
                      {parsed.request && (
                        <div className="memo-meta-cell">
                          <dt>Requested facility</dt>
                          <dd>
                            <strong className="memo-num">
                              {formatEgpAmount(parsed.request.amount)}
                            </strong>
                            <small>
                              {parsed.request.months} months · Applied{' '}
                              {parsed.request.applicationDate}
                            </small>
                          </dd>
                        </div>
                      )}
                      {parsed.approvalAuthority && (
                        <div className="memo-meta-cell">
                          <dt>Approval authority</dt>
                          <dd>
                            <strong>{formatIdentifierLabel(parsed.approvalAuthority)}</strong>
                          </dd>
                        </div>
                      )}
                      {parsed.pricing && (
                        <div className="memo-meta-cell">
                          <dt>Applicable pricing</dt>
                          <dd>
                            <strong className="memo-num">
                              {parsed.pricing.annualRatePercent}% p.a.
                            </strong>
                            <small>
                              {parsed.pricing.sourceFile} · row {parsed.pricing.row}
                            </small>
                          </dd>
                        </div>
                      )}
                      {parsed.autoFinance && (
                        <div className="memo-meta-cell memo-meta-wide">
                          <dt>Auto finance breakdown</dt>
                          <dd>
                            <strong className="memo-num">
                              Financed {formatEgpAmount(parsed.autoFinance.financedAmount)}
                            </strong>
                            <small>
                              Vehicle {formatEgpAmount(parsed.autoFinance.vehiclePrice)} · Down
                              payment {formatEgpAmount(parsed.autoFinance.downPayment)}
                            </small>
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}

                  {hasAlerts && (
                    <div
                      className="memo-doc-alerts"
                      role="region"
                      aria-label="Exceptions and notices"
                    >
                      {parsed.referralReason && (
                        <div className="memo-alert memo-alert-refer">
                          <span className="memo-alert-label">Referral reason</span>
                          <div className="memo-alert-value">
                            <strong>{formatIdentifierLabel(parsed.referralReason)}</strong>
                            {parsed.referralReason !==
                              formatIdentifierLabel(parsed.referralReason) && (
                              <code>{parsed.referralReason}</code>
                            )}
                          </div>
                        </div>
                      )}
                      {parsed.missingEvidence.length > 0 && (
                        <div className="memo-alert memo-alert-fail">
                          <span className="memo-alert-label">Missing evidence</span>
                          <div className="memo-alert-chips">
                            {parsed.missingEvidence.map((item) => (
                              <span key={item} className="memo-pill memo-tone-fail">
                                {formatIdentifierLabel(item)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {parsed.assumptions.length > 0 && (
                        <div className="memo-alert memo-alert-refer">
                          <span className="memo-alert-label">Demo assumptions</span>
                          <ul className="memo-assumption-list">
                            {parsed.assumptions.map((item, idx) => (
                              <li key={idx}>
                                <span>{item.reason}</span>
                                {item.actualEvidence && (
                                  <small>Actual evidence: {item.actualEvidence}</small>
                                )}
                                <span className="memo-inline-badge memo-tone-refer">
                                  {item.verified ? 'Verified' : 'Unverified'}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {(parsed.affordability || parsed.affordabilityNote) && (
                    <div className="memo-doc-section">
                      <div className="memo-section-head">
                        <h5>Affordability &amp; eligibility</h5>
                      </div>
                      {parsed.affordability ? (
                        <div className="memo-doc-calc">
                          <div className="memo-calc-tile">
                            <span>Monthly EMI</span>
                            <strong className="memo-num">
                              {formatEgpAmount(parsed.affordability.emi)}
                            </strong>
                          </div>
                          <div className="memo-calc-tile">
                            <span>Debt-burden ratio (DBR)</span>
                            <strong className="memo-num">{parsed.affordability.dbrPercent}%</strong>
                          </div>
                          <div className="memo-calc-tile">
                            <span>Maximum eligible</span>
                            <strong className="memo-num">
                              {formatEgpAmount(parsed.affordability.maxEligible)}
                            </strong>
                          </div>
                        </div>
                      ) : (
                        <p className="memo-calc-note">
                          Affordability not calculated: {parsed.affordabilityNote}
                        </p>
                      )}
                    </div>
                  )}

                  {parsed.rules.length > 0 && (
                    <div className="memo-doc-section">
                      <div className="memo-section-head">
                        <h5>Policy rule evaluation</h5>
                        <span className="memo-tally">
                          {parsed.rules.filter((r) => r.status === 'pass').length}/
                          {parsed.rules.length} passed
                        </span>
                      </div>
                      <ul className="memo-doc-rules">
                        {parsed.rules.map((r, index) => (
                          <li
                            key={`${r.citation}-${index}`}
                            className={`memo-doc-rule memo-doc-rule-${r.status}`}
                          >
                            <div className="memo-doc-rule-code">
                              <span className="memo-clause-tag">{r.clause}</span>
                              {r.source && <small>{r.source}</small>}
                            </div>
                            <p className="memo-doc-rule-reason">{r.reason}</p>
                            <span className={`memo-pill memo-tone-${r.status}`}>
                              {r.status.toUpperCase()}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {parsed.sources.length > 0 && (
                    <div className="memo-doc-section">
                      <div className="memo-section-head">
                        <h5>Cited policy sources</h5>
                      </div>
                      <ul className="memo-doc-sources">
                        {parsed.sources.map((src) => (
                          <li key={src}>{src}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {parsed.otherLines.length > 0 && (
                    <div className="memo-doc-section">
                      <div className="memo-section-head">
                        <h5>Notes</h5>
                      </div>
                      <div className="memo-doc-notes">
                        {parsed.otherLines.map((line, index) => (
                          <p key={index}>{line}</p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <footer className="memo-doc-footer">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 1.75L13.25 3.75V7.75C13.25 11.05 11.05 13.65 8 14.5C4.95 13.65 2.75 11.05 2.75 7.75V3.75L8 1.75Z"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M8 5.75V8.5M8 10.75H8.01"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
                <span>
                  {parsed.disclaimer ??
                    'Human decision required. This recommendation is not an issued offer.'}
                </span>
              </footer>
            </article>
          )}
        </details>
      </div>
    </section>
  );
}
