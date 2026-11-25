# Current checkpoint — 25 November 2026

Read agent.md and FEATURES.md first. Current release checkpoint: P18.
Core evaluation went through PR17/18, hybrid search through PR19/20, query
rewriting through PR21/22 and local fallback through PR23/24 after CI.
P17 usage accounting reached main through PR34 before this release.

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

## Verified typed agents

Opt in with ASSESSMENT_ORCHESTRATION=agents in API and CLI. Each of three
Mastra agents requests one tool through a strict provider JSON contract. The
server binds sanitized extraction inputs, dated policy scope and verified
memo inputs. A rejected or unavailable planner routes the same operation through
the baseline. A started tool never reruns. Preflight referrals skip model calls.
Tool outcomes and planner usage are recorded without prompts or applicant data.
The first live run scored 12/15 after Gemini became unavailable and is retained.
A clean rerun at 2cf9a5d with 6500 ms generation pacing passed 15/15 and verified
18 executed and persisted tool calls, security/audit 94/94, exact numerics 17/17,
hit@5 4/4 and Strict packs 5/5. Paired tests matched all original packs in Strict
and Demo. Local checks passed 121 unit, 32 integration, 8 Chromium, both offline
suites 15/15, type checks, lint, formatting and build. See PR25 and the reports
under data/evaluation/results.

## Review fixes and streaming

Review fixed two problems before P14. The embedding index now keeps distinct
dimensions for the same chunk and provider model. Reingestion verifies that
the current active chunks actually have the requested model and dimensions.
Direct retrieval masks Egyptian IDs and phone numbers before provider or
lexical search, including callers outside the policy question API.

P14 adds authenticated, owner-scoped SSE for eight assessment stages and
verified policy citations. React resumes from the last event ID. Idempotent
starts and read-only reconnects keep one run and one review record even if the
reader disconnects. Revoking the session closes the stream. Assessments
replay from PostgreSQL. Policy citation replay stays in the API process for
five minutes after completion. The synchronous endpoints remain available.
Local checks covered 121 unit tests, 36 PostgreSQL/HTTP tests, 9 Chromium
journeys, type checks, lint, formatting and builds. The offline workflow and
agent evaluations each passed 15/15 using deterministic fixtures. Live model
quality was measured in the prior baseline and agent runs.

## Original-source review and P15

The uploaded DOCX brief, corpus inventory and 12 provided sources were reviewed.
All 12 SHA-256 digests match the checked-in originals. The procedures PDF has
a filename suffix only. Fixed comparable employer mismatches, mandatory
decline on verified default, eligibility before rate selection, retrieval of
applicable circular and product clauses, upload filename provenance and stale
assessment job blocking. Policy conflict answers explain operative rules using
verified evidence in REST and SSE. Mastra planning prompts are stored in files.

AL-200 adds four trusted policy sources and three separate private case PDFs.
The reviewed form selects product-specific dates, clauses and pricing. The
required quotation and 25% down payment precede exact vehicle finance and
affordability calculations. Supplemental cases record passing finance, failed
down payment, missing quote, and dated product isolation. The fifteen-case
personal-loan evaluation uses corrected core-15-v2 criteria. Historical v1
cases and live reports remain available. V2 was measured offline.
Local checks passed 131 unit tests, 38 PostgreSQL/HTTP tests and 10 Chromium
journeys. Both offline modes passed 15/15, with 8/8 required citations and
17/17 numeric assertions. Type checking, lint, formatting and builds passed.

## Issued offer PDF and repayment schedule

Issuance freezes the approved principal, dated CSV rate, source conditions,
approval and issuance identities and cent-exact schedule in the offer record.
An approved alternative uses its accepted amount. The download requires an
issued offer and a session belonging to its owner or an authorized reviewer.
Older offers can render from matching immutable approval, assessment and
issuance records. An incomplete legacy record retains its JSON details and
returns `OfferDocumentUnavailable` for the PDF.
Local checks passed 143 unit tests, 39 PostgreSQL/HTTP tests, 10 Chromium
journeys, types, lint, formatting and production builds. Both core-15-v2
offline modes passed 15/15 using deterministic provider fixtures.

## Per-user usage and cost accounting

The Usage page and actor-scoped API report native sends, retries, failures,
fallbacks and historical assessment calls. Run and step labels connect activity
to an assessment. The ledger uses stable event IDs to retry writes without
adding duplicate totals. Rates are stored with each recognized-model event.
Missing token or billing data stays unknown and partial subtotals are marked.
The live probe matched 18 input and 9 output tokens with a USD 0.00002790 list
estimate. The embedding input count and account charges were unreported.
Local checks passed 152 unit tests, 42 PostgreSQL/HTTP tests, 11 Chromium
journeys, type checks, lint, formatting and builds. Both core-15-v2 offline
suites passed 15/15.

