# Credit Copilot implementation status

Updated2026-11-17 Cairo. Implementation active; core incomplete; no stretches started. Read this file and agent.md first; AGENTS.md points here automatically.

## Latest assessment increment

Persistence increment: Application now defines AssessmentRepository/AssessmentRecord and assessAndRecord; Infrastructure implements PostgresAssessmentRepository. Transaction appends immutable run, step/removal/demo audit events, successful extraction usage and Fraud Unit referral event. Existing run IDs cannot overwrite results; actor must match stored application preparer. Real PostgreSQL integration covers referral/demo audit, duplicate rollback and unauthorized actor rollback. Missing ID entry defaults to missing; policy selection failures now become recordable referrals. Mastra supports optional second persistence stage; extraction prompt loader is Infrastructure-only. Latest checks:50 unit tests and4 real PostgreSQL integration tests passed; typecheck/lint/format and API build passed. Still NOT eight distinct workflow steps, no public assessment endpoint, no actual fraud queue UI, and no approval/auth yet. Failed model calls do not yet persist usage returned before validation failure; provider attempt-level tracking remains required.

New increment: local application-form allowlist parser (all5 PDFs covered), application assessment service connecting mode/evidence checks, policy selection, verified extraction, CSV pricing, pure rules and canonical memo. Infrastructure adapter executes this service using a real typed Mastra workflow; offline Mastra execution tested.46 unit tests pass (6 new cases), with typecheck/lint passing. Workflow currently wraps the service in ONE Mastra step, not eight separate persisted steps. No API/public endpoint added yet. Inputs `verifiedFacts` and evidence are trusted internal service inputs; never bind them directly to client bodies. A server evidence-verification service must derive/check them before public use. Current internal tests supply documented complete facts for APP-001 and a modified birth date to test over-age behavior.

Next concrete task: build evidence-fact derivation and persistence ports/repository, split ordered workflow stages with typed outputs and save pending assessment/audit/fraud referrals. Handle policy-resolution failures as persisted referrals; load prompt via infrastructure. Empty required evidence lists and spoofed client verification flags must be rejected at the server boundary. Current service is an incremental internal implementation, not the complete P06 feature; keep feature/application-assessment open.

packages/application/src/extraction.ts now provides local allowlisted evidence sanitization and schema/provenance-verified model extraction. Only income/obligations/employment-start/score lines go to provider; exact labeled source lines and decimal values must match. Protected fields, names and identifiers never enter these extraction requests. APP-004 tampering raises SuspectedTampering before a provider call; pipeline still needs to translate this into a persisted referral and Fraud Unit event. Prompt lives in prompts/extraction.txt. Five new offline tests cover valid/invalid JSON, invented value, injection, and fairness of model input. Latest checks:40 unit tests passed;3 integration tests passed against real PostgreSQL; typecheck/lint/format checks and production build passed. The final contradiction guard was followed by typecheck,40 unit tests and lint; storage integration remains unchanged. This is one application service, not the completed eight-step Mastra pipeline.

## Verified baseline before current assessment work

- Foundation: pinned pnpm workspace, TS5.9.3, Nest12, React19/Vite8, Jest30/ts-jest29, ESLint, Prettier; lockfile; LICENSE; env example; PR template; GitHub Actions lint/types/tests/build plus real PostgreSQL migrations/integration.
- Docker PostgreSQL17/pgvector0.8.2 healthy on54329. Explicit TypeORM initial migration applied to credit_copilot and credit_copilot_test. knowledge/cases schemas separate.
- Parser registry PDF/CSV/MD, file limits/type validation, source provenance, normalization, clause chunks, typed pricing; all12 corpus files copied byte-for-byte. Trusted seven-file SHA256 manifest.
- Decimal arithmetic, calendar dates, policy/rate selection, eligibility before affordability, explicit evidence modes. Unit tests35 passed; integration tests3 passed on real PostgreSQL (idempotency, vector date filters/evidence isolation, rollback on provider failure, concurrent duplicate imports).
- Atomic trusted ingestion, exact pgvector retrieval, Gemini generation/embed adapter with schema/error handling. No real Gemini call yet.
- API only health/OpenAPI scaffold; React only connectivity shell. Not an underwriting UI.

## Git and environment

main initial planning commit1b05ea7; dev contains tested feature merges. Commits37cbc4c foundation, ff0248f calculations/modes, afc2719 parsers,262f231 storage. Current branch feature/application-assessment. Remote configured; git ls-remote returned empty repository. gh auth status: not logged in. No pushes/remote PRs/Actions run yet. Local merges are not PRs.

API smoke succeeded http://localhost:4300/api/v1/health (3000 already occupied; don't stop unrelated service). API process may remain from exec session64269. No browser QA yet. GitHub authentication and local GEMINI_API_KEY remain external prerequisites; never ask user to paste key into chat. User approved Gemini and supplied repo link.

## Next work

Continue from latest increment above, then implement server login/tier/four-eyes/approval lifecycle. Add grounded Q&A prompt/citation checks and actual15-case evaluation. Then React core UI, seed/Compose full app and provider smoke. Core gate before hybrid/rewriting/agents/SSE/local fallback/auto product/PDF letter/usage. Full target details in planning files.

## Known limitations to resolve

No seed/evaluate scripts yet despite reserved package commands. Compose currently DB only. Chunker uses conservative character splitting; does not yet implement exact token budget/overlap or complete revision replacement history. Missing explicit probation evidence in APP-002/003/005 must refer; never assume in Demo. No authentication, actual assessment persistence, approval endpoints or fraud queue yet. Current DB original evidence storage is restricted by architecture, not implemented server auth yet. No live retrieval quality/cost numbers. CI YAML exists locally but not executed on GitHub. Later migration upgrade tests and secret scan still required. Sanitization/extraction currently supports supplied English layouts; contradictory repeated labeled values are explicitly rejected and regression tested; broader unsupported-layout coverage remains needed. Keyword tamper flag is not a complete fraud detector; allowlisting and field verification are the core boundary. Do not claim every initial plan requirement complete.
