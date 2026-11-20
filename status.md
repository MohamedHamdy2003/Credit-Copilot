# Current checkpoint —20 November2026

Read agent.md and FEATURES.md first. Current feature: feature/agent-orchestration.
Core evaluation went through PR17/18, hybrid search through PR19/20, query
rewriting through PR21/22 and local fallback through PR23/24 after CI.
Local fallback is on main at da37033.

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
null, never invented zero. Test fakes use explicit injection. No new DB migration.

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
Both the 11/15 and 14/15 vector failure reports remain committed.

## Verified hybrid search

PostgreSQL BM25 uses existing GIN-backed lexemes and positions with statistics
scoped to the same active revision/date/product/model/dimensions as pgvector.
RRF combines the top 20 per branch (k=60); Q&A still checks each candidate's
cosine similarity against 0.65. Hybrid is the default for policy Q&A and ask;
RETRIEVAL_STRATEGY=vector and pnpm evaluate --vector retain the baseline.
No additional migration or re-ingestion required. Two added PostgreSQL tests
verify exact BM25 scores, shared filters, ties, deduplication and single-branch
matches. Local 96 unit, 30 integration and 8 Chromium checks passed, along with
offline 15/15, type checks, lint, format and build.

Clean hybrid run 7e9832f passed 15/15, hit@5 4/4, evidence coverage 8/8, OOC 3/3,
numerics 17/17, security/audit 80/80 and Strict packs 5/5. First result hit was
4/4, compared with 4/4 for vector. The first two hybrid runs returned 14/15
with ProviderUnavailable in Q03 and Q02 respectively. All reports are committed.
The evaluator retains ranks before generation and allows at most two upstream
case retries per live run. Case-level retries used in the passing report: 0.

## Verified query rewriting

Hybrid Q&A appends up to two fixed search aliases by default. The original masked
question drives the embedding, original lexical search and evidence generation.
Both lexical variants use one database snapshot and the same trusted scope.
An alternate only fills an original slot below the configured cosine floor if
it is new and passes the floor. Approval bypasses use the original search.
Set QUERY_REWRITE_MAX_EXPANSIONS=0 to disable it, or compare pnpm evaluate --hybrid
and pnpm evaluate --rewrite. Local 100 unit, 31 integration and 8 Chromium
checks passed. The offline suite passed 15/15, and type, lint, format and build
checks passed.

Clean Gemini run a1b855b passed 15/15 with hit@5 4/4, citation coverage 8/8,
OOC refusals 3/3, exact numerics 17/17, security/audit 80/80 and Strict packs 5/5.
Glossary expansion ran for Q01, Q02, Q03 and promoted 0 candidates. The run used
7 embedding calls, 12 generation calls and 0 case-level provider retries. See
query-rewrite-core-evaluation.json for the trace and case results.

## Verified local fallback

API and CLI wire generation fallback only when OLLAMA_FALLBACK_ENABLED=true.
Gemini retries transient HTTP/transport failures before making one local Ollama
request. Authentication, configuration and invalid generation responses return
errors. All embeddings stay on Gemini. The source-verification gate and human
approval flow apply to local output. Both model attempts get separate usage
records and the assessment records a fallback audit event.

Clean commit 01beb5d passed both real Ollama 0.40.16 smoke cases with
qwen3:4b-instruct-2507-q4_K_M on CPU and an injected Gemini outage.
APP-001 source-verified extraction and the code-filled pending memo took
55.35 s. Grounded CP-4.1 quote took 29.18 s. The Docker container
used 5.531 GiB after the run. Recorded in ollama-fallback-smoke.json.
Locally passed 111 unit, 32 integration, 8 Chromium, offline 15/15 and
type checks, lint, format, and build. Implementation and evidence are in PR23.

## Typed agent implementation

Opt in with ASSESSMENT_ORCHESTRATION=agents in API and CLI. Each of three
Mastra agents requests one tool through a strict provider JSON contract. The
server binds sanitized extraction inputs, dated policy scope and verified
memo inputs. A rejected or unavailable planner routes the same operation through
the baseline. A started tool never reruns. Preflight referrals skip model calls.
Tool outcomes and planner usage are recorded without prompts or applicant data.
The workflow default and existing lifecycle remain. The first live run scored
12/15 after Gemini became unavailable. Its report is retained. A paced repeat
will measure actual tool execution without changing the assessment runtime.

## Next and honest readiness

Typed Tool-Calling Agents (P13) is next in the PR plan. Six stretches remain.
The core memo and audit use plain wording as allowed by the brief. Final video and interactive clean-clone
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
