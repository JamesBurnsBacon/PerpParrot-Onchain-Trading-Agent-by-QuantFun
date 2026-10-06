# Ingest → Score 数据对接（Masa 评审后）

2026-10-06。本地分支 `codex/ingest-score-live` 已快进至 main
`537e0c1750f7efe912705059da415a99600c391e`，保留 PR #11 采集代码及此前本地工作。
Score 源码与该主分支一致。本次数据对接随 PR #11 提交；以下验证不是已合并或部署的声明。

## 当前入口

- `packages/backend/src/ingest/score-loader.ts`：`buildScoreInputs(current, older, fillsByAddress)`，纯函数，将数据库行结构转换成 `ScoreInput[]` 与审计记录。
- `readScoreSnapshot(reader, runId)`：只读 `ingest_runs / ingest_candidates / ingest_portfolios`。仅接受同步完成且采集完整的批次；验证行数、地址、分类及关联字段。
- `packages/backend/src/ingest/score-cli.ts`：`score:stored`，读取存量数据并调用团队 Score。没有 Hyperliquid 请求、补采成交、数据库写入或定时任务。
- `score-input.ts`：单账户字段转换及已保存成交的最低数量证明。
- `history.ts`：历史窗口基准归一化与跨次去重。

## 字段协议

| Ingest 来源 | ScoreInput | 规则 |
|---|---|---|
| 小写主账户地址 | `address` | 核对 candidate、record 和数据库行一致 |
| 已验证 `kind` | `kind` | 保留三种类型；探测失败不猜成 trader |
| `account_value_or_tvl_usd` / `candidate.accountValueOrTvlUsd` | `accountValue` | 来源资金值/金库 TVL，转换成有限 number；不将 token 原始 `totalAssets` 当美元 |
| 原始 `portfolio` | `month`, `allTime` | 调用 Score 的 `parsePortfolio`；曲线里的权益用于收益计算 |
| 官方开放金库、普通交易员 | `closed: false` | 金库来自本批发现列表；交易员关闭状态不适用 |
| 仅通过 ERC-4626 两项探测的合约 | `closed: null` | 两项探测不能证明开放状态，不能统一伪造 false |
| `leaderAddress` | `links` | 保留 vault ↔ leader 关联，交给当前 Score 的传递关联分组 |
| 以前的 `month` 窗口 | `history` | 转成 allTime 累计 PnL 基准，仅提供当前 month 起点之前的点 |
| 已保存、可核对地址的成交响应 | `tradeCount` | 对评分末点以前的 `(coin, oid)` 去重；证明至少十笔才填下限，证据不足为 null |

资金门槛现在按 Masa 建议使用发现阶段的账户值/TVL；此前本地实验适配器使用 month 最后权益值。
收益曲线计算和 Mirror 的实时权益口径没有因此改变。两个资金读数时间可能不同，不能视作原子快照。

`avgLeverage / timeInMarket / medianHoldHours / makerShare` 没有可靠来源时继续缺省，不制造数值。

## 历史和异常规则

1. `offset = allTime.pnl[last] - month.pnl[last]`；保存 `month.pnl + offset`。
2. 归一化前检查窗口末点时间、权益及重合点是否相符。
3. 跨运行按 `(address, tsMs)` 去重。超过容差的修订保留较新观察用于审计，并输出旧、新 run ID；该地址的 `history` 设为 null，继续使用当前 `month/allTime`。报告的 `historyAudit.excludedAddresses` 与 history issue 明确记录此降级，并阻止完整下游 frame 输出；其他地址不受影响。这也覆盖不在 allTime 时间网格上的修订。
4. 未来完成的批次不加入旧报告；重叠采集批次中，比目标账户获取时间更晚的历史观察也不加入。
5. 当前 month 优先，存量历史只补它之前的点。只有同一天的几个批次不会凭空产生 90 天密集历史。
6. 新采集拒绝重复或倒序时间戳。旧数据库中的非法序列会被审计并交给 Score 判定 unknown/unrankable；不偷偷排序修补。
7. 坏的历史窗口单独记录、跳过；当前输入的地址、批次、计数等结构不一致则整批拒绝。

这套时间检查防止跨批历史观察倒灌；当前排行榜候选集仍含幸存者偏差，且外部补充成交证据可能是事后取得的。
因此这不是严格的历史回测数据集。回测仍需各时点的候选名单及证据版本。

## 使用方法

在 `packages/backend` 运行。`--out` 必须是新的输出目录，防止覆盖原始数据或旧报告。

```bash
# 读取本地完整批次；多个 --local 会同时提供可用的旧历史批次。
bun --no-env-file src/ingest/score-cli.ts \
  --local /home/yanbo/perpParrot/analysis/score-v2-live-2026-10-06/ingest \
  --local /home/yanbo/perpParrot-ingest-score/packages/backend/data/ingest \
  --run-id 2026-10-06T10-39-45-400Z-6381251e \
  --evidence-dir /home/yanbo/perpParrot/analysis/score-v2-live-2026-10-06/evidence \
  --preview --out /tmp/perpparrot-local-handoff

# Supabase 只读模式：运行环境注入 SUPABASE_URL、SUPABASE_SECRET_KEY。
# 不把凭证写入命令或文档。显式选择 run ID，避免数据源悄悄变化。
bun --no-env-file src/ingest/score-cli.ts --supabase \
  --run-id 2026-10-06T06-22-17-136Z-ef9bba4b \
  --preview --out /tmp/perpparrot-supabase-handoff
```

