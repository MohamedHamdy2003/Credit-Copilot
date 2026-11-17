# Pull request plan and four day schedule

Planning date: 2026-11-17, Africa/Cairo. Execution window: November 17–20 inclusive. This file defines the requested PR sequence. Actual completion and merged PRs are tracked in status.md and GitHub; planned checks below are not proof of execution.

## Workflow and time budget

Create main and dev during implementation. Branch each feature from current dev, run checks, open feature -> dev PR, merge only green. Promote tested dev -> main through explicit release PRs; never bypass dev or rewrite dated commit history. Require >=3 meaningful PRs into main (the brief), not merely three feature PRs into dev. Proposed four promotions R1–R4 below. Feature PR squash is acceptable only while preserving >=15 meaningful commits across all four actual Cairo calendar dates; aim >=20, include distinct release milestones. No fake dates or empty commits.

Estimate for a minimal complete implementation of core plus every stretch: 52 focused hours + up to 8 hours contingency over four days, approximately 13–15 focused hours/day. This is an aggressive capacity assumption, not a guarantee. The brief's ~40 hours targets core; all stretches add work. Planning time counts toward actual hours. If available hours are lower, all-scope/four-day delivery is at risk; disclose incomplete gates instead of silently removing user requirements. Keep UI minimal, reuse validated core services, avoid extra interactive CLI and optional infrastructure. User decides any later deadline/scope change.

| Date | Budget | Work and end-of-day evidence |
|---|---:|---|
| Tue Nov 17 | 12h | Planning decisions; P01–P05 foundations, DB, ingestion, arithmetic, vector Q&A; R1 main checkpoint |
| Wed Nov 18 | 14h | P06–P09 application pipeline, approval, React, evaluation; core gate; R2 complete-core promotion |
| Thu Nov 19 | 14h | P10–P14 hybrid, rewriting, local fallback, agents, SSE; R3 stretch tranche promotion |
| Fri Nov 20 | 12h + contingency | P15–P18 corpus/auto product, letters, usage, final docs/video/verification; R4 release |

Core gate must pass before P10–P17 starts. If core slips, do not overlap unfinished core with stretches to claim compliance. Reforecast remaining hours explicitly. Finish code before final demo recording and fresh-clone rehearsal. User's project deadline is end of Nov 20 Cairo for this plan; official invitation deadline is unverified.

## CI design agreed with user

GitHub Actions on every PR to dev and main, plus pushes to both. Jobs: frozen-lockfile install; ESLint/Prettier check; typecheck; Jest unit/fake-pipeline/fairness; production builds; PostgreSQL+pgvector migration-from-empty and upgrade smoke; ingestion/retrieval integration; deterministic RAG evaluation; secret scanning. Pin action revisions and runtime/package versions. Artifact reports include failed cases and coverage; no fabricated green status.

PR checks run offline/fake generation without API keys, including fork PRs. Retrieval evaluation uses deterministic fixture embeddings or a clearly labeled frozen real-embedding snapshot tied to a model and corpus hash. This verifies regression, not current provider quality. Manual workflow_dispatch release evaluation uses repository secrets and real provider to produce actual vector/hybrid/rewrite reports; same frozen cases, prompts and model config for fair comparisons. Gate release on reviewed real evaluation as well as offline CI; avoid making every PR depend on provider quotas. Never expose keys to untrusted PR workflows or use pull_request_target to run untrusted code.

No automatic deployment requested. Compose packaging and image build validation are CI concerns; production hosting is outside this four-day release unless separately requested. GitHub remote/repo name/account and permissions are collected when implementation reaches repository setup; none needed to author this plan.

## Feature PR descriptions

Each How tested below is a planned acceptance check. During implementation replace it with exact commands, observed results, and any known failures. Never paste planned checks as past-tense proof. Add actual What/Why adjustments if scope changes.

### P01 — Establish workspace and reproducible checks

Branch: feature/project-foundation. Day 1. Depends on approved planning decisions.

