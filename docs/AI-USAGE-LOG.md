# AI usage log

## 2026-11-20 original-source review and synthetic auto loans

The user asked Codex to compare the project against the uploaded brief and
source pack before adding AL-200. Codex checked the twelve source hashes,
compared rule and citation behavior with the source clauses, and implemented
the corrections. Codex authored the additional fictional policy, price and
case documents and connected them to the existing human decision workflow.
The auto evaluation uses provider fixtures. The new source files and tests
record the policy choices for candidate review.

The first Chromium check used an exact label selector that did not resolve the
product control. The Playwright accessibility snapshot showed a combobox named
Product. The test switched to that role and verified the selected edition and
source citation on a mobile viewport.

## 2026-11-20 streaming

Codex added authenticated assessment progress and verified citation streams,
plus replay and terminal states in the web interface. HTTP and Chromium checks
exercise disconnection, session revocation and one saved assessment across retries.

## 2026-11-20 typed assessment agents

Codex wired three Mastra agents to the existing source-verified operations.
The provider proposes a bounded JSON tool call, and the server binds the task
inputs. The paired fixture test verifies parity and rejects scope changes,
unauthorized tools and multiple requests. The live run at `2cf9a5d` verified
18 tool executions and their audit rows. The first report records the
provider failure and the repeat uses explicit pacing.

## 2026-11-20 local Ollama fallback

Codex implemented bounded Gemini-to-Ollama generation fallback and kept the
existing sanitized input, source validators and embedding provider. Unit and
PostgreSQL/HTTP tests inject provider failures and cover the audit path.
Clean commit `01beb5d` also passed two real local generation checks against
Ollama on CPU with an injected Gemini outage. The assessment memo was produced
by code. Memory and elapsed times are recorded under Evaluation.

## 2026-11-20 query rewriting

Codex added a typed lexical expansion budget and tested the original and expanded
glossary queries against one PostgreSQL snapshot. Integration checks exercise
a qualifying promotion, preserved original hits, product and date constraints,
an unchanged embedding input and the human approval bypass. Gemini measured
the existing 15 cases at clean commit `a1b855b`. The glossary ran locally.

## 2026-11-20 hybrid retrieval

Codex implemented PostgreSQL BM25 and reciprocal rank fusion over the existing
policy index, then checked hand-computed scores, shared filters, ties and
single-branch hits on PostgreSQL. Two Gemini evaluations ended 14/15 after
generation calls failed. Both full reports were retained. The evaluator now
records retrieval before generation and can retry upstream errors within a
small per-run limit. The clean hybrid run at `7e9832f` passed 15/15.
The vector and hybrid runs both scored hit@5 4/4 on the same four questions.

## 2026-11-20 full evaluation/core checkpoint

Codex implemented the fifteen-case evaluator, independent golden expectations,
exact numeric/security/fairness/audit assertions, live/offline separation, immutable
sanitized reports and CI regressions. It re-read the original DOCX and preserved
the distinction between instructions in the brief and the user's authorized work;
no submission email/video upload was performed.

The first real run failed4/15 despite raw hit@5=4/4: Q01/02/03 lacked necessary
operative/conflicting citations; Q11 omitted policy edition after early tampering
referral. Metadata and separately linked source context repaired completeness
without changing vector ranking/threshold, and safe policy selection repaired audit.
Initial failure and final15/15 report are committed, not replaced by a success-only
summary. Three real live executions were observed; fake CI never claims semantic
quality. Code-filled referral memos, failed-JSON usage preservation and a tested
one-command local launcher close concrete core gaps; dead placeholder config was
removed. No probation/ID evidence, provider cost or commit date was fabricated.

## 2026-11-20 referrals and written reasons

Codex re-read PM-4/5/7/9 from the supplied manual and CP-8. PM-9 requests a written
reason within30 days; it does not specify an appeal adjudication workflow. New
case-review code/UI therefore preserves the human decision and returns a recorded
reason snapshot. Review also identified earlier rejection code accepting missing
evidence/referral citations; this was corrected to verified failures or a declined
alternative, without changing source requirements. Day30 inclusion/Cairo decision
date and the configurable business calendar are documented implementation choices.
No actual Fraud Unit delivery or live Gemini quality measurement is claimed.

## 2026-11-20 React workspace

Codex authored the React session/forms/tables/assessment/review screens, client,
CSS and Playwright suite, reusing the real REST and workflow. The frontend-builder
skill used built-in Image Gen for a minimal workspace concept; the production UI
contains code-native controls and real server data, not that image or sample rows.
Visual QA compared concept, desktop and mobile renders. Browser plugin was absent;
Playwright used Chromium. Tests initially selected a form label too narrowly and
clicked the previous case before the new upload completed; selectors now use the
accessible combobox role and await the upload response/new case heading. A client
test caught cross-realm AbortError handling; cancellation detection was corrected.
No policy thresholds/evidence were changed to make UI tests pass. Provider output
in browser tests is fake; user review of AI-authored code remains required.

## 2026-11-17 planning and implementation

Codex read the supplied synthetic corpus and brief, proposed architecture and PR sequencing, and authored implementation with user review. The user chose the stack, strict/demo behavior, source-authoritative calculations and CI scope. Code written by Codex must be reviewed and understood by the submitting candidate; no claim of independent manual authorship is made.

Actual planning mistakes corrected:

1. Codex initially proposed demo assumptions for probation completion as well as the missing ID copy. The user explicitly limited demo to ID presence. Planning was corrected; other missing evidence must still refer.
2. Codex supplied an obsolete `isEvalSupported` PDF.js option copied from knowledge of older versions. TypeScript rejected it against the installed PDF.js6.5.438 declarations. The option was removed and the parser is checked against the actual installed API and all12 source files. This illustrates why library assumptions need compile/runtime verification.

The Appendix E arithmetic inconsistency belongs to the supplied brief, not an invented AI mistake: independent decimal arithmetic confirmed 330,000 at45% and382,000 at50%. Real five-case Gemini evaluation has run; results and the corrected tenor failure are recorded in EVALUATION.md.

## 2026-11-19 core REST implementation

Codex authored authenticated operations ports/controllers, private application
storage, assessment-job migration and HTTP integration coverage. Existing source
policies, calculation engine and eight-stage assessment workflow were reused.
Review identified a decision/reassessment race; decisions now share the application
lock and reject during an active job. A first concurrency test was unreliable
because its fake provider finished too quickly; an explicit provider gate now
tests overlapping requests. A CORS-header assertion initially failed TypeScript's
undefined check and was corrected before the passing validation run. HTTP tests
use fake provider output; no new live Gemini quality result is attributed to them.
