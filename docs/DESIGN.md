# Credit Copilot design

Implementation is incremental. See `planning/PROJECT-PLAN.md` for the target architecture;
this document records actual decisions and will expand as each feature lands.

## Source-authoritative arithmetic

The pure decimal calculation engine receives thresholds from versioned policy configuration.
CP-2024 CP-4.1 sets maximum DBR50%; CP-2025 CP-4.1 sets45%. With net income30,000,
obligations4,000, annual rate24% and60 months, the inverse annuity formula yields
382,369.7534… at50% and330,228.4234… at45%. Floor to EGP1,000 gives382,000 and330,000.
Appendix E incorrectly labels the case CP-2025 while retaining382,000 from the50% example.
The engine does not special-case the example or modify the formula to match Appendix E.
Tests cover both editions using the same function. EMI rounds half-up to cents; DBR
is compared using the exact numerator against income multiplied by policy limit,
not the displayed rounded percentage. Policy configuration is reviewed source-backed
data, never a request-level override. Pricing must come from parsed CSV rows.

## Evidence modes

Configuration defaults to ASSESSMENT_MODE=strict and ALLOW_DEMO_MODE=false. Missing
national ID copy in Strict mode produces REFER_TO_HUMAN/MISSING_REQUIRED_EVIDENCE,
citing CP-8 and PS-7. Explicit enabled Demo is restricted to synthetic cases and can
assume only ID-copy presence. The result and audit events record the assumption,
actual missing evidence, actor/time and verified=false. No document is fabricated.
Other missing evidence, including probation confirmation, still requires referral.
Demo assessments are never presented as fully evidence-verified; changes of mode
require a new assessment, not relabeling an earlier result.

## Domain isolation

Assessment persistence follows dependency inversion: Application owns the repository
contract and Infrastructure implements it using TypeORM transactions. Run insertion,
audit, demo assumptions, successful extraction usage and fraud referral events commit
together. Duplicate run identifiers cannot overwrite prior records. The repository
checks the stored application preparer against the recording actor. Mastra can append
a separate persistence step; public authenticated transport and the complete stage
breakdown remain unfinished.

The internal assessment use case now parses an allowlisted form, resolves mode and
policy, verifies model extraction against evidence, selects supplied CSV pricing,
runs pure rules and produces a deterministic numeric memo. A typed Mastra adapter
currently wraps this use case as one workflow step. It does not persist results or
approve/issue offers. Evidence verification facts are trusted internal inputs and
must be derived server-side before exposing an assessment endpoint; client-supplied
verification flags must never be accepted. Separate typed workflow stages and
immutable run/audit storage remain required before the core gate.

Pure domain functions have no database, network, NestJS, Mastra or model imports.
ESLint enforces the infrastructure boundary. Dates use UTC calendar-only values and
month-end clamping; maturity is compared with the60th birthday. Strict configuration
validation prevents the string "false" from being treated as a true boolean.
