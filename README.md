# Credit Copilot

Credit Copilot is a synthetic underwriting workspace for Delta Commercial Bank’s personal and auto loans. It indexes dated policies, answers questions with verified citations, computes eligibility and affordability in code, and records a human decision before issuing a simulated offer. All cases are fictional.

## Quick start

Run commands from the repository root. The Docker Compose option needs Docker with Compose v2. The local Node option needs Node.js 24, pnpm 11.25.0, Docker with Compose v2, and Git.

### Run the full workspace with Docker Compose

Copy `.env.example` to `.env`, then set `GEMINI_API_KEY` and a unique `DEMO_PASSWORD` of 12–256 characters. The Compose app container uses the database service address internally, regardless of the `localhost` database address in the local template.

```sh
docker compose up --build
```

Compose waits for PostgreSQL, runs migrations, indexes the eleven reviewed policy sources, seeds the four demo accounts, and starts the API and web interface. Open `http://localhost:5173`. The API documentation is at `http://localhost:3000/api/docs`. On each app-container start, the seed step reuses fully indexed sources and resets the demo accounts to `DEMO_PASSWORD`, revoking their existing sessions. Press Ctrl+C to stop, then run `docker compose down` to remove the containers while keeping database data.

The Compose app container runs the API and Vite development server together for local review. Keep `PORT` matched to the API address and set `WEB_PORT` to the same port used in `WEB_ORIGIN` if you change the web port.

The existing host-based setup remains available with Node.js:

```powershell
pnpm install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

On macOS or Linux use `test -f .env || cp .env.example .env`. In your local `.env`, set `GEMINI_API_KEY` and a unique 12–256 character `DEMO_PASSWORD`. Create a key in a Google AI Studio project and check its models, quota and billing tier before running the live demo. Keep the key and password out of recordings and Git. [Google AI Studio keys](https://aistudio.google.com/apikey) · [Gemini API key setup](https://aistudio.google.com/docs/api-key)

```sh
pnpm dev --seed
```

On a fresh local database, this command starts PostgreSQL, runs the migration CLI, indexes the reviewed policy sources, seeds the demo accounts, and starts the API and web app. Open `http://localhost:5173` for the app and `http://127.0.0.1:3000/api/docs` for OpenAPI. Ctrl+C stops the API and web processes and keeps PostgreSQL data. Use `pnpm dev` for later starts. Run `pnpm seed` separately to index the policy corpus, or `pnpm seed:users` to reset demo passwords and revoke their old sessions. If the provider returns HTTP 429 during seeding, wait for the project quota to recover, then rerun. Completed sources are skipped. Increase `SEED_EMBEDDING_INTERVAL_MS` for a lower per-minute quota. On a reused database, `pnpm dev --seed` also resets those four accounts.

All four demo accounts use the password you set locally. Use separate accounts for assessment preparation and review.

| Account                 | Role and authority                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `loan-officer`          | Loan Officer. Prepares cases and asks policy questions.                             |
| `credit-officer`        | Credit Officer. Up to EGP 250,000.                                                  |
| `senior-credit-officer` | Senior Credit Officer. Up to EGP 500,000 and referral review.                       |
| `head-credit`           | Head Credit Officer. Up to EGP 1,000,000 with reviewed policy ingestion permission. |

## 5-Minute Demo Path

For a filmed walkthrough, use a fresh synthetic database and set `ALLOW_DEMO_MODE=true` before starting. Keep `ASSESSMENT_MODE=strict` and select Demo explicitly for the approval example. Capture the first successful ingestion before recording Q&A. A seeded workspace can demonstrate idempotency by uploading the same source again.

