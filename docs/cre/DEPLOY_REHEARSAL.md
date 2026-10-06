# Deploy rehearsal (dry run)

Deploys every piece in its production shape **before** CRE deploy access and **before** the
go-live freeze, then swaps in the real set and the DON. Nothing here sends an order: `DRY_RUN`
stays unset throughout. Reference for variables and failures: [RUNBOOK.md](RUNBOOK.md).

| Phase | Needs | Proves |
|---|---|---|
| A. Services | Supabase, Railway, Vercel | images build and boot in production mode, tables and policies, services agree on one configuration, dashboard reads them, executor refuses non-DON reports |
| B. DON | CRE deploy access, the frozen go-live set, our HL account | DON-signed reports verify against the Capability Registry and execute as a dry-run plan every 10 minutes |

## Phase A: services (now)

Phase A runs on the **fixture** configuration (`packages/backend/fixtures/frozen-configuration.json`:
7 real sources, AGGRESSIVE, hash `0x088fe80a…e1dd`). Its account `0x010461c1…703a` is a large public
vault standing in for ours; the services only *read* it.

1. **Supabase** (project `clheeepphmomkymawsfq`): in the SQL editor, run
   `20261006120000_cre_mirror.sql`, then `20261006130000_review_audit.sql` (both idempotent
   apart from `review_audit`'s first create). Other migrations, such as the ingest tables, may
   already be applied by hand outside CLI history: don't `supabase db reset` or blindly
   `db push` this project (RUNBOOK § Deploy). Copy the service-role connection string
   (Session pooler) for steps 2–3.
2. **Railway snapshot service**: new service from this repo, root directory = repository root,
   config file `packages/backend/railway.json`. Variables:
   ```
   CONFIGURATION_PATH=fixtures/frozen-configuration.json
   FROZEN_CONFIGURATION_HASH=0x088fe80aef2b0d1d58a2e483073105c141fcf4d13ef80f934dfe811c81e6e1dd
   DATABASE_URL=<service-role connection string>
   ```
   Generate a public domain.
3. **Railway executor**: same repo and root, config file `packages/executor/railway.json`. Variables:
   ```
   HL_ACCOUNT=0x010461c14e146ac35fe42271bdc1134ee31c703a
   FROZEN_CONFIGURATION_HASH=0x088fe80aef2b0d1d58a2e483073105c141fcf4d13ef80f934dfe811c81e6e1dd
   WORKFLOW_OWNER=0xc5feb3cf878c9ba42a776e9edf62a4558ab08b85
   ADMIN_TOKEN=<openssl rand -hex 32; keep it in 1Password>
   DATABASE_URL=<service-role connection string>
   ```
   Leave `DRY_RUN`, `VERIFY_REPORTS` and `HL_API_WALLET_KEY` unset. `NODE_ENV=production` comes
   from the Dockerfile. Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Generate a public domain.
4. **Vercel dashboard**: new project, Root Directory `packages/dashboard`, variables
   `NEXT_PUBLIC_BACKEND_URL` and `NEXT_PUBLIC_EXECUTOR_URL` = the two Railway URLs (https, no
   trailing slash).
5. **Check** (exit 0 expected, one warning about `WORKFLOW_NAME`/`DON_ID`):
   ```sh
   DATABASE_URL=<…> bun scripts/predeploy-check.ts --services-only \
     --configuration packages/backend/fixtures/frozen-configuration.json \
     --backend https://<backend> --executor https://<executor> --dashboard https://<dashboard>
   ```
6. **Production-config simulation**: put the two Railway URLs in
   `packages/cre-workflows/mirror/config.rehearsal.json` (`executorUrl` ends in `/reports`), then
   between **:x8:00 and :x9:50** (the simulator stamps the next `:x0`; production limits allow a
   120 s lead):
   ```sh
   cd packages/cre-workflows
   cre workflow simulate mirror --target rehearsal-settings --trigger-index 0 --non-interactive
   ```
   Expected: `spot-check max deviation N bps`, then `executor rejected the report: HTTP 401`. The
   executor logs `unexpected workflow owner 0xaaaa…`: a production executor refuses the simulator's
   reports, which is the point. The snapshot service logs `paper books stepped`, and the dashboard's
   performance chart and holdings fill in within a minute.

**Rehearsed locally on 2026-10-06** (both Railway images via `docker build`/`docker run` with
`NODE_ENV=production`, a Postgres with Supabase's roles and both migrations, the production
dashboard build): step 5 passed with the one expected warning, step 6 gave exactly the outcome
above (spot-check 0 bps; 401 on the owner check; 1 snapshot and 4 paper points in Postgres, no
executor rows), and the dashboard showed "Dry run · Copying", the paper books and the holdings.

## Phase B: DON (when deploy access is enabled and the set is frozen)

1. **Freeze** the review core's configuration for our account (RUNBOOK § Freeze). This writes
   `packages/backend/frozen/live.json` and pins the hash in `mirror/config.production.json`.
2. **Reset rehearsal data** (it was computed on the stand-in account and the fixture set):
   ```sql
   truncate paper_state, paper_points, cre_snapshots, cre_eligibility;
   ```
3. **Railway variables**: snapshot service `CONFIGURATION_PATH=frozen/live.json` and the new
   `FROZEN_CONFIGURATION_HASH`; executor the new hash and `HL_ACCOUNT` = our account.
4. **Mirror config**: the two Railway URLs in `config.production.json`; commit with the freeze.
5. **Secret** `mirrorSamplingKey` in the Vault DON (RUNBOOK § `mirror` workflow).
6. **Check, full** (no `--services-only`): `DATABASE_URL=<…> bun scripts/predeploy-check.ts
   --backend … --executor … --dashboard …` must exit 0.
7. **Deploy** with the **CRE deploy** GitHub Action (`mirror`, `production-settings`).
8. **Watch** two or three cycles: the heartbeat gains a green cell every 10 minutes; each run in
   the run log shows the DON signature count and its report downloads. Then
   `bun run scripts/verify-run.ts --executor … --backend …` in `packages/executor`, and set the
   `WORKFLOW_NAME` and `DON_ID` it prints on the executor.

Going live (`DRY_RUN=false`, API wallet, funding) is RUNBOOK § Deploy step 7 and is not part of
this rehearsal.

## Undo

Railway: remove the services. Vercel: remove the project. Supabase: the tables are only read by
these services; `truncate` them or leave them. CRE (phase B): `cre workflow pause`, or pause the
executor (`POST /admin/pause`) to keep the workflow running without plans being acted on.
