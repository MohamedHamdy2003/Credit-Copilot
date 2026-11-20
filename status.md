# Current checkpoint —20 November2026

Read agent.md and FEATURES.md first. Current feature: feature/hybrid-search.
Previous referrals PR15/16 merged on main0c96d9e, CI44721070688 green. Check git/PRs
for current promotion. Functional core gate passes measured15 cases; this is not
final-submission certification. Hybrid BM25+pgvector/RRF is next.

## Implemented

Frozen cases data/evaluation/cases.json; scorer/schema in application/evaluation.ts;
CLI orchestration scripts/evaluate.ts + scripts/evaluation/runner.ts; hash/token
meter in infrastructure/evaluation-meter.ts. Live mode uses an isolated *_eval DB,
real Gemini/vector query calls, actual Mastra/private persistence and real Nest
HTTP authority transitions. Exact source/model/dimension document vectors can be
reused from trusted KB; no private case records touched in app DB. Offline mode
uses a *_test DB with source/provider fixtures, reports semantic hit-rate as null
and live quality as not_measured. CLI writes timestamped immutable ignored reports,
nonzero exit on failure; cases/initial/final sanitized JSON evidence are committed.
CI runs pnpm evaluate:core:offline after integration, never concurrently on *_test.
Old five-question smoke moved to evaluate:smoke; simple unit subset stays
pnpm evaluate:offline.

Initial real run:11/15 despite raw vector hit4/4, refusal7/7,OOC3/3,numerics17/17.
Q01/02/03 omitted operative/conflict citations; Q11 fraud referral skipped policy
selection and persisted null edition. Fixes: source metadata to generation;
separate date/product-filtered operative source-reference context for income/
tenor conflicts, retained verbatim after a valid non-refusal model choice. Primary
vector top5/ranking/threshold remain unchanged; this is NOT BM25/RRF/rewriting or
semantic re-ranking. Forged/blank quotes, weak hits or model refusals still refuse.
Policy selection now executes on a valid form date after tampering detection;
model/rules remain skipped. A repeat run scored 14/15 because the model refused Q10 without procedure
citations. Q10 now explicitly rejects the bypass and quotes dated PM-1/2/3 when
supported by a qualifying procedure hit. The repeat failure report is retained.

Code-filled credit-memo.ts supplies safe memo even for referrals and CSV provenance;
no LLM arithmetic/prose. Failed JSON retains reported usage; unavailable usage is
null, never invented zero. Production provider config accepts Gemini only; test
fakes are explicit injection, not silently selected runtime adapters. Removed dead
DATA_DIR/Ollama placeholders from active config. No new DB migration.

pnpm dev now waits for Compose health, runs explicit migrations and launches API/
Vite using matching PORT/WEB_ORIGIN. Ctrl+C stops its API/web, DB retained. Smoke
passed on4306/5176 (health ok,web200); both ports closed on stop. It is local setup,
not deployment. README rewritten compactly with all config, data sent to provider,
numbered demo path and repeatable commands. DESIGN/EVALUATION/AI log and FEATURES
updated without extra docs.

## Verified and remaining evidence step

95 unit,28 PostgreSQL/HTTP integration,8 Chromium e2e,offline15-case evaluation and
live15-case evaluation passed; types/lint/format/build pass. The evidence-consistency scorer rechecks committed results instead of trusting pass flags. Cases assert financial-only/rule outputs separately from original
APP002/003/005 missing-probation referrals; no invented probation or ID. Q15 paired
normalized protected changes have equal provider-input hashes/rules/calcs/memo;
no original PDF replaced or indexed. Billing/embedding/retry token cost remains
unknown; only available generation tokens reported. Initial failed report retained.

Clean live vector baseline f04a6dc passed 15/15, hit@5 4/4, evidence coverage
8/8, OOC 3/3, exact numerics 17/17, security/audit 80/80 and Strict packs 5/5.
Gemini reported 7666 input and 1891 output tokens across 12 generation calls,
with 7 query embeddings. Immutable report published as vector-core-baseline.json.
Both the 11/15 and 14/15 failure reports remain committed. Core promotion through
green feature→dev and dev→main PRs follows this evidence.

## Hybrid implementation checkpoint

PostgreSQL BM25 uses existing GIN-backed lexemes and positions with statistics
scoped to the same active revision/date/product/model/dimensions as pgvector.
RRF combines the top 20 per branch (k=60); Q&A still checks each candidate's
cosine similarity against 0.65. Hybrid is the default for policy Q&A and ask;
RETRIEVAL_STRATEGY=vector and pnpm evaluate --vector retain the baseline.
No additional migration or re-ingestion required. Two added PostgreSQL tests
verify exact BM25 scores, shared filters, ties, deduplication and single-branch
matches. Local 95 unit and 30 integration tests, type checks, lint, format and
build passed. The clean live hybrid evaluation and comparison follow.

## Next and honest readiness

Hybrid BM25+vector/RRF with real before/after evaluation using same corpus, dates,
model/dimensions, questions, threshold and source-context policy. All9 stretches
still pending. Functional core memo/audit rows are baseline-complete; plain wording
is an intentional cut allowed by the brief. Final video and interactive clean-clone
walkthrough are pending. Before this feature history had25 non-merge commits over
only3 real Cairo dates(17,19,20 November); four-date brief requirement is unmet.
Never fabricate dates, history, billing costs or final submission status. No email
or video upload authorized/performed.

## Fixed decisions

Strict default; missing ID=>REFER_TO_HUMAN CP-8/PS-7. Explicit synthetic Demo assumes
only ID presence, with actual missing reality/verified=false retained through offer/
written reply. Never invent ID/probation. CP2024/2025 DBR50%/45%,capacity382000/330000
through unchanged Decimal formula; actual source wins over Appendix E. Remove
protected attributes before model/rules; customer packs never KB. Authority0/250k/
500k/1m and four-eyes. No missing-evidence/pricing/policy-exception bypass. PM-9 is
written reasons, not an appeal override; Cairo inclusive30 calendar days from recorded
rejection. PM-4 target is indicative with configured Fri/Sat/holidays. Fraud routing
internal only. Secrets local.env; never print them. Tests *_test, live eval *_eval;
no concurrent suites against shared test DB. DB54329; web origin must match browser.
