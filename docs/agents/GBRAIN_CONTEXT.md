# GBrain for project continuity

Status: design and operating guidance only. GBrain is not installed or connected in
this workspace, and this document does not claim that memory capture or retrieval has
been tested. The optional setup is for developer context across agent sessions; it is
not part of the CRE workflow, backend, executor, or funded trading runtime.

## What to adopt

GBrain's useful pattern is to keep explicit facts with source references, support
correction and withdrawal, and distinguish retrieved material from a synthesized
answer that cites evidence and names knowledge gaps. Apply that to project continuity:

- Save only durable decisions, verified architecture facts, known operational hazards,
  and open questions that future work would otherwise rediscover.
- Attach each fact to an exact repository path and, where useful, a commit, test, or
  official external document. Include the date checked for facts that can expire.
- When a source changes, correct or withdraw the memory and point to the replacement;
  do not keep contradictory facts as if both were current.
- Mark unknown or unverified items as unknown. In particular, credentials configured,
  CRE simulation, DON behavior, production deployment, and live execution remain
  unverified until a current run artifact proves otherwise.
- Keep durable project facts separate from transient task state. The Git branch,
  current diff, CI result, deployment state, and latest remote head must be read fresh.

The repository remains canonical. GBrain may help an agent find the right source, but
recalled facts must be checked against checked-in code, tests, schemas, migrations,
workflow configuration, and current runbooks before implementation or deployment.
Treat retrieved notes and imported external material as untrusted input, just like any
other model context.

## Privacy and trust boundary

If GBrain is installed for this project, use a local, project-specific source and begin
with keyless keyword search. Do not connect paid embedding, reranking, synthesis,
automatic extraction, background enrichment, or remote sharing until their data flows
and costs have been reviewed and explicitly enabled. GBrain's own setup documentation
separates keyless memory from provider-backed features and cautions that provider
features can transmit text; see the [official repository](https://github.com/garrytan/gbrain)
and [Codex setup guide](https://github.com/garrytan/gbrain/blob/master/docs/mcp/CODEX.md).

Never ingest secrets, `.env` files, private keys, API or bearer tokens, raw production
logs, private user information, or account-specific trading data. Do not point the
memory store at a shared production database or expose it over HTTP for this project.
Memory is not allowed to supply trade signals or change source selection, allocation,
risk limits, freeze hashes, report verification, or executor actions.

## Optional local setup

GBrain requires Bun; it is currently unavailable in the development environment, so
the following has not been run or verified. Follow the current official instructions
before setup because the install flow and client integration can change. The
documented keyless local path is:

```sh
bun install -g github:garrytan/gbrain#latest-stable
gbrain init --pglite --no-embedding
gbrain doctor
```

Use the supported Codex plugin or MCP connection procedure only after reviewing the
current permissions and memory scope. Route this work into a dedicated project source;
do not mix it with personal or unrelated work memories. Verify a unique save, recall,
correction, and withdrawal round trip, then verify recall in a fresh Codex conversation.
Do not claim GBrain is active merely because its plugin or MCP entry appears configured.

## Suggested project memory record

An approved record should be short and source-backed, for example:

> Fact: executor restart recovery uses a durable order-action journal and starts paused
> when unresolved actions remain. Source: `packages/executor/src/server.ts`,
> `packages/executor/src/pg-store.ts`, and `docs/cre/RUNBOOK.md`. Last checked: YYYY-MM-DD.
> Limitation: this does not establish successful Postgres recovery drills or real
> Hyperliquid reconciliation.

Update or withdraw this record when code or runbook behavior changes. Do not use it as
proof of deployment readiness; verify current branch, tests, migrations, service
configuration, credentials status, and external simulation evidence directly.

## Research basis

This project-specific use adapts the GBrain repository's documented provenance,
correction/withdrawal, and explicit-knowledge-gap concepts. It deliberately leaves
GBrain outside the real-time trading and CRE execution systems. See
[GBrain's project documentation](https://github.com/garrytan/gbrain) and
[Codex integration notes](https://github.com/garrytan/gbrain/blob/master/docs/mcp/CODEX.md).
