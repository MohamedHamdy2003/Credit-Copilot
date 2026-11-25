# Credit Copilot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](tsconfig.json)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17%20%2B%20pgvector-336791.svg)](compose.yaml)

**Ask a question about a dated bank credit policy and get an answer with verified
source citations — or assess a personal or auto loan pack through a deterministic
rules engine where a human always keeps the final say.**

Credit Copilot is an agentic RAG and underwriting workspace built for Delta
Commercial Bank's synthetic personal-loan (`PL-100`) and auto-loan (`AL-200`)
products. It ingests SHA-256-verified policy documents, answers dated questions
with verbatim citations (refusing when the corpus cannot support an answer),
computes every installment, DBR, and capacity figure in exact 50-digit Decimal
code, strips protected attributes before any model call, blocks document prompt
injection locally, and enforces independent human approval before issuing a
simulated offer PDF. All cases are fictional.

```
┌─ Loan Officer ──────────┐        ┌─ Credit / Senior / Head Reviewer ──┐
│  "Min income CP-2025?"  │        │  approve / reject / PM-4 referral  │
│  upload pack & assess   │        │  issue offer PDF & PM-9 reasons    │
└────────────┬────────────┘        └────────────────┬───────────────────┘
             │  HTTP + Cookie/CSRF + SSE            │
             ▼                                      ▼
    ┌──────────────────────────────────────────────────────────────┐
    │  NestJS REST + OpenAPI · Hybrid Search (BM25 + pgvector)     │
    │  RRF (k=60) · Cosine gate (0.65) · Inline source viewer      │
    ├──────────────────────────────────────────────────────────────┤
    │  Mastra 8-stage workflow (or 3 typed Zod tool agents)        │
    │  Pure 50-digit Decimal engine · Code memo · HUMAN APPROVAL   │
    └──────────────────────────────────────────────────────────────┘
             │                                      │
             ▼                                      ▼
      Gemini API                            PostgreSQL 17 + pgvector
  (+ optional local Ollama                  knowledge.* (policies)
     generation fallback)                    cases.*    (private packs)
```

📐 **[Architecture & design](docs/DESIGN.md)** ·
📊 **[Evaluation report](docs/EVALUATION.md)** ·
🤖 **[AI usage log](docs/AI-USAGE-LOG.md)**

---

## Table of contents