- What: TypeScript pnpm workspace, minimal Nest/React skeleton, Jest, lint/format/types, .gitignore in first commit, LICENSE, env example, prompt directory, PR template, GitHub Actions scaffold, initial AI-use/time log.
- Why: establish reproducibility, enforce boundaries and satisfy workflow requirements from the first code commit.
- How tested: clean frozen install; lint/types/Jest smoke/build; verify env ignored, lockfile tracked, no secrets; minimal API health and web load.

### P02 — Add PostgreSQL storage and domain contracts

Branch: feature/storage-contracts. Day 1. Depends P01.

- What: Compose DB with pgvector; TypeORM migrations, schemas, repositories/ports, shared validation and error envelope; immutable source/run ids and lifecycle types.
- Why: policy/evidence separation, versioned reproducible runs and safe schema evolution must precede ingestion.
- How tested: migrations on fresh DB and previous schema; constraints reject duplicate/referencing-invalid rows; knowledge repository cannot read evidence; domain dependency-boundary test.

### P03 — Build validated parsers and idempotent ingestion

Branch: feature/document-ingestion. Day 1. Depends P02.

- What: PDF/CSV/MD registry, upload limits, normalization/provenance, clause chunking, trusted manifest, document status, atomic indexed revisions, typed pricing rows; seed all source files into correct stores.
- Why: preserve table/page/clause evidence and stop malformed or untrusted documents entering policy knowledge.
- How tested: all seven trusted files parse; five packs remain isolated; repeat/concurrent ingestion no duplicates; APP-001 page-spanning salary; reject DOCX/spoofed types/oversize/scanned/encrypted/corrupt inputs; embedding failure leaves no partial searchable revision.

### P04 — Implement exact lending calculations and versioned rules

Branch: feature/calculation-rules. Day 1. Depends P02, typed pricing contract P03.

- What: pure decimal EMI/DBR/max principal, date/age/employment rules, source-backed edition resolution, CSV rate matching, eligibility/referral precedence, product/fee constraints.
- Why: LLM must never calculate; correct temporal rules and documented Appendix E correction prevent unsafe recommendations.
- How tested: same formula yields 8,630.39 EMI and maximum382,000 under CP-2024/50% versus330,000 under CP-2025/45%; versioned configuration/provenance and request-override rejection; exact-boundary/zero rate/zero obligations/date/product/score/default cases; no network/database in pure rules. Explain Appendix E discrepancy in DESIGN.md and EVALUATION.md; never hardcode expected outputs into the engine.

### P05 — Add vector retrieval and cited policy questions

Branch: feature/grounded-vector-qa. Day 1. Depends P03/P04.

- What: provider ports/fake and free-tier adapter, embedding metadata, filtered exact pgvector search, top-5 citations, evidence threshold/refusal, numeric question tool, version-conflict explanations and baseline evaluation capture.
- Why: establish mandatory semantic baseline before hybrid and give policy answers inspectable evidence.
- How tested: historical/current questions retrieve correct edition; 60 vs72 explanation includes both limits; out-of-corpus refusal; forged citations/quotes rejected; numeric answers come from calculator; provider smoke clearly distinguished from offline tests.

### P06 — Add sanitized eight-step assessment workflow

Branch: feature/application-assessment. Day 2. Depends P03–P05.

- What: local form validation/redaction, Mastra typed workflow, structured LLM extraction with quote/value verification, code-generated numeric memo, immutable runs/audit, explicit strict/demo modes, Fraud Unit referral record.
- Why: safely turn untrusted applications into traceable recommendations without injecting instructions or protected fields.
- How tested: all five fixture paths; omitted mode defaults to Strict; missing ID returns REFER_TO_HUMAN with CP-8/PS-7; explicit enabled Demo records ID-only assumption in result and audit, verified=false, no fabricated document; other evidence requirements remain enforced; demo result cannot be relabeled fully verified; APP-004 retains 18,000 and refers; invalid JSON, invented quotes and missing evidence refer; fairness covers prompts/results/canonical memo; fake-provider pipeline requires no keys.

