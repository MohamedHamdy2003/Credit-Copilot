# Current checkpoint —19 November2026

Read agent.md, FEATURES.md and README before implementation. Branch feature/approval-access; previous assessment workflow is already on main. Current increment adds server sessions and controlled human decisions; no complete React UI yet.

## Implemented and verified

Application ports: auth.ts and decisions.ts. Pure access/authority rules in domain/access.ts. Infrastructure: scrypt credentials, PostgreSQL auth/session store and transactional decision-store. Presentation: apps/api/src/app.ts exported createApi for tests; main.ts composes real DB services without model calls. Added explicit ApprovalAccess and LatestAssessment migrations; applied locally. Server-authoritative tiers0/250k/500k/1m; HttpOnly/SameSite cookies, expiry/revocation, active checks, CSRF/origin checks, per-IP login throttle, strict schemas and request IDs.

Decisions lock run/application and verify expectedVersion/latest_assessment_id. Recheck user privileges in the transaction. Prevent self-approval, authority bypass, duplicate/concurrent decisions, approval before customer alternative acceptance, stale assessment and issue-before-approval. Issuance rechecks maturity using source policy and retains demo assumptions. Rejection requires a specific failed/missing clause. Unresolved/tampered referrals cannot be waived; add evidence and reassess instead. No policy-exception or pricing-deviation override endpoint. Approval result/status is distinct from original immutable assessment.

77 unit tests and15 real PostgreSQL/HTTP integration tests passed; types/lint/format/build passed. Real server smoke on4302: health ok, unauthenticated reviews401, OpenAPI generated. No provider calls needed for this feature. Local test server stopped. pnpm seed:users requires DEMO_PASSWORD12–256 chars locally; creates four synthetic accounts, revokes sessions on reset and never prints password. Fixture CLI disabled accounts cannot login. Full15-case FR-6 and UI are still unfinished. FEATURES.md updated to reflect exact scope; update it on every subsequent feature.

## Next

Finish REST: authenticated policy ingestion/Q&A/application upload+assessment and offer read endpoints, reusing existing domain/workflow/ports. Resolve actor/synthetic/evidence status server-side, not client flags. Then React login/upload/questions/assessment/review UI; referral/complaints completion; full15-case evaluation/core gate before nine stretches. Preserve current PR conventions: professionally describe actual What/Why/How tested, link executed evidence, state material limits; feature->dev->main after green CI.

## Fixed decisions

Strict default; missing ID=>REFER_TO_HUMAN CP-8/PS-7. Demo ID presence only, verified=false+audit. Never assume probation or fabricate evidence. CP2024/2025 DBR50%/45%, capacity382000/330000; unchanged Decimal formula, source overrides inconsistent Appendix E. Strip protected fields before model/rules, mask identifiers; customer packs never policy KB. No autonomous approval or LLM arithmetic. Source corpus at data/corpus; DB ports54329, API default3000 (use alternate if occupied). Secrets in local.env only. No extra docs beyond required files and explicitly requested FEATURES/PR-PLAN/agent/status.