Supabase 有更多旧批次后，可重复添加 `--history-run <完整旧批次ID>`。
目前云端目标批次没有更早的可用批次；本地两轮采集也没有足够早于当前 month 的重合账户数据。

输出：

- `score-inputs.json`：Masa/Score 可直接消费的数组。
- `score-report.json`：批次来源、字段与历史审计、严格评分、可选预览。
- `rankingComplete`：只有输入审计无异常、没有遗漏，并且所有通过其他门槛者的成交数已验证，才为 true。
- `scoreOwnedFrame`：仅在上述条件满足后输出 Score 所拥有的 frame 字段；不是完整 AI 输入，更不是实盘配置。

严格评分始终使用默认 `allowUnknown: []`。`--preview` 另行输出带
`PREVIEW_ONLY_ALLOW_UNKNOWN_MIN_TRADES` 标签的结果；预览不能作为正式下游候选。

旧的本地实验脚本 `scripts/score-ingest.ts` 会主动请求成交接口，不属于本次提交的入口；
本入口只读取已经保存的成交证据。

## 本次真实验证

结果目录：`/home/yanbo/perpParrot/analysis/masa-data-handoff-2026-10-06/`。

| 来源 | 选中 / 成功转换 | 输入异常 / 遗漏 | 成交数未知 | 其中通过其他条件、仍缺成交证明 |
|---|---:|---:|---:|---:|
| Supabase 已存批次 | 200 / 200 | 0 / 0 | 200 | 191 |
| 本地已有批次 + 已存成交证据 | 500 / 500 | 0 / 0 | 432 | 321 |

同一个 200 人批次经本地归档和真实 Supabase 只读路径得到的 `score-inputs.json`
逐字节一致，严格及预览 Score 输出也一致。500 人批次中已有 68 人提供至少十笔成交证明；
严格评分能产生 25 个临时候选，但其余合格账户的成交证据尚不全，不能把它当作完整最终名单。

历史跨批次拼接的归一化、去重、修订和时间边界已通过合成边界测试；真实批次没有形成
足够早于 month 的 history，所以 `withHistory=0`，不声称已用真实 90 天密集历史验证。

本地完整工作目录此前通过 384 个测试，包含尚未随本 PR 提交的账户筛选实验测试。
本 PR 的独立提交快照通过 378 个后端测试、0 失败，类型检查通过，并再次成功加载本地 500 人批次。
测试覆盖真实 SDK 的 GET-only 请求、云端/本地适配一致、重复时间戳、错误分类、未知成交数、
历史窗口冲突及未来观察排除。证据见 `verification.json`、`backend-tests.log`。

## Handoff for Masa

### Review follow-up, 2026-10-06

- Applied option (b) from the off-grid revision review: any cross-run history mismatch for an address excludes
  its stored history. The current month/allTime remain available; the audit retains both run IDs and records
  `excludedAddresses`. A history issue prevents `rankingComplete` and the downstream frame from being emitted.
- `minTrades` means distinct filled `(coin, oid)` orders. Partial executions of the same order count once;
  fewer than ten observed orders remain unknown. This clarifies the existing behavior in Score SPEC and types.
- Excluded internal child vaults from both discovery sources; retained parent and ordinary vaults.
- Validation: **381 backend tests passed, 0 failed**, backend TypeScript check passed. The new synthetic regression
  first reproduced an unflagged drawdown above 59% from an off-grid revision, then verified the guarded loader
  retains zero drawdown and leaves another account's consistent history intact.
- Replayed the saved 500-account batch: all 500 inputs loaded, zero input issues, and input bytes plus strict/preview
  Score results are identical to the previous handoff. These same-day batches still have no older usable history;
  321 otherwise-eligible accounts still lack trade-count evidence. This does not establish a complete ranking.
- Replayed hash-checked discovery archives: seven child vaults were excluded and none remained among candidates.
  No fresh collection, Supabase mutation, automated schedule, deployment, or live trading was performed.

### Original integration handoff

The loader is implemented against main `537e0c1`. `buildScoreInputs()` accepts the same
row shapes as the ingest tables; `readScoreSnapshot()` uses SELECT only and requires a completed run.
The existing Score implementation is unchanged. `accountValue` maps from the candidate USD value/TVL;
PnL and equity curves still come from `parsePortfolio`. Vault-leader links are passed through.
Unknown fills remain null; only the explicitly labeled preview allows unknown `minTrades`.
ERC-4626 closure remains unknown unless independently verified.

Live Supabase verification loaded all 200 rows, with byte-identical Score inputs to the local archive.
The existing local 500-account batch also loads without omissions. Stored history stitching is covered
by boundary tests; these same-day live batches do not yet supply older month-resolution history.
Validation performed no database writes, new collection, scheduling, deployment or teammate messages.