- [Prerequisites](#prerequisites)
- [Quick start — Docker Compose (recommended)](#quick-start--docker-compose-recommended)
- [Local setup (Node.js + pnpm)](#local-setup-nodejs--pnpm)
- [5-Minute Demo Path](#5-minute-demo-path)
- [Free API key & optional local Ollama fallback](#free-api-key--optional-local-ollama-fallback)
- [Every environment variable](#every-environment-variable)
- [Demo accounts](#demo-accounts)
- [Data sent to the LLM provider & privacy guarantees](#data-sent-to-the-llm-provider--privacy-guarantees)
- [Running the tests](#running-the-tests)
- [Running the evaluation harness](#running-the-evaluation-harness)
- [Troubleshooting](#troubleshooting)
- [Where to look in the code](#where-to-look-in-the-code)
- [Further reading](#further-reading)
- [License](#license)

---

## Prerequisites

**For the recommended Docker path, you only need Docker and a free Gemini API key.**

| Tool | Needed for | Install |
| --- | --- | --- |
| **Docker** + Docker Compose v2 | Full workspace (`db` + `app`) and optional `ollama` container | [docs.docker.com/get-docker](https://docs.docker.com/get-docker/) |
| **Google AI Studio key** (`GEMINI_API_KEY`) | Live policy embeddings, Q&A, and verified extraction (tests & offline evaluation require **no** key) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Node.js 24** + **pnpm 11.25.0** | Host-based dev, unit/integration/E2E tests, and evaluation CLI | [nodejs.org](https://nodejs.org/) · `corepack enable` |

Verify Docker is ready:

```bash
docker --version && docker compose version
```

> **Hardware note (optional local Ollama fallback):** The standard Gemini +
> PostgreSQL stack runs comfortably on 4–8 GB RAM. If you enable the optional
> local generation fallback (`--profile local-llm` with
> `qwen3:4b-instruct-2507-q4_K_M`), expect **~5.5 GiB** container RAM on CPU
> (~29–55 s per local request; default timeout `120000 ms`) — 16 GB host RAM is
> recommended when running Ollama alongside the full stack.

---

## Quick start — Docker Compose (recommended)

No local Node.js or pnpm installation required. Everything runs in two containers
(`db` and `app`).

### 1. Clone and configure `.env` (1 min)

```bash
git clone https://github.com/MohamedHamdy2003/Credit-Copilot.git
cd Credit-Copilot
cp .env.example .env
```

On Windows PowerShell:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Edit `.env` and set:

1. `GEMINI_API_KEY=<your Google AI Studio key>`
2. `DEMO_PASSWORD=<a unique local password, 12–256 characters>`
3. Optional for the walkthrough: `ALLOW_DEMO_MODE=true` (keeps `ASSESSMENT_MODE=strict` as the default while allowing explicit synthetic Demo runs).

> ⚠️ **Never commit `.env` or expose `GEMINI_API_KEY` / `DEMO_PASSWORD` in
> recordings.** `.env` is gitignored and excluded via `.dockerignore`. Inside
> Compose, `app` connects to `db:5432` automatically regardless of `localhost`
> in `.env`.

### 2. Start the full stack (2–3 min on first build & seed)

```bash
docker compose up --build
```

Compose waits for PostgreSQL 17 (`pgvector`) to become healthy, runs explicit
TypeORM migrations, indexes the **11 reviewed policy sources** (7 ITI `PL-100`
documents + 4 authored `AL-200` extension documents), seeds the four demo
accounts, and starts the NestJS API (**`:3000`**) and Vite web UI (**`:5173`**).

On every subsequent container start, policy ingestion skips already-indexed
sources by SHA-256 hash and resets the four demo passwords/sessions to
`DEMO_PASSWORD`. Press `Ctrl+C` to stop, and run `docker compose down` to remove
containers while preserving the PostgreSQL data volume.

### 3. Open it

| What | URL |
| --- | --- |
| **Web UI** | http://localhost:5173 |
| Interactive OpenAPI docs | http://localhost:3000/api/docs |
| Health check | http://localhost:3000/api/v1/health |

```bash
curl -s http://localhost:3000/api/v1/health
```

---

## Local setup (Node.js + pnpm)

Prefer running the API and Vite on your host with PostgreSQL in Docker?

```bash
pnpm install --frozen-lockfile
cp .env.example .env          # set GEMINI_API_KEY and DEMO_PASSWORD
pnpm dev --seed
```

On a fresh database, `pnpm dev --seed` starts the Compose `db` container, runs
migrations, ingests all 11 reviewed policy sources, seeds the four demo
accounts, and launches both the API (`127.0.0.1:3000`) and Vite UI
(`http://localhost:5173`). Use `pnpm dev` on later starts, `pnpm seed` to
re-run idempotent ingestion only, or `pnpm seed:users` to reset demo accounts.

---

## 5-Minute Demo Path

A numbered walkthrough covering every core underwriting, RAG, security, and
human-authority capability. Ensure `ALLOW_DEMO_MODE=true` is set in `.env`
(keeping `ASSESSMENT_MODE=strict` as default) and open http://localhost:5173.

**① Health check & idempotent ingestion** — verify the stack and corpus.

```bash
curl -s http://localhost:3000/api/v1/health
```

Sign in as `head-credit` (see [Demo accounts](#demo-accounts)) and open
**Policy library**. Confirm the reviewed policy sources and active chunk counts
are listed. To watch the **live 4-stage ingestion pipeline**
(`1. Extract → 2. Chunk → 3. Embed → 4. Index`) in action:

- **Delete & re-ingest a reviewed policy**: click **Delete** → **Confirm delete**
  on `credit-policy-2025.pdf`, then upload `data/corpus/policy/credit-policy-2025.pdf`
  under **Reviewed policy batch** to watch every stage run live; upload it a
  second time to observe **`skipped`** (SHA-256 idempotency).
- **Upload a new custom policy**: switch to **New custom policy**, enter Product,
  Edition, Type, and Effective date, and upload any `.pdf`, `.md`, or `.csv`
  policy file (customer packs `APP-*` / `AUTO-*` remain strictly blocked with
  `UntrustedPolicyDocument`).

**② Edition comparison & inline source citations** — sign in as `loan-officer`,
open **Delta Copilot**, select product **`PL-100`**, and ask:

> *What is the minimum net monthly income for PL-100 in CP-2024?*

Then ask the same question for **`CP-2025`** (or change **As-of date**) to
compare **EGP 8,000** vs **EGP 10,000** (explaining `CP-1` policy precedence
over `PS-2`). Leaving **As-of date** empty searches all currently active
policies automatically. Click any citation link to open the original PDF/Markdown
inline in a new tab via `/api/v1/knowledge/source?filename=...`. Try *"What is
the maximum tenor under Circular 2025/02?"* to see the 60-month product cap
(`CP-14`/`PS-3`) explained alongside the 72-month conditional circular (`C-1`).

**③ Anti-hallucination refusal (out-of-corpus)** — in the same **Delta Copilot**
chat, ask:

> *What are the terms for a crypto-backed loan?*

Self-contained questions are isolated from prior chat turns, and the cosine
similarity gate (`0.65`) triggers a clean **insufficient-evidence refusal** with
zero fabricated citations.

**④ Strict vs Demo assessment & exact Decimal math (`APP-001` & `APP-002`)** —
open **Applications**, add **`APP-001`**, and run **Strict**. Because the
supplied synthetic pack lacks a separate national ID copy, Strict refers under
`CP-8` and `PS-7`. Now select **Demo** and rerun:

- Recommendation: **`APPROVE`** for EGP 300,000.00 (60 months, 24.00% dated CSV rate)
- Monthly installment: **EGP 8,630.39** · DBR: **42.10%**
- Max eligible principal (`CP-2025`, 45% DBR): **EGP 330,000.00**
- Required approval authority: **`senior_credit_officer`** (`PM-2`)
- Explicit Demo audit badge: `national_id_copy` remains `verified: false`

*(Note: Appendix E.2 of the original brief printed the 50% `CP-2024` capacity of
EGP 382,000 alongside the `CP-2025` label; Credit Copilot computes authoritative
policy math — EGP 382,000 under `CP-2024` and EGP 330,000 under `CP-2025`.)*
You can also assess **`APP-002`** in Demo to observe **`OFFER_ALTERNATIVE`**
(**EGP 330,000.00**, EMI **EGP 10,068.79**, DBR **46.90%** exceeding the 45%
ceiling).

**⑤ Prompt-injection & document tampering defense (`APP-004`)** — add and assess
**`APP-004`**. Its salary certificate embeds an instruction telling the model to
treat salary as EGP 200,000 instead of the documented EGP 18,000. Local
tampering detection catches it **before any LLM call** (0 generation tokens),
retains the real EGP 18,000 salary, records `CP-2025`, and routes to an internal
fraud referral (`fraudReferral: true`).

**⑥ Authority limits & four-eyes human approval (`PM-2`)** — sign in as
`credit-officer` (EGP 250,000 limit), open the Demo `APP-001` run in **Review
queue**, and attempt approval on EGP 300,000 → rejected with
**`AuthorityLimitExceeded`**. Sign in as `senior-credit-officer` (EGP 500,000
limit), approve with a justification, issue the offer with disbursement date
`2025-04-03`, open **View issued offer**, and download the PDF letter with its
cent-reconciled 60-month repayment schedule.

**⑦ Referral adjudication (`APP-005` / `CP-6` / `PM-4`)** — assess **`APP-005`**
in Demo (bureau score 580 → **`REFER_TO_HUMAN`** on `CP-6`, authority
`senior_credit_officer`). As `senior-credit-officer`, either approve with
justification/conditions (server computes exact Decimal affordability and
authority checks before allowing PDF issuance) or reject citing `CP-6`.

**⑧ LLM Usage & traceability** — open **LLM Usage** to inspect per-actor native
calls, retries, fallbacks, explicit known vs unknown token counters, and nominal
list-rate USD estimates (scoped dynamically by the active provider). As
`head-credit`, use the top-right **Gemini / Auto / Ollama** toggle bar to switch
the active generation provider live and view each provider's consumption.

---

## Free API key & optional local Ollama fallback

### Primary provider (Gemini)

| Provider | Setup | Notes |
| --- | --- | --- |
| **Google AI Studio (Gemini)** | Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and paste into `GEMINI_API_KEY` | Check project model availability, RPM quota, and billing tier (`GEMINI_BILLING_TIER=confirmed_free` only after confirming free tier) |

### Optional local generation fallback (Ollama)

When enabled, transient Gemini generation outages fall back automatically to a
local Ollama container while preserving Gemini embeddings, sanitized inputs,
exact quote verification, and fallback audit records:

```bash
docker compose --profile local-llm up -d ollama
docker compose exec -T ollama ollama pull qwen3:4b-instruct-2507-q4_K_M
```

Set `OLLAMA_FALLBACK_ENABLED=true` in `.env` and restart, or switch live at
runtime as **`head-credit`** from the top-right toggle bar on **LLM Usage**
(**Gemini** / **Auto** / **Ollama**) via `GET /api/v1/llm/status` and
`POST /api/v1/llm/provider`. Verify fallback end-to-end with an injected primary
outage:

```bash
pnpm evaluate:fallback
```

> ⚠️ **Embedding model warning:** Changing `GENERATION_MODEL` or `OLLAMA_MODEL`
> is safe anytime. Changing `EMBEDDING_MODEL` or `EMBEDDING_DIMENSIONS` requires
> re-indexing the policy corpus (`pnpm seed`) because vectors from different
> embedding spaces are not comparable.

---

## Every environment variable

Configuration is validated at startup by
[`packages/contracts/src/config.ts`](packages/contracts/src/config.ts). Copy
[`.env.example`](.env.example) to `.env` and restart services after edits.

### Server & Web

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | NestJS API port. |
| `API_HOST` | `127.0.0.1` | API bind address (`0.0.0.0` inside Docker Compose while published host port stays loopback-only). |
| `WEB_ORIGIN` | `http://localhost:5173` | Exact browser origin allowed by CORS and cookie checks. Must match the URL you open. |
| `WEB_PORT` | `5173` | Host/container port for the Vite UI in Docker Compose; match the port in `WEB_ORIGIN`. |
| `WEB_HOST` | `127.0.0.1` | Vite bind address (`0.0.0.0` inside Docker Compose). |
| `API_PROXY_TARGET` | `http://localhost:3000` | Optional API upstream target when running Vite standalone (`pnpm dev` sets this from `PORT`). |
| `COMPOSE_MANAGED` | *(unset)* | Internal Compose flag (`true` in `compose.yaml`) telling `scripts/dev.ts` not to spawn nested Docker commands. |

### Database & Docker Compose

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://copilot:copilot_local@localhost:54329/credit_copilot` | Primary PostgreSQL DSN. Compose overrides host to `db:5432` internally. |
| `POSTGRES_PORT` | `54329` | Host loopback port mapped to PostgreSQL `5432` in `compose.yaml`. |
| `POSTGRES_PASSWORD` | `copilot_local` | Local PostgreSQL password for Compose `db`. Match `DATABASE_URL` if changed. |
| `COMPOSE_PROJECT_NAME` | *(directory name)* | Optional Compose namespace for isolated containers/volumes (pair with a distinct `POSTGRES_PORT`). |
| `TEST_DATABASE_URL` | *(optional)* | Dedicated test DB whose name **must** end in `_test` (e.g., `credit_copilot_test`). |
| `EVALUATION_DATABASE_URL` | *(derived `_eval`)* | Optional isolated live evaluation DB whose name **must** end in `_eval`. |

### LLM providers & local fallback

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `gemini` | Active primary provider (`gemini`). |
| `GEMINI_API_KEY` | *(empty)* | Google AI Studio key. Required for live seeding, Q&A, and extraction. **Secret.** |
| `GEMINI_BILLING_TIER` | `unknown` | Usage reporting tier (`unknown` or `confirmed_free`). Only set `confirmed_free` after verifying your AI Studio project tier. |
| `GENERATION_MODEL` | `gemini-3.5-flash-lite` | Primary Gemini generation model. |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | Gemini embedding model. **Re-run `pnpm seed` if changed.** |
| `EMBEDDING_DIMENSIONS` | `768` | Vector dimension count. **Re-run `pnpm seed` if changed.** |
| `SEED_EMBEDDING_INTERVAL_MS` | `750` | Minimum pacing (ms) between logical embedding calls during `pnpm seed` to avoid HTTP 429 bursts. |
| `EVALUATION_GENERATION_INTERVAL_MS` | `0` | Optional pacing (ms) between logical generation calls during live `pnpm evaluate` runs. |
| `OLLAMA_FALLBACK_ENABLED` | `false` | Enables local Ollama generation fallback after transient Gemini outages. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Loopback HTTP origin for Ollama. |
| `OLLAMA_MODEL` | `qwen3:4b-instruct-2507-q4_K_M` | Local Ollama model tag (pull before enabling). |
| `OLLAMA_TIMEOUT_MS` | `120000` | Timeout (ms) for a local Ollama generation request. |

### Retrieval & query rewriting

| Variable | Default | Purpose |
| --- | --- | --- |
| `RETRIEVAL_STRATEGY` | `hybrid` | `hybrid` (PostgreSQL BM25 + pgvector cosine via RRF `k=60`) or `vector` (cosine-only baseline). |
| `RETRIEVAL_MIN_SIMILARITY` | `0.65` | Minimum cosine similarity required to answer a policy question; lower matches refuse. |
| `QUERY_REWRITE_MAX_EXPANSIONS` | `2` | Maximum glossary lexical aliases (`0`–`4`; `0` disables rewriting). |

### Underwriting, auth & uploads

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASSESSMENT_MODE` | `strict` | Default assessment mode (`strict` or `demo`). Keep `strict` as default. |
| `ALLOW_DEMO_MODE` | `false` | Must be `true` to permit explicit opt-in synthetic Demo runs (ID-copy presence assumed only). |
| `ASSESSMENT_ORCHESTRATION` | `workflow` | `workflow` (8-stage Mastra workflow) or `agents` (3 bounded Mastra agents with typed Zod tools). |
| `UPLOAD_MAX_BYTES` | `10485760` | Maximum upload size in bytes (10 MiB). PDF parser also enforces a 100-page cap. |
| `DEMO_PASSWORD` | *(empty — required for seed)* | Local password (12–256 chars) applied to the four demo accounts on `pnpm seed:users` / Compose boot. **Secret.** |
| `SESSION_TTL_HOURS` | `8` | Cookie session lifetime in hours. |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS; keep `false` for local HTTP. |

---

## Demo accounts

Seeded by `pnpm seed:users` (and automatically on `docker compose up` /
`pnpm dev --seed`) using your local `DEMO_PASSWORD`. Use separate accounts for
preparing and approving an application (four-eyes rule).

| Username | Role | Approval Limit | Permissions |
| --- | --- | --- | --- |
| `loan-officer` | `loan_officer` | None | Ask policy questions, run affordability calculator, upload/assess applications |
| `credit-officer` | `credit_officer` (`credit`) | Up to EGP 250,000 | Approve/reject standard applications up to EGP 250,000 |
| `senior-credit-officer` | `credit_officer` (`senior`) | Up to EGP 500,000 | Approve/reject up to EGP 500,000 + adjudicate `PM-4` / `CP-6` referrals & issue offers |
| `head-credit` | `credit_officer` (`head`) | Up to EGP 1,000,000 | Full review authority up to EGP 1,000,000 + **Policy library** ingestion permission |

---

## Data sent to the LLM provider & privacy guarantees

| Operation | Sent to LLM provider | Never sent to LLM provider |
| --- | --- | --- |
| **Policy indexing** | Normalized, chunked **trusted policy** text (`data/corpus/policy/*`) | Customer PDFs, application forms, applicant records |
| **Policy Q&A** | Masked policy question + retrieved policy excerpts, source IDs, sections, pages, effective dates | Egyptian 14-digit national IDs, Egyptian mobile numbers (`01x`, `+20`, `0020`), customer files |
| **Application extraction** | Canonical pack reference (`APP-001`) + allowlisted salary/bureau fields (net income, obligations, employment start, bureau score) with section/page | Raw PDFs, applicant names, IDs, phone numbers, `gender`, `religion`, `marital_status`, `nationality` |
| **Typed agent planners** | Generic stage task, tool name, and canonical typed arguments (`applicationReference`, `policyEdition`, etc.) | Raw customer text, PII, or protected attributes |
| **Suspected tampering (`APP-004`)** | **Nothing (0 LLM calls)** | Blocked locally before any external request |

- **Database isolation**: policy sources live in `knowledge.*`; customer
  applications, runs, decisions, offers, and usage live in `cases.*`.
- **Usage & billing honesty**: `GET /api/v1/usage/me` reports observed token
  counters and nominal list-rate estimates separately from real provider
  charges. Unreported counters (e.g., Gemini embedding token counts) stay
  explicitly `unknown` rather than fabricated zeros.

---

## Running the tests

All automated tests run **without any API key** using deterministic provider
fixtures against a dedicated PostgreSQL database ending in `_test`. Run DB,
offline evaluation, and browser suites **sequentially** (never concurrently on
the same `_test` database).

```bash
# 1. Start PostgreSQL and create the isolated test database (once)
docker compose up -d --wait db
docker compose exec -T db psql -U copilot -d postgres -c "CREATE DATABASE credit_copilot_test"

# 2. Static checks & fast unit suite (no DB needed)
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm evaluate:offline

# 3. Database, integration, offline evals & Chromium E2E (sequential on *_test)
pnpm db:migrate
pnpm test:integration
pnpm evaluate:core:offline
pnpm evaluate --offline-agents
pnpm exec playwright install chromium
pnpm test:e2e

# 4. Production builds
pnpm build
```

| Suite | Verified Count | Needs | Notes |
| --- | --- | --- | --- |
| `pnpm test` (unit) | **158 tests** (24 suites) | Nothing | Pure domain math, rules, chunker, masking, agents, provider router, parser checks |
| `pnpm test:integration` | **46 tests** (3 suites) | Postgres (`*_test`) | Real PostgreSQL + NestJS HTTP, SSE, hybrid BM25/pgvector, PM-4/PM-9, custom ingestion, delete & LLM switcher |
| `pnpm test:e2e` (Playwright) | **11 journeys** | Postgres (`*_test`) + Chromium | Desktop & mobile UI flows on ports 4304 / 5174 |
| `pnpm evaluate:core:offline` | **15/15 cases** | Postgres (`*_test`) | Deterministic workflow regression (`79/79` security & audit) |
| `pnpm evaluate --offline-agents` | **15/15 cases** | Postgres (`*_test`) | Deterministic typed-agents regression (`93/93` security & audit) |

---

## Running the evaluation harness

The 15-case golden suite in [`data/evaluation/cases.json`](data/evaluation/cases.json)
(`core-15-v3`) covers policy edition changes, product/circular conflicts,
out-of-corpus refusals, exact Decimal calculations, prompt-injection defense,
human authority enforcement, and 4-field protected-attribute fairness.

```bash
# Deterministic offline regression (no API key; uses *_test DB)
pnpm evaluate:core:offline
pnpm evaluate --offline-agents

# Live Gemini runs (requires GEMINI_API_KEY + quota; uses isolated *_eval DB)
pnpm evaluate --vector
pnpm evaluate --hybrid
pnpm evaluate --rewrite
pnpm evaluate --agents
```

Every run writes an immutable report to `artifacts/evaluation/` (including
failures). Offline runs report `liveQualityGate: "not_measured"` and never claim
live semantic quality. Read **[docs/EVALUATION.md](docs/EVALUATION.md)** for
exact metric definitions, historical live Gemini `core-15-v1`/`core-15-v2`
reports (including retained 11/15 and 14/15 failure reports), and `core-15-v3`
results.

To exercise the `AL-200` auto-loan extension from the CLI:

```bash
pnpm assess AUTO-001 --demo
```

---

## Troubleshooting

- **HTTP 429 during `pnpm seed` or Compose boot**: Gemini per-minute embedding
  quota was reached. Wait briefly and re-run — completed policy sources are
  skipped by SHA-256 hash. Increase `SEED_EMBEDDING_INTERVAL_MS` (e.g. `1500`)
  for stricter quotas.
- **`DemoModeDisabled` when selecting Demo**: set `ALLOW_DEMO_MODE=true` in
  `.env` and restart the API/container.
- **Session cookie not sticking / 401 after login**: open the exact origin
  configured in `WEB_ORIGIN` (default `http://localhost:5173`, not `127.0.0.1`
  unless `WEB_ORIGIN` matches).
- **Integration or E2E fails with missing database**: create
  `credit_copilot_test` once (`docker compose exec -T db psql -U copilot -d postgres -c "CREATE DATABASE credit_copilot_test"`). Never point tests at the
  main `credit_copilot` DB.
- **Port conflict on `3000`, `5173`, or `54329`**: override `PORT`, `WEB_PORT`
  (plus `WEB_ORIGIN`), or `POSTGRES_PORT` (plus `DATABASE_URL`) in `.env`.
- **Ollama request times out on first call**: CPU model cold-load takes ~30–60 s
  on `qwen3:4b-instruct-2507-q4_K_M`. Verify the model is pulled (`docker
  compose exec -T ollama ollama list`) and keep `OLLAMA_TIMEOUT_MS=120000` or
  higher.
- **Stale container behavior after code edits**: rebuild with
  `docker compose up -d --build`.

---

## Where to look in the code

| Concern | Path |
| --- | --- |
| Domain rules, authority & 50-digit Decimal engine | [`packages/domain/src/rules.ts`](packages/domain/src/rules.ts), [`calculations.ts`](packages/domain/src/calculations.ts), [`access.ts`](packages/domain/src/access.ts), [`review-policy.ts`](packages/domain/src/review-policy.ts) |
| Repayment schedule & offer PDF letter | [`packages/domain/src/repayment-schedule.ts`](packages/domain/src/repayment-schedule.ts), [`packages/infrastructure/src/pdf/offer-letter.ts`](packages/infrastructure/src/pdf/offer-letter.ts) |
| PDF/CSV/MD parsers & `clause-cl100k-v3` chunker | [`packages/infrastructure/src/parsers/registry.ts`](packages/infrastructure/src/parsers/registry.ts), [`chunker.ts`](packages/infrastructure/src/parsers/chunker.ts), [`pricing.ts`](packages/infrastructure/src/parsers/pricing.ts) |
| Idempotent ingestion & hybrid BM25 + pgvector retrieval | [`packages/infrastructure/src/knowledge/ingestion.ts`](packages/infrastructure/src/knowledge/ingestion.ts), [`retrieval.ts`](packages/infrastructure/src/knowledge/retrieval.ts), [`hybrid-search.ts`](packages/infrastructure/src/knowledge/hybrid-search.ts) |
| Policy Q&A, follow-up isolation, PII masking & citations | [`packages/application/src/questions.ts`](packages/application/src/questions.ts), [`operations.ts`](packages/application/src/operations.ts), [`query-rewrite.ts`](packages/application/src/query-rewrite.ts) |
| 8-stage assessment workflow, extraction & code memo | [`packages/application/src/document-assessment.ts`](packages/application/src/document-assessment.ts), [`extraction.ts`](packages/application/src/extraction.ts), [`evidence-facts.ts`](packages/application/src/evidence-facts.ts), [`credit-memo.ts`](packages/application/src/credit-memo.ts) |
| Typed Mastra agents (Zod input/output contracts) | [`packages/application/src/assessment-agents.ts`](packages/application/src/assessment-agents.ts), [`packages/infrastructure/src/workflows/assessment-agents.ts`](packages/infrastructure/src/workflows/assessment-agents.ts), [`prompts/assessment-agents.json`](prompts/assessment-agents.json) |
| Human approval, PM-4 referrals, offers & PM-9 reasons | [`packages/infrastructure/src/db/decision-store.ts`](packages/infrastructure/src/db/decision-store.ts), [`offer-document.ts`](packages/infrastructure/src/db/offer-document.ts), [`case-review-store.ts`](packages/infrastructure/src/db/case-review-store.ts) |
| Gemini, Ollama fallback & usage metering | [`packages/infrastructure/src/llm/gemini.ts`](packages/infrastructure/src/llm/gemini.ts), [`ollama.ts`](packages/infrastructure/src/llm/ollama.ts), [`provider.ts`](packages/infrastructure/src/llm/provider.ts), [`usage-tracker.ts`](packages/infrastructure/src/llm/usage-tracker.ts) |
| REST API, OpenAPI, session/CSRF guards & SSE streams | [`apps/api/src/app.ts`](apps/api/src/app.ts), [`apps/api/src/sse.ts`](apps/api/src/sse.ts) |
| React workspace (Policy library, Chat, Applications, Reviews, LLM Usage) | [`apps/web/src/App.tsx`](apps/web/src/App.tsx), [`Questions.tsx`](apps/web/src/Questions.tsx), [`Assessment.tsx`](apps/web/src/Assessment.tsx), [`Reviews.tsx`](apps/web/src/Reviews.tsx), [`Usage.tsx`](apps/web/src/Usage.tsx) |
| Evaluation harness & golden cases | [`scripts/evaluate.ts`](scripts/evaluate.ts), [`scripts/evaluation/runner.ts`](scripts/evaluation/runner.ts), [`data/evaluation/cases.json`](data/evaluation/cases.json) |

---

## Further reading

| Document | What it covers |
| --- | --- |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Architecture, corpus isolation, `clause-cl100k-v3` chunking, Decimal rules, typed agents, privacy & provider swap |
| [`docs/EVALUATION.md`](docs/EVALUATION.md) | 15-case golden suite (`core-15-v1` / `v2` / `v3`), metric definitions, retained live baselines & failure analyses |
| [`docs/AI-USAGE-LOG.md`](docs/AI-USAGE-LOG.md) | Chronological AI collaboration log, real AI mistakes caught during audit, and candidate ownership notes |

---

## License

[MIT](LICENSE) — Built from scratch for the ITI "Credit Copilot Lite" technical
assessment (no external starter template). The seven original policy sources and
five personal-loan packs retain their original ITI synthetic-corpus attribution;
the four `AL-200` policy files and three `AUTO-*` packs are fictional synthetic
extensions authored for this repository.
