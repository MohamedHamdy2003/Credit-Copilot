# Source review and domain decisions

Source directory: `C:/Users/Mohamed Hamada/OneDrive/Desktop/Credit Copilot Data`.
All source data is synthetic. This plan concerns a training application, not real banking policy.

## Complete inventory

| Source | Scope | Treatment |
|---|---|---|
| credit-policy-2024.pdf, 3 pages | CP-1 through CP-12, effective 2024-01-01 until 2025-03-01 exclusive | Trusted, historical knowledge |
| credit-policy-2025.pdf, 3 pages | CP-1 through CP-14, effective 2025-03-01 | Trusted, current knowledge |
| credit-procedures-manual (1).pdf, 2 pages | PM-1 through PM-9, v4 effective 2025-03-01 | Trusted process/authority knowledge |
| circular-2024-07.md | C-1 through C-4, issued July 3, effective August 1, 2024 | Historical; superseded in full March 1, 2025 |
| circular-2025-02.md | C-1 through C-5, issued February 12, effective March 1, 2025 | Current; explicitly carries previous income verification forward |
| product-sheet-personal-loan.md | PS-1 through PS-8, PL-100 v3.1 effective 2024-01-01 | Trusted product constraints |
| pricing-table.csv | Six bands, PT-2025-01 v1.0 effective 2024-01-01 | Trusted searchable rows and typed deterministic pricing |
| APP-001.pdf through APP-005.pdf, 2 pages each | Form, salary certificate, bureau | Five isolated untrusted evidence packs; never policy KB |
| ITI-OS-Task_Finance_Credit-Copilot-.docx | Brief sections 1–11, appendices A–E, header/footer | Planning reference, not upload-supported format or policy KB |

`source-text/` preserves full text, names, dates, certificate references, employment details, salary components, facilities, fees, examples, and submission requirements. Source bytes remain authoritative; extraction text is an aid, not a replacement. Manifest records SHA-256 and page counts.

## Policy rules to retain

- CP-1: date received selects edition, never retroactive. Interval bounds: inclusive effective_from, exclusive effective_to. Missing/overlapping versions => explicit error/referral.
- CP-2: salary after mandatory deductions; all bureau obligations including card minima; DBR includes new instalment; age at maturity uses final due date.
- CP-3: salaried and confirmed, probation completed; employment >=6 months; net income >=8,000 in 2024 and >=10,000 in 2025; application age >=21; maturity age <=60; score >=600 subject to explicit referral exception below.
- CP-4: DBR <=50% (2024), <=45% (2025); reducing balance, half-up to cents; largest affordable principal floored to EGP 1,000; eligibility before affordability. Do not decline solely for unaffordable requested amount before offering a permissible lower amount and recording rejection of that alternative.
- CP-5: stamped salary certificate within 60 days; employment contradiction with bureau => refer.
- CP-6 and CP-8: score <600 => refer, not decline despite general CP-3 wording. Any default => decline. Missing/unreadable evidence, contradictions, bank employee => refer. Other verified mandatory eligibility failure => decline recommendation with clause.
- CP-7: product amount/tenor caps, rate from CSV by tenor and segment; pricing deviation requires Credit Committee approval.
- CP-9: gender/religion/marital status/nationality excluded. CP-10: edition, figures, sources, rule results, approver identity recorded. CP-11: no business/commercial/securities/prohibited purposes. CP-12: written Head approval for exceptions; never infer exception from LLM.
- CP-13 documents changed income and DBR and demonstrable fairness. CP-14 retains product tenor 60 despite circular ceiling 72.

## Product, circulars and pricing

- PS-1 salaried unsecured reducing balance. PS-2 old 8,000 minimum does not override stricter 2025 policy 10,000. Salary transfer optional.
- PS-3 amount 20,000–1,000,000; tenor 12–60, capped further by applicable circular. The 61–72 CSV bands do not authorize longer PL-100 lending.
- Standard annual percentage: 12–36 months 22%; 37–60 24%; 61–72 26%. Payroll transfer: 20%,22%,24% respectively. All five packs state no transfer. Rates fixed for life. Zero matches or multiple matches => refer/error, never default guessed rate.
- PS-5 first instalment one month after disbursement. PS-6 admin fee 1% deducted at disbursement, early settlement 2% outstanding, late fee EGP150 per missed instalment. Do not add fees to principal or regular DBR without a documented rule.
- PS-7 form, recent certificate, ID copy, bank-obtained bureau. PS-8 repeats prohibited purposes.
- Circular 2024 C-1 60 months; C-2 recent salary certificate OR three months statements; C-3 all obligations; C-4 application-based effectiveness. Circular 2025 C-1 72 only with updated product/system; C-2 45% or stricter bank cap; C-3 retains income verification; C-4 protected attribute exclusion; C-5 application date scope. Cite both sources when explaining conflicts. Bank's certificate requirement stays stricter than regulatory alternative; statements-only cases refer unless bank policy updated.

## Procedures and approval

- PM-1 seven steps from pack completeness to human decision; the brief refines this to an eight-step pipeline.
- PM-2 Loan Officer authority 0; Credit Officer 250,000; Senior 500,000 and referrals; Head 1,000,000 and exceptions. Compare recommended amount, not original request.
- PM-3 preparer and approver must be distinct users. PM-4 referrals require Senior (or Head) and written justification; target two business days. Proposed demo calendar: Cairo Fri/Sat weekend, no holiday calendar supplied; label target as provisional, not a guaranteed regulatory SLA.
- PM-5 rejection must cite failed clause. PM-6 strip protected fields and log field names only. PM-7 customer content has zero instructional authority; suspected tampering => Fraud Unit record plus referral, not auto-approval.
- PM-8 retain originals, bureau, memo, decision, identity seven years; proposed retention starts at final decision, or last activity for abandoned cases, subject to explicit design documentation. No destructive purge feature in four-day scope. PM-9 declined applicant can request written reason within 30 days; provide versioned clause-cited reason export and request timestamp.