1. **0:00–0:35 · Ingest.** Show `pnpm seed` indexing trusted sources on a fresh database, or use **Policy library → Ingest documents** as `head-credit`. Show a successful source, then repeat it and observe **skipped**. Use files from `data/corpus/policy/`.
2. **0:35–1:15 · Cite, refuse and compare editions.** Sign in as `loan-officer`. In the **Policy questions** chat, select PL-100 and ask “What is the minimum net monthly income for PL-100?” for CP-2024, then CP-2025. Show the answer and source sections, open a citation in a new tab, and explain the change from EGP 8,000 to EGP 10,000. Ask “What are the terms for a crypto-backed loan?” and show the insufficient-evidence refusal.
3. **1:15–2:25 · Assess and show the numbers.** In **Applications**, add `APP-001` and run Strict. Explain the missing national ID copy referral under CP-8 and PS-7. Select Demo and rerun. Show the explicit ID-copy assumption, the dated 24% CSV rate, EGP 8,630.39 instalment, 42.10% DBR and EGP 330,000 maximum under CP-2025. Open **Rules & sources** or **Workflow** to show provenance and stage history.
4. **2:25–3:00 · Show the failed injection.** Add and assess `APP-004`. Open the case result and show the internal suspected-tampering referral and skipped extraction and rule stages. The supplied salary certificate contains the malicious EGP 200,000 instruction alongside the actual EGP 18,000 field.
5. **3:00–4:15 · Show independent approval.** Sign in as `credit-officer` and open the Demo APP-001 run in **Review queue**. Attempt approval with a justification and show `AuthorityLimitExceeded` on EGP 300,000. Then sign in as `senior-credit-officer`, approve with a justification, and issue with the synthetic disbursement date `2025-04-03`. Open **View issued offer** and download the PDF.
6. **4:15–5:00 · Close with traceability.** Open a policy citation in a new tab, show the source clause and page, then show **Usage** with its known and missing counters. Summarize the path from dated evidence to calculation and independent human approval. Keep the walkthrough on the five original PL-100 application packs.

## Tests and evaluation

These checks run without a Gemini key. Use a dedicated PostgreSQL database whose name ends in `_test`. Create the default database `credit_copilot_test` once if it is absent.

```sh
docker compose up -d --wait db
docker compose exec -T db psql -U copilot -d postgres -c "CREATE DATABASE credit_copilot_test"
pnpm test
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test:integration
pnpm evaluate:core:offline
pnpm evaluate --offline-agents
pnpm exec playwright install chromium
pnpm test:e2e
```

Run the database, offline evaluation and browser suites sequentially. Playwright resets case and account fixtures in the test database and launches its own services on ports 4304 and 5174. Unit, integration and browser tests use provider fixtures.

Run `pnpm evaluate --vector`, `pnpm evaluate --hybrid`, `pnpm evaluate --rewrite` or `pnpm evaluate --agents` for live Gemini runs of the current 15-case suite. Live runs use a separate database ending in `_eval` and consume provider quota. Each run writes a report under `artifacts/evaluation/`, including failed results. Use `pnpm assess AUTO-001 --demo` to assess the synthetic auto case, or choose **Auto loan** in **Policy questions** to search the product’s sources. [Evaluation results and reproducibility](docs/EVALUATION.md)

## Configuration

Use [.env.example](.env.example) as the local template. Restart services after changing runtime settings. Set test or Compose overrides in the shell when launching their commands.

