# Live vector smoke baseline

## Verified correction

The failed tenor case was traced using the real provider response: it returned
the correct source quote under `text` rather than `quote`. The selection schema
now explicitly normalizes this one alias while retaining source-span verification.
A unit regression covers it. Both the next live run and a further run after
versioned reindexing passed all five cases: hit@5 3/3 answerable cases, refusal
correctness5/5, OOC refusal2/2. This supersedes the unresolved status below, which
is retained as the original failure record. Threshold remained0.65.

Real Gemini requests executed17 November2026; this is a five-case smoke baseline,
not the full15-case FR-6 evaluation. Model gemini-3.5-flash-lite; embeddings
gemini-embedding-001,768 dimensions; cosine threshold0.65; top5.

All seven trusted documents ingested successfully:87 chunks total. Second ingestion
skipped all seven without re-embedding. Customer application packs were not indexed.

| Case | Retrieval hit@5 | Observed answer behavior |
|---|---|---|
| DBR2024 | Yes | Cited50% |
| DBR2025 | Yes | Cited45% |
| PL-10072 months | Yes (CP-14) | Incorrect refusal; unresolved failure |
| Crypto-backed loan | Not applicable | Correct refusal |
| SME revolving credit fees | Not applicable | Correct refusal |

Answerable retrieval hit-rate3/3; refusal correctness4/5 across all five cases;
out-of-corpus refusal2/2; false refusal1/3 answerable cases. These small denominators
do not demonstrate general accuracy. No calculation exactness measurement in this
smoke suite; arithmetic is tested independently in Jest.

The first and second runs both refused the tenor question despite a strong CP-14
candidate (cosine about0.801). A whitespace-only quote-verification enhancement
was regression tested but did not resolve this live case. Root cause remains to
be isolated between model selection/schema and quote verification. Do not reduce
the threshold or label this case passing. Preserve original model response safely
in future diagnostics (policy only) to diagnose it.

Local ignored artifacts: artifacts/live-vector-smoke-initial.json and
artifacts/live-vector-smoke.json include candidate IDs/scores and returned citations.
No keys or applicant personal data included. Initial failure retained separately.
The evaluate command exits nonzero when expected refusal behavior fails.

GitHub authentication was verified for MohamedHamdy2003; no remote PR/CI result is
claimed by this report. Day1 remains open until outstanding acceptance requirements
and the live tenor failure are resolved.
