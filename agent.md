# Credit Copilot agent handoff

Read `status.md` first. Read specific source files only for the next task; do not reread the whole corpus by default.

## User authorization and scope

User authorized implementation of the reviewed plan. Stack: React/Vite, NestJS, Mastra, PostgreSQL FTS + pgvector, true BM25 + RRF, REST/OpenAPI, TypeORM, Jest. All nine stretches follow a passing core gate. Four-day window November17–20,2026 Cairo. Explain progress simply in Arabic. Do not delegate to subagents unless explicitly requested by user or applicable instructions.

Reported local hardware:16GB RAM and4GB graphics. Gemini is the primary provider for generation and embeddings. Opt-in Ollama fallback covers generation after transient Gemini failures. Never replace the user's local key or print it.

## Nonnegotiable decisions

- CP-2024 DBR50%, CP-2025 DBR45%; example capacity382,000/330,000. Same decimal formula; no example hardcodes. Explain Appendix E discrepancy in DESIGN/EVALUATION.
- Strict default. Missing ID copy =>REFER_TO_HUMAN with CP-8/PS-7. Explicit enabled synthetic Demo assumes ID presence only; audit/result record actual missing evidence and verified=false. No fabricated ID/probation assumptions.
- Strip protected attributes before ANY LLM/embedding/rules; mask IDs/phones. Untrusted customer packs never policy KB. APP-004 injected200,000 must never replace actual18,000; fraud referral required.
- Pure domain has no I/O/LLM/framework imports. Code calculates every number; source CSV selects rate. Human authority and four-eyes required before issuance.
- Two login roles with separate authority tiers: Loan0, Credit250k, Senior500k, Head1m. Low bureau score refers; does not auto-decline.

## Working conventions

Workspace G:/Credit Copilot, PowerShell, Node24, pnpm11.25.0. Main/dev/feature branches already exist. Test before feature merge into dev. Keep main promotions through >=3 actual PRs when GitHub authentication exists. Never fake four days of commits or results. No automatic deployment. GitHub repo https://github.com/MohamedHamdy2003/Credit-Copilot; Gemini approved. The user configures the ignored `.env` file. Keep API keys out of logs.

Commands: pnpm test; pnpm typecheck; pnpm lint; pnpm format:check; pnpm build; pnpm test:integration. Docker DB port54329. Dedicated integration DB name must end _test; tests truncate only that database. DB migrations explicit via pnpm db:migrate; synchronize=false. Unit tests require no keys. Fake embeddings are lexical test vectors, never claim semantic/live evaluation.

pnpm dev starts the local DB, runs migrations, and starts the API and web app. On a fresh setup, pnpm dev --seed also indexes the trusted corpus and seeds the four named demo accounts before starting either server. Alternatively, after configuring .env, docker compose up --build starts PostgreSQL, the API and Vite workspace, and seeds the corpus and demo accounts. Compose keeps its DB data when the containers stop. Rerunning --seed resets those accounts' passwords and revokes their sessions. pnpm evaluate runs the live 15-case evaluation in a separate *_eval DB. Run pnpm evaluate:core:offline with integration and browser checks sequentially on *_test. Timestamped reports preserve failures. The committed JSON freezes the source-aware vector baseline. Usage totals distinguish published estimates from provider charges. Read status.md before spending quota on a repeat run.

## References on demand

README.md for review/run commands; docs/DESIGN.md for architecture/source decisions; docs/EVALUATION.md for cases and real results; docs/PR-PLAN.md for sequencing. Exact originals under data/corpus/policy and evidence; data/config contains source-backed policy/product config and trusted hash manifest.

## Resume discipline

Update status.md after each meaningful milestone: branch/commit, implemented behavior, exact checks, blockers, next files. Don't claim scaffold functionality complete. Don't silently change source requirements to make fixtures pass. Read installed frontend skills before substantial UI work; the brief requests minimal styling. No need to regenerate previous planning artifacts.
