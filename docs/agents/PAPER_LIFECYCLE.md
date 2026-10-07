# Evidence-bound AI review on the merged project

Scope: the evidence-bound review wrapper and separate paper lifecycle library,
updated 2026-10-07. Production selection reuses the committee components but persists
its audit in `selection_runs.review`, then feeds the bench and roster. The lifecycle
storage described below is not the production scheduler or configuration authority.
See [the integration map](PRODUCTION_INTEGRATION.md) and
[PIPELINE.md](../ingest/PIPELINE.md) for that path.

## Review and persistence

`backend/review/committee/workflow.ts` is a server/paper wrapper around the
existing deterministic committee core. It binds full curves, positions, patterns
and correlation/link evidence. Role/Risk receive that rich evidence independently;
Red-Team receives the evidence plus the exact draft. Node responses must match
the evidence hash, configured node identity, prompt and model configuration.

Native outputs are strictly validated and audited before a successful review.
`backend/review/committee-audit.ts` stores each node observation with provenance;
its `quorum: 1` is explicitly a node observation, not aggregate consensus. The
existing core performs the actual quorum/median checks. Red-Team audit records
now include the precise policy, sources, cash and draft hash sent to the critic.
An unavailable audit store prevents a valid review.

The receipt commits evidence, model configuration, manifest and sorted audit IDs.
It has `mode: PAPER` and `economicAuthority: false`; it grants no live authority.
`backend/review/paper` persists local sessions and a receipt-bound paper freeze.
Further reviews use a disjoint, bounded monitoring callback: only candidate concern
categories and severity are accepted, never weights or orders. Repeated monitoring
of the same evidence reuses its persisted result. Conflicting freezes or review
writes after freezing reject. Pause state is durable but is **paper-only** and does
not replace the existing executor's controls.

The production freeze tool is unchanged. A paper database freeze does not deploy
or pin configuration to production. That remains a separately reviewed deployment
step using `packages/backend/scripts/freeze.ts` and the [runbook](../ops/RUNBOOK.md).

Apply `supabase/migrations/20261006140000_paper_review.sql` after the existing review
audit migration in staging. It adds service-only sessions/events and RPCs. Browser
roles have no access. No migration was applied to a hosted project.

## Provider adapter

`backend/review/models/openai-paper.ts` implements full Role/Risk/Red-Team server
requests to the fixed OpenAI HTTPS endpoint. It checks strict structured output,
pinned response model identity, refusal/incomplete output, candidate identities,
canonical schemas, deadline and serialized request size. It never retries
implicitly, follows redirects, logs keys or stores authorization headers.

The adapter produces one honestly labeled local `paper-provider` observation
(quorum 1). It is not proof that several independent observations agree. Pass a pinned model, versioned
prompts, server-only API key and matching `committeeAudit` callback explicitly.
Construct separate model configurations for evaluation; do not treat competing
models as a quorum. The tests described here use fake HTTP and synthetic specialist responses; those
tests make no billable model requests. This does not describe production provider usage.

## Integration checks

- `pnpm paper:lifecycle`: actual SQL review/audit/session tests, disk restart,
  monitoring-only behavior, persisted monitoring replay, audit failures and pause.
- `pnpm test`, `pnpm typecheck`: existing review checks plus provider response
  failure cases.
- `bun test` in `packages/executor`: the review integration test feeds a rich
  committee's output into the frozen configuration, the **current** backend snapshot
  builder, `targetsFromSnapshot`, the executor runner, planner and SDK dry-run
  transport. All market data and keys are synthetic; no exchange network
  submission occurs.
- Existing backend/executor tests and PostgreSQL CI checks remain intact.
  `Service checks` runs alongside `Agent review checks`.

PGlite verifies local SQL semantics; PostgreSQL service tests separately exercise
main's existing persistence adapters in CI. Neither proves live deployment or real
fills. Production selection and roster reviews are scheduled by Vercel Cron;
this separate paper-monitor lifecycle is not wired as an additional production job.
Two-model point-in-time selection/shadow evaluation and deployment-specific funded
validation remain separate evidence requirements. Current runtime integration is recorded
in [docs/ops/RUNBOOK.md](../ops/RUNBOOK.md) and
[production integration status](PRODUCTION_INTEGRATION.md).

Guidance consulted:
- [antfu skill on skills.sh](https://skills.sh/antfu/skills/antfu): explicit interfaces and module/runtime ownership, while retaining existing Node/Bun tools. No global installation or toolchain replacement.
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs): strict schema plus refusal/incomplete-output checks.