## P18 release verification

- An anonymous HTTPS clone from public main opened a separate Compose project.
  The first live bootstrap indexed eight sources before Gemini returned HTTP 429.
  A second bootstrap skipped the completed sources and finished all eleven.
  The release seeder now spaces document embeddings by 750 ms by default. A
  clean checkout of a1b6dc3 then ran the updated launcher against a new empty
  database. All nine migrations and eleven sources completed with zero failed
  ingestion attempts. API and web readiness took 117 seconds.
- The browser rehearsal used real Gemini with synthetic data. It verified the
  50% and 45% policy answers, cited evidence and the out-of-corpus refusal.
  It also verified the Strict missing-ID referral, APP-001 Demo's EGP 8,630.39
  instalment and EGP 330,000 capacity, APP-004's fraud referral, the Credit
  Officer's authority denial, Senior approval and actual PDF download,
  the Usage ledger, and the AL-200 EGP 6,623.47 instalment.
- Release checks on the clean candidate include 152 unit tests, 42 PostgreSQL/
  HTTP tests, 11 Chromium journeys, lint, formatting, type checks and the API
  and web production build. Both current deterministic modes passed 15/15.
- The first clean v2 live agents run passed 14/15. Gemini failed all three
  attempts to plan Q14's policy-read tool. The audited fallback completed the
  same bounded read and the human approval checks passed. The agent-execution
  assertion still failed and the report is retained.
  [Initial live v2 report](data/evaluation/results/release-core-v2-initial-failure.json)
- The repeat at 8,500 ms generation spacing on the same clean a1b6dc3
  commit passed 15/15. Retrieval hit@5 was 4/4, citation coverage 8/8,
  out-of-corpus refusals 3/3, exact calculations 17/17, security and audit
  assertions 94/94 and original Strict packs 5/5.
  [Passing live v2 report](data/evaluation/results/release-core-v2-agents.json)
- The local 3:53.60 WebM in artifacts/release/Credit-Copilot-demo.webm was
  recorded in the application and visually checked. It uses synthetic
  cases and a deterministic provider fixture, labeled in English captions.
  It shows a trusted upload, cited DBR changes, refusal, calculations, tampering,
  the over-limit denial, an independent Head approval and the issued PDF.
- Before P18 promotion the public repository already had 45 non-merge commits
  across four Cairo dates and 17 merged PRs to main. The original exercise
  asks the candidate to keep the repository public for 30 days. Its overview
  mentions 12 calendar days and its submission section specifies day 10 by
  23:59 Cairo. The invitation date, candidate time and reflection, unlisted
  upload and submission are still candidate-owned.

## Full-stack Docker Compose — feature/compose-full-stack

`docker compose up --build` now builds one local development image with the API
and Vite, starts it after PostgreSQL is healthy, then runs migrations, trusted
policy ingestion and demo-user seeding. The Compose-managed launcher skips
trying to start Docker from inside its own container. The database volume stays
when containers stop. Starting the app again repeats the idempotent source seed
and resets the four demo passwords and sessions. The API binds to the container
interface while its host port remains loopback-only. `README.md` documents
`GEMINI_API_KEY`, the unique demo password and optional port overrides.

Verified `docker compose config --quiet`, built the app image from a 3.53 MB
context with `.env` excluded, and passed TypeScript, formatting and whitespace
checks. Full Compose startup and live policy ingestion have not been run as part
of this change. They require a configured `DEMO_PASSWORD` and Gemini quota.
This is a local review/development image, not a production deployment.

## Fixed decisions

Strict default; missing ID=>REFER_TO_HUMAN CP-8/PS-7. Explicit synthetic Demo assumes
only ID presence, with actual missing reality/verified=false retained through offer/
written reply. Never invent ID/probation. CP2024/2025 DBR50%/45%,capacity382000/330000
through unchanged Decimal formula; actual source wins over Appendix E. Remove
protected attributes before model/rules; customer packs never KB. Authority0/250k/
500k/1m and four-eyes. No missing-evidence/pricing/policy-exception bypass. PM-9 is
written reasons, not an appeal override; Cairo inclusive30 calendar days from recorded
rejection. PM-4 target is indicative with configured Fri/Sat/holidays. Fraud routing
internal only. Secrets are kept in the ignored .env file. Tests *_test, live eval *_eval;
no concurrent suites against shared test DB. DB54329; web origin must match browser.