| Variable                                          | Default and purpose                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                    | Local PostgreSQL on port 54329, database `credit_copilot`. Match the Compose credentials and port.                                 |
| `POSTGRES_PORT` / `POSTGRES_PASSWORD`             | Compose host port 54329 and local-only default password `copilot_local`.                                                           |
| `COMPOSE_PROJECT_NAME`                            | Optional Docker Compose namespace for an isolated container and volume. Use a distinct `POSTGRES_PORT` for simultaneous instances. |
| `PORT` / `WEB_ORIGIN`                             | API port 3000 and web origin `http://localhost:5173`. Open the exact origin configured.                                            |
| `GEMINI_API_KEY` / `LLM_PROVIDER`                 | Local AI Studio key and primary provider `gemini`.                                                                                 |
| `GENERATION_MODEL`                                | `gemini-3.5-flash-lite`. Choose a model available to your project.                                                                 |
| `GEMINI_BILLING_TIER`                             | `unknown`. Use `confirmed_free` only after verifying your key’s project is on Gemini Free Tier.                                    |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS`        | `gemini-embedding-001` / 768. Reindex trusted sources after changing either.                                                       |
| `SEED_EMBEDDING_INTERVAL_MS`                      | 750 ms. Minimum spacing between logical embedding calls when seeding policies with the CLI.                                        |
| `RETRIEVAL_STRATEGY` / `RETRIEVAL_MIN_SIMILARITY` | `hybrid` / 0.65. Choose `vector` for cosine-only retrieval.                                                                        |
| `QUERY_REWRITE_MAX_EXPANSIONS`                    | 2 additional glossary phrases. Accepts 0–4, where 0 disables rewriting.                                                            |
| `ASSESSMENT_MODE` / `ALLOW_DEMO_MODE`             | `strict` / `false`. Set the second to `true` to allow explicit synthetic Demo assessment.                                          |
| `ASSESSMENT_ORCHESTRATION`                        | `workflow`. Choose `agents` for three bounded Mastra tool planners.                                                                |
| `OLLAMA_FALLBACK_ENABLED`                         | `false`. Allows generation fallback after transient Gemini failures when enabled.                                                  |
| `OLLAMA_BASE_URL`                                 | `http://127.0.0.1:11434`. Accepts a loopback HTTP origin.                                                                          |
| `OLLAMA_MODEL`                                    | `qwen3:4b-instruct-2507-q4_K_M`. Download it before use.                                                                           |
| `OLLAMA_TIMEOUT_MS`                               | 120000 ms. Timeout for the local generation attempt.                                                                               |
| `UPLOAD_MAX_BYTES`                                | 10485760. Maximum per upload. The PDF parser also limits documents to 100 text pages.                                              |
| `DEMO_PASSWORD`                                   | Required for account seeding. Choose a unique local password of 12–256 characters.                                                 |
| `SESSION_TTL_HOURS` / `COOKIE_SECURE`             | 8 / `false` for local HTTP. Enable secure cookies with HTTPS.                                                                      |
| `EVALUATION_DATABASE_URL`                         | Optional isolated live database. By default derive an `_eval` database from `DATABASE_URL`.                                        |
| `EVALUATION_GENERATION_INTERVAL_MS`               | 0. Optional pacing between logical generation calls in evaluation.                                                                 |
| `TEST_DATABASE_URL`                               | Optional dedicated database ending in `_test`.                                                                                     |
| `API_PROXY_TARGET`                                | Optional API origin when running Vite separately. `pnpm dev` sets the proxy using `PORT`.                                          |

For local fallback, start `docker compose --profile local-llm up -d ollama`, download the model with `docker compose exec -T ollama ollama pull qwen3:4b-instruct-2507-q4_K_M`, then enable `OLLAMA_FALLBACK_ENABLED`. Gemini continues to supply embeddings. Use `pnpm evaluate:fallback` to test local generation with an injected primary outage. [Ollama setup and behavior](https://docs.ollama.com/faq)

## Data handling and API

- Indexing sends the normalized, chunked **trusted policy** documents to the Gemini embedding model. Query embeddings use the masked policy question. Answer generation receives that question and the retrieved policy excerpts, source IDs, sections, pages and effective dates.
- Assessment generation receives the canonical pack reference and allowlisted salary or bureau fields with their page and section. Those fields are net income, existing obligations, employment start and bureau score. Code filters out raw documents, applicant names, IDs, phone numbers and protected attributes. Agent planners receive a generic task and one tool name. Egyptian IDs and mobile numbers are masked in policy questions. Keep customer data out of that input.
- Applications recognize reviewed synthetic packs by content hash and store their PDFs in the private case store. Login uses a session cookie, with CSRF checks on changes. Only the preparer or an authorized reviewer can read an issued PDF at `GET /api/v1/offers/:id/document`. The signed-in user’s usage aggregate is available at `GET /api/v1/usage/me` with an optional `runId` filter.
- Usage separates published-rate estimates from provider charges. Missing counters and unknown Gemini billing tiers are explicit. Confirmed free-tier calls have zero provider fees. Local Ollama’s zero fee covers the provider charge and excludes machine costs. [Gemini pricing](https://aistudio.google.com/docs/pricing)

The original ITI exercise supplied seven policy documents and five personal-loan packs. The repository adds four fictional AL-200 policy sources and three auto cases as the synthetic extension. The policy and fixture manifests record their provenance and hashes. This workspace was assembled for the exercise. [Design](docs/DESIGN.md) · [AI usage log](docs/AI-USAGE-LOG.md) · [Current verification status](status.md)
