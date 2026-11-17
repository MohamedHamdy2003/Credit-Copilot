# Project commands

Run commands from the repository root:

| Command                          | Requires                  | Behavior                                                                                    |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| pnpm db:migrate                  | PostgreSQL + DATABASE_URL | Explicit pending migrations; never synchronize                                              |
| pnpm seed                        | PostgreSQL + Gemini key   | Index seven reviewed policy files; per-file status; APP packs stay isolated                 |
| pnpm ask "question" "2025-04-03" | Indexed DB + Gemini key   | Five vector candidates, source-verified quotes or refusal                                   |
| pnpm calculate [input.json]      | No DB/key                 | Source-backed numeric answer; defaults to calculation-example.json                          |
| pnpm evaluate:offline            | No DB/key                 | Deterministic Q&A/calculation regression tests                                              |
| pnpm evaluate                    | Indexed DB + Gemini key   | Five real-provider smoke cases; artifacts/live-vector-smoke.json; fails on refusal mismatch |

The live script is not the full15-case FR-6 evaluation. The web/API commands currently start a connectivity shell and health/OpenAPI scaffold. They do not expose a completed assessment/approval UI or API.
