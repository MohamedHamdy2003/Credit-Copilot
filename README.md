# Credit Copilot

Synthetic personal-loan underwriting assistant. Implementation is in progress;
the detailed scope and delivery sequence live in `docs/planning/`.

Start with [DAY-1-REVIEW.md](DAY-1-REVIEW.md) for the tested checkpoint, commands,
architecture diagram, expected results and limits. Command details are in
[scripts/README.md](scripts/README.md). [status.md](status.md) records the handoff.

## Development prerequisites

Node24, pnpm11.25.0, Docker Desktop with Linux containers.

```sh
pnpm install --frozen-lockfile
docker compose up -d db
pnpm test
pnpm typecheck
pnpm build
```

Run `pnpm dev:api` and `pnpm dev:web` in separate terminals. API health is
`http://localhost:3000/api/v1/health`; OpenAPI is at `/api/docs`.
The initial web shell reports backend connectivity and is not a completed assessment UI.
If3000 is occupied, use an available port (`$env:PORT='4300'; pnpm dev:api`
in PowerShell). To use the shell against that port, set API_PROXY_TARGET to
http://127.0.0.1:4300 before starting pnpm dev:web.

Copy `.env.example` to `.env` before provider/database use. Never commit credentials.
Strict assessment mode is the default. Demo mode must be explicitly enabled and may
assume only ID-copy presence, never verification. Policy editions drive the calculation
engine: CP-2024 uses50% DBR; CP-2025 uses45%. See the planning discrepancy record.

No real lending data or production banking decisions are supported. All provided
documents are synthetic. LLM arithmetic and autonomous approval are prohibited.
