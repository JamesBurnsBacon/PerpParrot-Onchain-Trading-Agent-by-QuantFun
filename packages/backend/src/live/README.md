# Talk live

GPT-Live voice endpoints: `config.ts` (server-owned session config, reservation), `handler.ts` (`/live/session`, `/live/strategy`).
Behaviour, environment variables, safety controls, residual risks and the verification record live in [docs/PARROT.md](../../../../docs/PARROT.md).
`LIVE_ENABLED=true` turns the routes on; the default is off.

`bun packages/backend/scripts/live-mutations.ts` runs five mutations in disposable copies and checks that a named guard test fails for each.