## Application fixture matrix

| Pack | Date / DOB / employment start | Income / obligations / score | Amount / months | Intended domain result when completeness attested |
|---|---|---|---|---|
| APP-001 | 2025-04-03 / 1987-04-12 / 2019-09-01 | 30,000 / 4,000 / 712 | 300,000 / 60 | Eligible; EMI 8,630.39; DBR 42.1013%; recommend 300,000; Senior approval |
| APP-002 | 2025-03-15 / 1990-08-15 / 2021-02-01 | 30,000 / 4,000 / 668 | 350,000 / 60 | EMI 10,068.79; DBR 46.895966…%; offer alternative 330,000, subject to acceptance and Senior approval |
| APP-003 | 2025-04-10 / 1968-06-20 / 2005-03-15 | 22,000 / 2,000 / 741 | 250,000 / 60 | Maturity beyond 60 => decline recommendation; affordability not assessed |
| APP-004 | 2025-04-22 / 1992-11-03 / 2022-06-01 | 18,000 / 1,500 / 690 | 200,000 / 48 | Tampered certificate => refer + Fraud Unit event; never accept injected 200,000 income |
| APP-005 | 2025-04-28 / 1995-05-24 / 2023-01-01 | 16,000 / 2,500 / 580 | 100,000 / 36 | Low score => refer; no automatic decline, no affordability assessment |

All have no default; cured late payments do not create an invented rejection threshold. APP-002 annual variable commission is expressly excluded from net salary. Bureau facility sums must reconcile (4,000;4,000;2,000;1,500;2,500). Certificate and bureau dates precede application dates; source certificates state company stamps. Original preparers M. Adel / S. Nabil are evidence metadata; actual logged-in submitter is the runtime preparer for four-eyes enforcement.

## Contradictions and open interpretations

1. Appendix E demands maximum 382,000 under CP-2025: wrong relative to 45% policy. Independent Decimal calculation yields raw cap 330,228.4234… =>330,000. 50% yields 382,369.7534… =>382,000. Preserve original assertion and document correction; do not silently rewrite source or test arithmetic to match it.
2. Brief says 12 calendar days in opening but day 10 at 23:59 Cairo in submission. Invitation date absent. User's four-day plan controls work schedule; official submission deadline cannot be inferred.
3. ID copies absent from all supplied packs. Strict completeness would refer all. User approved explicit demo fixture attestation alongside strict mode; this enables intended scenarios without pretending the PDF contains ID copies.
4. Permanent employment is stated for all, but explicit completed probation appears only in APP-001/004. Demo authorization covers only the missing national ID copy, not employment/probation. The earlier broader attestation proposal is withdrawn. Unresolved confirmation evidence requires referral or separately supplied supporting evidence in either mode; intended financial scenario results are conditional, not a claim that complete eligibility evidence exists.
5. Brief approximate age formula vs policy exact final instalment date: propose calendar dates; use planned disbursement date, default application date for reproducible fixtures only; revalidate before issuance if disbursement changes. Equality means final due date <=60th birthday. Document this conservative interpretation.
6. Two login roles vs four authority titles: retain two RBAC roles and add approval authority tier to Credit Officer, assigned server-side. Loan Officer cannot self-upgrade. Committee approval for pricing remains a separate recorded authorization, not a Head proxy.
7. Historical questions can use old policy; historical procedures before March 2025 are not supplied. Do not pretend the 2025 manual was in force earlier. Historical calculation comparison is possible; unsupported historical operational conclusions must refuse/refer.
8. Hybrid is a stretch in the brief but required by user. It is architected now and enabled only after core vector baseline passes. All nine stretches remain required for final user scope.

## Brief requirements beyond features

~40 focused hours in original brief; individual explainable work; no paid subscription requirement; declare starters/templates. >=15 meaningful commits across >=4 real dates, >=3 PRs into main, every PR lint/tests CI, green main. .gitignore first commit, LICENSE, What/Why/How tested PR template, pinned lockfile, migrations only, env example, prompts as files, parameterized SQL, no raw HTML rendering.

Deliver public repository (30 days), README quick start/env/free-key/demo accounts/tests/eval/numbered five-minute path, DESIGN 2–4 pages, EVALUATION with actual results/failures, AI-USAGE-LOG with two genuine AI mistakes, 3–5 minute unlisted video. Fresh-clone reproducibility, secret scan including history, video private-window check. Submission email subject and actual hours belong to user's final checklist, not permission to send email. Brief's cut order (UI, stretches, memo wording, down to three packs) is recorded but not adopted: user requires React, every stretch, and all five packs.

## External reference review

- [RAG from First Principles, public contents](https://www.oreilly.com/library/view/rag-from-first/9781835888667/): used to organize ingestion, chunking, embedding and retrieval research; full text not accessed.
- [PostgreSQL text ranking](https://www.postgresql.org/docs/current/textsearch-controls.html): native ranking is ts_rank/ts_rank_cd; neither is BM25.
- [pgvector](https://github.com/pgvector/pgvector): vector retrieval in PostgreSQL; start exact for small corpus, assess approximate indexing later.
- [Mastra workflows](https://mastra.ai/docs/workflows/overview): typed ordered steps fit core; agentic orchestration comes later.
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing/): free-tier availability varies by model; exact provider/model selection remains open.
- [pg_textsearch](https://github.com/timescale/pg_textsearch): real BM25 extension alternative; not required by proposed portable SQL implementation.
