# Current checkpoint —20 November2026

Read agent.md and FEATURES.md first. Current increment: feature/referrals-written-reasons.
Previous React delivery PR13/14 is on main c25a2a8; CI44713937697 green. Check git/GitHub
for current promotion status. Next work is full15-case evaluation/core gate, not stretches.

## Implemented

PM-4/5/7/9 case reviews: pure review-policy.ts, Application CaseReviewService ports,
PostgresCaseReviewStore and explicit CaseReviews migration1794916800005, registered
in data-source.ts and applied locally. Production/E2E composition wires the service.
Nest routes: GET referrals, GET referrals/:id, POST referrals/:id/reviews; GET
assessments/:id/written-reason and POST assessments/:id/reason-requests. Existing
session/CSRF/origin/schema/error guards apply. Mutations reread active actor in TX.

Rejection now permits only a verified failed criterion or customer-declined alternative,
not missing evidence/fraud/bureau-only referral. Notice snapshots store failed criterion
and human justification, clause, original edition/source and decision time. Legacy
backfill uses recorded clause/edition only; incomplete history returns ReasonUnavailable.
PM-9 request is recorded by the preparer on applicant behalf, with a deterministic
written reply from the stored human decision (no LLM/appeal/credit-state change).
Inclusive30-calendar-day window from rejection date in Cairo; DB clock, no client date.
Concurrent/repeated requests return one stored reply/audit pair; old replies remain
readable after expiry. Demo assumptions and verified=false are retained.

Referrals route to Senior/Head; ordinary Credit queue omits them. Independent Senior
can record awaiting-evidence/reassessment/internal-fraud notes under version/latest
and active-job checks. Notes never approve/reject/clear fraud or waive missing evidence.
Fraud Unit routing is internal record only, no external message sent. PM-4 two-business-
day estimate uses data/config/review-calendar.json: Fri/Sat default, no public holidays
invented; configure trustworthy holidays and restart. Estimate never changes outcome.

UI CaseReview.tsx adds written requests/replies and referral queue/history/forms, using
existing components/styles. Assessment hides decision form for missing/fraud referrals.
README/FEATURES/DESIGN/EVALUATION/AI-USAGE updated; no extra docs created.

## Verified

84 unit +27 real PostgreSQL/HTTP integration +8 Chromium e2e passed. Typecheck,
lint, format and API/web builds passed. New cases: day0/30/31/future/leap calendar,
configured weekends/holidays, permissions/CSRF/extra fields, concurrent idempotent
reply and unchanged rejected/version2, Demo false, late replay, Senior queue/notes,
unsafe rejection and unavailable legacy reasons. Browser PM-9 reply and independent
Senior note paths pass; screenshots inspected at1488x1058 and390x844 with no mobile
overflow, framework overlay or runtime error in the written-reply journey. Browser
plugin absent, regular Playwright used. Test-only controlled age-failure fixture
uses real pure rules/decision store with Demo ID presence only, no fabricated ID,
and is never ingested in production or substituted for original packs. Fake providers
remain confined to test wiring; no new live Gemini quality metric claimed. Screenshots
and traces remain outside git in OS temp. Local E2E servers stop after tests.

## Next

Implement/run full15-case FR-6 evaluation against real vector baseline; document
failures honestly, address core gaps and validate gate before nine stretches. Check
remaining partial FEATURES rows (canonical memo/audit) against actual brief; never
mark the entire core complete just because transport/UI tests pass. Keep feature->dev
->main after green CI and professional What/Why/How tested descriptions.

## Fixed decisions

Strict default missing ID=>REFER_TO_HUMAN CP-8/PS-7. Enabled synthetic Demo assumes
only ID presence, retaining actual missing reality/verified=false in result/audit/
offer/written reply. Never assume probation or fabricate evidence. CP2024/2025 DBR
50%/45%, capacity382000/330000 through unchanged Decimal formula; policy source wins
over Appendix E. Strip protected fields before model/rules; packs never KB. Authority
0/250k/500k/1m plus four-eyes. No unresolved-referral/pricing/policy exception bypass.
DB54329; web localhost5173 must match WEB_ORIGIN. Secrets local.env only; CLI fixture
accounts cannot log in. Integration and e2e share *_test DB: run sequentially only.
