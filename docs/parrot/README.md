# Parrot

Parrot is an optional extra page over the existing PerpParrot pipeline: explore wallets by conversation, inspect the facts behind the answer, and prepare a **SIMULATION-only** request. It has no trading authority. **“LLMs judge, code allocates”**: models interpret preferences and judge sentences; code selects wallets and builds the preview. Receipt judgments never change allocations.

## Surfaces

| Page | Use |
| --- | --- |
| `/parrot` | Talk live, explore the flock, inspect the compact sentence receipt, then review a pending request |
| `/parrot/receipts` | Judge a typed sentence against an invented sample receipt; inspect the Decisions call |
| `/parrot/receipts/live` | Watch a feed of completed Live sentences and their pinned receipts |
| `/parrot/lab` (development only) | Audition sounds and mock flock scenarios; no provider calls; production returns 404 |

## Architecture

```text
Browser: /parrot and receipt pages
  | POST /live/session (SDP) <--> backend <--> OpenAI GPT-Live
  | <================ WebRTC voice / tool events ===============>
  | POST /live/strategy (validated intent) <--> backend code
  | POST /live/plan ----------------------> reviewable plan (no save)
  | POST /live/request (confirmation) ----> pending SIMULATION request
  | POST /chat/preview (intent) -----------> optional text preview / pending request
  | POST /decide/receipt (claim + facts) <--> backend <--> OpenAI Decisions API
  |                                                     (display-only opinion)
  |                         backend reads only:
  |                         pipeline_accounts -> Score -> shortlist + facts
  |                         active configuration -> policy / source comparison
  |                         paper books + stored snapshots -> context
  |                                     ^
  +---- rendered facts / preview ------- | existing pipeline on our infrastructure
                                        | review -> bench -> roster -> freeze -> targets -> executor
                                        | (separate authority; Parrot cannot invoke it)
```

GPT-Live delegates preference reasoning to its server-configured backend model; the browser returns `set_strategy` results from our backend. The optional text endpoint is `POST /chat`. Backend paths above have the `/api/backend` prefix on Vercel. Exact payloads: [technical reference](../PARROT.md#endpoints-and-configuration).

## Which doc do I read?

| Need | Read |
| --- | --- |
| Integrate, extend, configure or deploy Parrot | [INTEGRATION.md](INTEGRATION.md) |
| Rehearse, present, answer questions or handle an outage | [DEMO.md](DEMO.md) |
| Check intent semantics, caches, receipt lifecycle, source files or recorded evidence | [Technical reference](../PARROT.md) |
| Understand the execution pipeline | [Root design](../../README.md), [AI review integration](../agents/INTEGRATION.md) |
| Operate the shared services | [Runbook](../ops/RUNBOOK.md), [deployment](../ops/DEPLOY.md) |

Start with the page you need; the main dashboard and execution loop do not depend on a Parrot session.
