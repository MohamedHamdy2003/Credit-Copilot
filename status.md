# Current checkpoint —19 November2026

Read agent.md for rules, README for commands, FEATURES.md for feature status and docs/PR-PLAN.md for sequence. Current branch feature/assessment-workflow.

## Completed increment

Eight-stage document assessment now lives in packages/application/src/document-assessment.ts and infrastructure/workflows/document-assessment.ts. Local form/evidence-facts code derives fields; no caller verifiedFacts/evidence flags accepted. Exact applicable policy clauses loaded from PostgreSQL, checked for required IDs/date/edition and DBR agreement. Code-only calculations/memo; result remains pending human approval. Stage events distinguish executed/skipped/failed; persistence is atomic and errors propagate. Quote-validated extraction tokens recorded even if subsequent JSON validation fails. Fraud referral recorded before any model call for APP-004.

Use pnpm assess APP-001 (Strict). For explicit synthetic Demo, set ALLOW_DEMO_MODE=true in the current shell and run pnpm assess APP-001 --demo. CLI only selects shipped APP-001..005; it creates separate private application/original-byte records with a disabled fixture account, not a login. Do not expose this CLI/internal identity setup as an authenticated API. ID presence is never fabricated; all supplied original packs lack the ID copy. Demo waives ID presence only. APP-002/003/005 unresolved probation still refers. Unsupported layouts or purpose classification refer.

Verification:72 unit tests,5 existing PostgreSQL integration tests, types/lint/format/build passed. Real Gemini/DB CLI: APP-001 Strict referral, Demo APPROVE pending_approval with EMI8630.39/cap330000, APP-004 fraud referral without model call; APP-002/003/005 Demo referrals. Original day1 vector baseline remains5/5 smoke, not full15-case FR-6. Secrets remain local.env, never output. Docker was stopped and has been restarted. Workflow stores no Mastra snapshots; raw originals stay in case storage.

Legacy assessment.ts and workflows/assessment.ts are retained for previous regression harnesses, deprecated for new entry points. New code uses the document workflow. Human approval/auth/full REST/React remain unimplemented. Public transport must derive actor/synthetic status server-side; never accept them as unrestricted client evidence assertions. Full evidence verification is not claimed (presence and source matching are distinct from human authenticity verification).

## Next feature

Login/permissions and approval lifecycle: two RBAC roles with server-owned Credit/Senior/Head tiers (250k/500k/1m), four-eyes, stale/concurrent decision checks, alternatives/customer response, approved then issued. Then REST/OpenAPI and minimal React UI; full15-case evaluation/core gate before all nine stretches.

## Fixed decisions

Strict default; missing ID=>REFER_TO_HUMAN CP-8/PS-7. Demo ID-only assumption logged verified=false. Policy2024/2025 DBR50%/45%, capacity382000/330000; source overrides inconsistent Appendix E. Strip protected fields before any model/rules, mask IDs/phones. Customer packs never policy KB. Pure domain no I/O/framework imports. Named feature branches ->dev ->main only after green tests/CI. No fake dated commits or invented measurements. No extra documentation: keep required docs and user-requested FEATURES/PR-PLAN/agent/status only.
