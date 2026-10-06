# Data for the Score team

The Oct 6 handoff contains the completed first-pass scan and the additional evidence needed to run the repository's strict Score. Large files are GitHub Release assets, so cloning the repository stays small.

Download from [the data release](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/releases/tag/score-data-2026-10-06), or run from `packages/backend`:

```bash
gh release download score-data-2026-10-06 \
  --repo JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun \
  --dir data/score-handoff-2026-10-06
bun install
bun --no-env-file src/ingest/loop/load-data.ts data/score-handoff-2026-10-06
```

The loader verifies file checksums, raw portfolio/order evidence and the Score source hash, then runs **`scoreCandidates(inputs)` with no overrides**. It writes `top100.json` and `score-results.jsonl.gz`. The release manifest records the exact counts and code version.

| File | Use |
| --- | --- |
| `score-inputs.jsonl.gz` | Ready-to-use `ScoreInput`, one JSON object per line |
| `top100.json` | Highest 100 eligible acquisition accounts with metrics and filters |
| `score-results.jsonl.gz` | Strict Score output for every exported input |
| `account-audit.jsonl.gz` | Outcome for every regular candidate, including exclusions, observed order counts and evidence references |
| `score-evidence.jsonl.gz` | Original portfolio/fill response strings and classification records behind the inputs |
| `portfolios.jsonl.gz` | Original portfolio evidence for all 20,869 scanned addresses |
| `discovery.jsonl.gz`, `research-screen.jsonl.gz` | Discovery metadata and first-pass screening decisions |
| `manifest.json`, `SHA256SUMS` | Counts, times, configuration, version and integrity checks |
| `anomaly-audit.json`, `anomaly-trace.jsonl.gz` | Masa follow-up: the 43-address XMR1 exposure group and live request-to-raw traces |
| `research-replay.json` | Recomputed v1 decisions/metrics and changed-arrival-order check |

For direct use in existing Bun code, without the helper:

```ts
import { scoreCandidates } from "./src/score";
const bytes = await Bun.file("data/score-handoff-2026-10-06/score-inputs.jsonl.gz").bytes();
const inputs = new TextDecoder().decode(Bun.gunzipSync(bytes))
  .trim().split("\n").map(line => JSON.parse(line));
const result = scoreCandidates(inputs);
```

The regular research cohort has 10,987 addresses; it is not already a strict-Score shortlist. Known filter failures are recorded before further fetching. Fewer than ten observed distinct filled orders leave `tradeCount` unknown and fail strict Score. Classification uses the existing vault-list/contract-probe rules; its evidence and limitations remain visible. Returns and drawdowns retain the team's existing sampled-history methodology.

This is a dated research dataset. Portfolio and fill observations have individual timestamps, not one simultaneous market timestamp. The Top 100 acquisition queue is separate from Score's 25 clone-grouped trading finalists. For the recurring worker and CRE connection, see [Top 100 loop](TOP100_LOOP.md).

[Masa follow-up](MASA_SNAPSHOT_AUDIT.md) explains the matching-return investigation and the two synthetic controls. These are investigation flags, not an extra grouping or eligibility rule.