### P07 — Enforce login, authority and human issuance

Branch: feature/approval-access. Day 2. Depends P06.

- What: login/two roles plus authority tiers, server guards, four-eyes, customer alternative response, locked approval/rejection/issuance transitions, written reasons, referral queue, complaints/decision-reason endpoint, retention metadata.
- Why: a recommendation is not an issued offer; authority and identity are financial process invariants.
- How tested: Loan Officer denied; Credit Officer 300,000 denied; Senior allowed; exact250,000 allowed for different preparer; self-approval/stale/concurrent/double issue rejected; rejected/referral cases cannot bypass review; clause-specific rejection and 30-day complaint-window boundaries.

### P08 — Deliver minimal React workflows and OpenAPI

Branch: feature/web-interface. Day 2. Depends P05–P07.

- What: login, ingest/status, cited Q&A, pack select/upload, assessment breakdown, review queue/actions; complete OpenAPI; seed accounts and reproducible compose run.
- Why: satisfy FR-7 UI choice with the user's React stack and make all core actions demonstrable.
- How tested: browser path ingest→ask/refuse→assess→approve/reject; API independently rejects unauthorized actions; accessible keyboard/error/loading states; no model HTML; all five packs selectable; basic viewport smoke.

### P09 — Freeze core evaluation and release evidence

Branch: feature/core-evaluation. Day 2. Depends P08.

- What: fixed15 cases plus supplemental regressions, report script, hit@5/refusal/calculation metrics, tests and real-provider baseline, draft README/DESIGN/EVALUATION, demo rehearsal.
- Why: core must be proven before any stretch; frozen baseline makes future comparisons honest.
- How tested: full offline CI; real baseline stored with corpus/model/config hashes; all core acceptance gates; failures explained; fresh Compose start and seed; review corrected acceptance numbers.

### P10 — Add genuine BM25 and RRF hybrid retrieval

Branch: feature/hybrid-search. Day 3. Depends P09 core gate.

- What: PostgreSQL lexical postings/statistics and GIN candidate match, actual BM25 scoring, top20-per-branch RRF top5, toggled vector baseline and comparison report.
- Why: user requires hybrid, while baseline is needed to prove its effect.
- How tested: hand-calculated BM25 fixture; RRF ranking/ties/missing branch/dedup; edition/product filtering in both branches; same real15-case evaluation before/after; regressions reported, no assumed improvement.

### P11 — Add bounded policy query rewriting

Branch: feature/query-rewriting. Day 3. Depends P10.

- What: typed rewrite with intent/date/product preservation, original-query retrieval retained, configurable budget, comparison to hybrid without rewrite.
- Why: fulfill reranking-or-rewriting stretch with one measurable, bounded approach.
- How tested: mutation of date/product rejected; malicious query cannot alter tools; empty/invalid rewrite falls back; recorded before/after hit rate/refusal/latency/token counts.

### P12 — Add local model fallback

Branch: feature/local-model-fallback. Day 3. Depends P09.

- What: Ollama adapter, configurable local model, transient retry/fallback policy, model/usage attribution, schema parity; embedding availability strategy without mixed vector spaces.
- Why: continue generation when API fails/free quota is exhausted on user's16GB RAM/4GB graphics machine.
- How tested: inject429/timeouts; actual local schema extraction/memo smoke; invalid local output refers; provider switch leaves domain unchanged; unavailable embeddings refuse rather than query incompatible index; record real latency/memory observations.

### P13 — Add three typed tool-calling agents

Branch: feature/agent-orchestration. Day 3. Depends P10/P12.

- What: evidence, policy research and memo agents; allowlisted typed tools, deterministic safety gates, baseline workflow retained for parity and failure isolation.
- Why: fulfill agentic stretch while preserving core numeric/privacy/human-approval invariants.
- How tested: all five cases match baseline business outcomes; injection cannot invoke approval or raw-evidence access; schema/budget limits stop loops; arithmetic tool results unchanged; actual tool calls recorded.

