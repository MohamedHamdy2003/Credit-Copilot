# Current checkpoint —19 November2026

Read agent.md and FEATURES.md first. Current increment: feature/core-rest-api,
following merged approval/access PRs9/10. Core authenticated REST is implemented;
React remains a connectivity shell. Update this checkpoint after PR promotion.

## Implemented and verified

OperationsService application ports in packages/application/src/operations.ts;
runtime composition in packages/infrastructure/src/operations.ts; storage in
db/application-store.ts; Nest routes in apps/api/src/app.ts. Reuses existing
parsers/ingestion/vector Q&A/calculation/eight-stage Mastra assessment; domain
remains independent of framework/database/model.

Authenticated policy upload/list/attempts, grounded questions, structured numeric
calculations, application upload/fixture selection/list/read/original download,
assessment and issued-offer read. Permissions reuse session/CSRF and server roles.
Only seven reviewed policy hashes enter KB; five known synthetic PDF hashes enter
customer assessment. Actor/synthetic flags are server-derived, extra fields rejected.
Case originals stay in private cases storage, metadata omits personal attributes.
Q&A masks ID/phone before embedding and generation; explicit question date/edition
must agree with selectors. No selectors means current Cairo date.

AssessmentJobs migration applied locally: owner/hash upload deduplication; one
active job per application; Idempotency-Key binds application/mode and replays
completed result. Failed keys need a new attempt key. New attempts expire abandoned
jobs after15 minutes; late writers cannot change latest assessment. Job success,
result/latest pointer/audit commit atomically. Decisions block during reassessment;
queue excludes superseded runs. Issued applications cannot be reassessed.

77 unit and23 real PostgreSQL/HTTP integration tests passed, including new eight
HTTP cases: login/upload/download/ownership, extension/MIME/size validation,
trusted ingestion, Strict/default/idempotency, Demo->approve->issue->read retaining
verified=false, concurrent job/decision blocking, fraud without provider calls,
identifier masking, date conflicts and abandoned-job recovery. Typecheck, lint,
format and API/web builds passed. HTTP tests use fake generation/test lexical
embeddings; no new live Gemini quality metric claimed. Real server4303 health,
OpenAPI multipart and unauthenticated access smoke checked. Previous real Gemini
CLI/five-case baseline remains in docs/EVALUATION.md; full15-case FR-6 unfinished.

## Next

React login/knowledge upload/questions/application assessment/review UI using these
routes. Read applicable frontend skills before UI work; brief requests minimal
styling. Then complete complaints and full15-case evaluation/core gate before nine
stretches. FEATURES.md updated; keep professional PR What/Why/How tested, green
feature->dev->main CI. Do not create extra docs. README has route/review instructions.

## Fixed decisions

Strict default missing ID=>REFER_TO_HUMAN CP-8/PS-7. Explicit enabled Demo assumes
only ID presence; result/audit/offer retain missing reality and verified=false.
Never invent ID/probation evidence. CP2024/2025 DBR50%/45%, capacity382000/330000;
source policies override inconsistent Appendix E via unchanged Decimal formula.
Remove protected fields before models/rules; customer packs never policy KB.
Human authority0/250k/500k/1m plus four-eyes before issuance. No unresolved referral
override or pricing deviation endpoint. DB54329; API default3000, use another port
if occupied. Secrets only local.env; never print them. Seed accounts only using
local DEMO_PASSWORD; CLI accounts disabled for login.
