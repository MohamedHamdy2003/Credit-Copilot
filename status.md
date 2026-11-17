# Current checkpoint —17 November2026

Read agent.md for rules; DAY-1-REVIEW.md for user reproduction; docs/planning for remaining scope.

## Verified state

Day-one engineering checkpoint promoted through PR1 feature/grounded-policy-qa ->dev and PR2 dev->main. Both merged, remote checks green before merge. Main commit12832a9. Main push CI44134091482 completed successfully (58s), including tests, migrations, build and secret scan. Current test/review-readiness branch also fixes stale script docs, tests blank/encrypted/corrupt PDFs and supports API_PROXY_TARGET for a non-default API port.

62 unit tests,5 real PostgreSQL integration tests, types/lint/format/build passed. Gitleaks full history clean. CI includes offline Q&A/calculation regression, migration twice, real database integration and secret scan. Real Gemini vector smoke passed five cases after initial tenor false refusal: hit@5 3/3 answerable, refusal correctness5/5, OOC2/2. Initial failure preserved docs/LIVE-SMOKE-2026-11-17.md. Root cause correct quote under text instead of quote; explicit alias normalization plus exact source-span verification fixed it. Don't claim full15-case FR-6 done.

Seven policy files indexed; repeated seed skips. Migration IndexRevisions applied to local databases. Legacy chunks retained, new pipeline active; retrieval filters active/version/date/product/model. Chunker uses pinned cl100k_base800/60, documented as chunking budget not Gemini billing. Strict structured numeric questions via pnpm calculate use source policy and CSV rates; request overrides rejected. Broad natural-language arithmetic unsupported, never let model calculate.

Gemini key exists locally and gh is authenticated as MohamedHamdy2003. Never output .env/key. Docker PostgreSQL healthy on54329. API only health/OpenAPI scaffold; React only shell, not complete UI. No stretches begun.

## Next implementation —day2

Create feature/assessment-workflow from up-to-date dev. Earlier partial assessment internals were included in the day-one release and are documented as incomplete. Finish server-side evidence-fact derivation (never trust client verifiedFacts/evidence flags), separate eight typed Mastra stages, persist immutable results/audit/referrals, actual policy-clause retrieval and audit of retrieved IDs/usage failures. Current Mastra has assessment wrapper + optional persistence stage only. Then auth/authority/four-eyes/approval, minimal React workflows, full15-case evaluation and core gate before stretches.

Domain: packages/domain. Application: packages/application. Infrastructure: packages/infrastructure. Presentation: apps/api and apps/web. Application defines ports; Infrastructure implements them. Domain imports no I/O/frameworks/models.

## Decisions/limits

Strict default missing ID =>REFER_TO_HUMAN CP-8/PS-7. Demo assumes ID presence only, verified=false and audit. APP-002/003/005 unclear probation must refer unless actual evidence supplied; no extra assumptions. APP-004 real18000 never injected200000; fraud referral. Policy2024/2025 maxDBR50%/45%, capacity382000/330000; correct Appendix E discrepancy. Numeric output only code. Same version/different bytes rejected; pipeline revisions preserve old citations. Blank/encrypted/corrupt PDF fixtures now pass; broader unsupported layouts still require explicit referral. No finished login, approval endpoint, complete UI, offer document or deployment. Evaluation threshold0.65 is provisional based on small smoke, not a calibrated general guarantee.
