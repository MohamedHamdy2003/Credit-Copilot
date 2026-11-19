# AI usage log

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