### P14 — Stream validated answers and run progress

Branch: feature/sse-progress. Day 3. Depends P13.

- What: authenticated SSE, step progress, safe answer segments, reconnect/event sequence and terminal states in React.
- Why: fulfill streaming stretch and make long assessments understandable.
- How tested: unauthorized stream denied; reconnect no duplicate effects; disconnect does not auto-approve/corrupt run; provider errors emit terminal status; no unvalidated text/PII streamed.

### P15 — Extend synthetic corpus and add auto loans

Branch: feature/auto-loan-product. Day 4. Depends P09, integrates P10–P14.

- What: clearly marked new synthetic product/policy/pricing/documents and test packs; down-payment field/rules and isolated product retrieval; supplementary evaluation cases.
- Why: covers both corpus-extension and second-product stretches without altering originals.
- How tested: pass/insufficient-down-payment/missing vehicle price; calculated finance amount and pricing provenance; PL-100 unchanged; cross-product leakage blocked; new original test cases and source hashes.

### P16 — Generate issued offer PDFs and repayment schedules

Branch: feature/offer-document. Day 4. Depends P07/P15.

- What: code-calculated schedule, admin-fee/net-disbursement totals, approved/issued offer PDF, clause-cited conditions and authenticated download.
- Why: fulfill formatted-letter stretch with an artifact tied to a real human approval record.
- How tested: pending/rejected access denied; schedule principal sum and zero final balance; final rounding residual handled; PDF visually reviewed and values reconciled; authority/preparer/approval ids match stored snapshot.

### P17 — Track tokens and costs per user

Branch: feature/usage-accounting. Day 4. Depends P12–P14.

- What: aggregate real usage by user/run/model/step; price snapshot, actual free-tier cost vs estimated list cost, retries/fallback attribution; minimal UI.
- Why: fulfill usage stretch and make agent/rewriting overhead measurable.
- How tested: fake known token accounting across retries; idempotency prevents duplicate totals; absent usage displayed unknown; no cross-user disclosure; real-provider response reconciled.

### P18 — Complete reproducibility and submission package

Branch: docs/release-evidence. Day 4. Depends P10–P17.

- What: final README,2–4 page DESIGN, EVALUATION results and limitations, accurate AI-USAGE-LOG, source/extension attribution, demo script and3–5 minute video, dependency/secret review, final CI evidence.
- Why: submission must be runnable/explainable, with honest results and every requested feature demonstrated.
- How tested: fresh clone on clean DB; documented one-command start/seed; all CI green; real end-to-end core+stretches; repo public check and video private-window test; git audit>=15 meaningful commits over4 dates; no claimed feature without evidence.

## Promotion PRs into main

| PR | What | Why | How tested (required evidence) |
|---|---|---|---|
| R1 dev→main, day1 | Foundations, parser/calculator/vector checkpoint P01–P05 | first reproducible engineering milestone | green current scope tests/build/migrations; no claim of completed core |
| R2 dev→main, day2 | Complete core P06–P09 | establish core acceptance before stretches | offline suite + real vector baseline + five fixture modes + approval demo |
| R3 dev→main, day3 | Retrieval/local/agent/SSE P10–P14 | validated stretch tranche | hybrid/rewrite comparison, agent parity, local fallback and stream tests |
| R4 dev→main, day4 | Products/letter/usage/docs P15–P18 | final release | full CI + real evaluation + clean-clone/video/secret/history checklist |

Do not create empty promotions merely to meet count. If actual grouping changes, preserve at least three substantive dev→main PRs and update this file.

## Description template for each actual PR

What: concrete behavior implemented, linked requirement IDs, migration/API changes.

Why: the user/domain problem and reason for chosen approach.

How tested: exact executed commands; actual results; manual evidence; remaining failures or unavailable checks. Link evaluation report for retrieval changes.

Risk/limitations when material: breaking schema/data changes, provider limits, interpretation decisions and rollback/recovery. Do not use this plan as proof of testing.
