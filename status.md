# Current checkpoint —20 November2026

Read agent.md and FEATURES.md first. Current feature: feature/react-workspace.
Previous REST was promoted through PR11/12 to main dbe7261 with green CI44588723148.
This increment implements the React core UI; check git log/GitHub for promotion state.

## Implemented

apps/web/src: App.tsx session shell/login/logout and navigation; Applications.tsx
reviewed pack selection/multipart upload/list/download/Strict-default assessment;
Assessment.tsx summary/rules/source references/saved workflow, Demo warnings,
customer alternative response, human approval/rejection/issuance and offer read;
Questions.tsx grounded citations/date+edition selectors and code calculations;
Knowledge.tsx policy list/per-file ingestion/history with permission controls;
Reviews.tsx queue and independent decision forms. Shared api.ts/components/types
and responsive styles.css. API client keeps only CSRF in memory; cookies HttpOnly;
401 clears protected views; navigation cancels reads. Retry preserves assessment
idempotency on uncertain network errors. No fake application rows or UI arithmetic.

Small API additions: safe canAssess derived from preparer; assessment read includes
issued offer_id. Existing authority/CSRF/evidence checks remain server-authoritative.
No new database migration. E2E uses shared WorkflowTestProvider extracted from the
HTTP integration test, not production code; scripts/e2e-api.ts binds4304, Vite5174,
only accepts *_test DB and resets test users/cases/login attempts. Run browser and
integration suites sequentially. No live credentials/model calls in browser tests.

## Verified

80 unit +23 PostgreSQL/HTTP integration +6 Chromium e2e passed. Typecheck/lint/format
and API/web builds passed. Browser paths: login/errors/session restore/logout,
Strict missing-ID/source/workflow/original download, APP004 fraud, explicit Demo
through different human reviewer approval/issuance with verified=false, policy
Q&A/refusal/conflicts, edition capacity330000/382000, multipart duplicate uploads,
knowledge mixed batch statuses/permission, expired session and network retry.
Desktop1488x1058/mobile390x844 screenshots inspected with view_image against the
built-in Image Gen concept; no horizontal mobile overflow. Browser plugin absent,
so regular Playwright used. Screenshots/traces stay in OS temp outside git. Other
engines and all responsive states are not certified. These fake-provider tests are
not a fresh Gemini quality measurement or the complete FR-6 fifteen-case suite.

README has run/review instructions; FEATURES/DESIGN/EVALUATION/AI-USAGE updated.
The concept is preview-only under .codex/generated_images; no raster assets shipped.

## Next

Complete Referral & Rejection Handling complaints workflow (30-day complaint window,
source-backed handling, no policy/evidence override), then full15-case evaluation
and core acceptance before all nine stretches. Preserve professional PR descriptions
What/Why/How tested, green feature->dev->main, and update FEATURES.md per feature.
Do not create extra docs. Read only relevant code/source clauses for the next task.

## Fixed decisions

Strict default missing ID=>REFER_TO_HUMAN CP-8/PS-7. Enabled synthetic Demo assumes
only ID presence, recorded verified=false in result/audit/offer. Never fabricate ID
or assume probation. CP2024/2025 DBR50%/45%, capacity382000/330000 via same Decimal
formula; real source policy wins over Appendix E. Protected fields removed before
model/rules; packs never policy KB. Authority0/250k/500k/1m and four-eyes enforced.
No unresolved-referral, policy-exception or pricing-deviation bypass. Local DB54329;
API3000 (alternate if occupied); normal web localhost5173 must match WEB_ORIGIN.
Secrets only local.env. Synthetic seeds require local DEMO_PASSWORD; CLI accounts
cannot log in. Nothing deployed automatically.
