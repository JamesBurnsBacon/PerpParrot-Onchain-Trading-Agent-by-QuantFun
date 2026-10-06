# Backend: 4.1 Ingest / 只读数据采集

本目录在现有 positions snapshot 后端旁边增加独立的 `ingest` 命令。
范围是项目设计 §4.1：地址发现、$10k 预筛、类型标记、`portfolio` 历史和持久化快照。
采集命令本身不执行评分。已有数据可通过 `bun run score:stored --help` 接入团队 §4.2 Score；
支持本地归档或 Supabase 只读模式，不重新采集。字段协议、命令及验证见
[Score 数据对接说明](../../docs/ingest/SCORE_HANDOFF_CN.md)。

已使用 **Bun 1.4.2** 验证；不需要钱包私钥、API 钱包或 Hyperliquid API Key。
使用的是公开排行榜/金库列表里的真实主账户地址。下游不要用交易授权钱包地址替换这些地址。

## 运行

在 `packages/backend` 目录执行：

```bash
bun install --frozen-lockfile
bun run ingest --limit 200
```

成功标记为 `INGEST_OK`，结果保存在当前目录的 `data/ingest/`。
首次会下载约 40 MB 排行榜和 14 MB 金库列表；读取 200 个地址历史还需要数分钟。
可先用 `bun run ingest --limit 5` 做小范围验证。

```bash
# 更换保存位置；来源文件默认缓存 3 小时，portfolio 每次重新请求。
bun run ingest --limit 200 --out ./data/ingest --cache-hours 3

# 强制重新下载排行榜和金库列表；历史快照不会因此删除。
bun run ingest --limit 200 --refresh

bun test
bun run typecheck
```

`--limit` 范围为 1–500。每次命令执行一次采集，**缓存 TTL 不等于定时运行**。
再次执行会创建新快照。后台定时调度可随后调用同一个命令；这里没有启动常驻进程。

## 采集规则

1. 下载完整 `leaderboard` 和 `vaults` 原始 JSON，保存采集时间、URL、字节数和 SHA-256。
   这两个 stats-data 地址是当前项目采用的公开但未正式文档化的数据源；结构变化会明确失败。
2. 合并并按小写地址去重。已知 HyperCore 金库以 `summary.tvl` 为资金值，并排除关闭金库；
   其他地址用排行榜 `accountValue`。保留 **≥ $10,000** 的地址，金额比较不经过浮点数。
3. 默认按资金值从高到低、地址从小到大取前 200 个。**这只是采集优先级，不是表现评分。**
   完整预筛名单保存在 `candidates.json`，实际采集范围保存在 `shortlist.json`。
4. 仅对 shortlist 做类型标记：金库列表命中 → `hypercore-vault`；否则在同一个 HyperEVM
   区块读取 `eth_getCode`，且 `asset()`、`totalAssets()` 均成功解码 → `erc4626-vault`；
   没有代码或合约探测明确不匹配 → `trader`。此规则是项目要求的启发式识别，不能证明完整 ERC-4626 合规。
   网络失败不是“普通交易员”，而是 `classification: null` 和明确错误。
5. 对 shortlist 每个地址发送 `POST /info {type: "portfolio", user: address}`。
   保存完整原始窗口，包括不规则时间戳、PnL 和账户价值字符串；另写窗口点数、首尾时间等索引。
   历史不足 25 点不会在 Ingest 阶段被悄悄删除；那属于后续 Score 的过滤规则。

Info API 请求串行且起始间隔至少 1.5 秒；RPC 单独限速。超时、响应大小、429/5xx 重试均有上限。
不把服务错误、下载残缺或无法解析的数据当成成功。单个地址失败时继续保存其他结果，最终返回
`INGEST_PARTIAL` 和退出码 1。成功运行的 `latest.json` 不会被失败或部分成功结果覆盖。

## 输出契约

所有 manifest 和 record 内的路径都相对于 `--out`：

```text
data/ingest/
  blobs/<sha256>.json            # 不变的排行榜/金库原始响应，旧版本始终保留
  cache/leaderboard.json         # 可更新的缓存索引
  cache/vaults.json
  latest.json                   # 最近一次完整成功的 runId / manifest 路径
  runs/<UTC时间-唯一ID>/
    manifest.json               # 运行状态、统计、来源时间、缓存命中、RPC 区块
    candidates.json             # 全部通过 $10k 预筛的唯一地址
    shortlist.json              # 本轮采集的前 N 个地址
    records.json                # 类型识别结果和 portfolio 文件索引
    records/<address>.json      # 每完成一个地址立即保存，便于排查中断
    portfolios/<address>.json   # 完整 portfolio 原始响应
```

`manifest.status` 为 `running / complete / partial / failed`。进程被强制中断时会留下
`running` 和已保存的单地址记录，而不会误报完成。缓存命中记录仍保留原始下载时间，不伪装成新数据。
数据源下载、各地址历史查询和 HyperEVM 区块分别记录时间，不能视作交易所同一瞬间的原子快照。

`accountValueOrTvlUsd`、PnL 和历史资产值保持原始十进制字符串；ERC-4626 的 `totalAssets`
是 token 原始单位的整数字符串，**不是美元 TVL**。该值只作类型识别证据。
不要把这些值直接传给已有 `weightE6` 或 `notionalE6` 字段。

本模块默认本地持久化，并已接入 **PerpParrot Supabase**（项目编号 `clheeepphmomkymawsfq`）。
使用 `--supabase` 时，采集后将快照同步到四张 Ingest 表和一个私有 Storage bucket；
也可以独立同步已保存的历史 run。目录已加入 `.gitignore`，原始大数据文件和 `.env` 不会跟随代码提交。

## Supabase 接入

本地 `packages/backend/.env` 已配置项目 URL 和服务器专用 Secret key；不要将真实密钥放进
`.env.example`、前端代码、CRE 配置或 GitHub。所有表启用 RLS，并撤销 `anon` / `authenticated`
的表权限，后端使用 `service_role` 对应的 Secret key。[官方 API keys 说明](https://supabase.com/docs/guides/getting-started/api-keys)

```bash
# 新采集 + 上传 + 从 Supabase 读回核对
bun run ingest --limit 200 --supabase

# 只导入已有本地快照，不重新访问 Hyperliquid
bun run ingest:sync

# 指定历史运行；失败后可重试，按 run_id + address 去重
bun run ingest:sync --run-id 2026-10-06T06-22-17-136Z-ef9bba4b

# 本地校验、压缩和预览，不请求 Supabase
bun run ingest:sync --dry-run
```

| 远端对象 | 内容 |
| --- | --- |
| `public.ingest_runs` | 原 manifest、导入状态、预期数量、原始归档路径 |
| `public.ingest_candidates` | 全部 ≥ $10k 候选者、是否 shortlist、已知类型和原 candidate |
| `public.ingest_portfolios` | shortlist 的分类证据、错误状态和原始 portfolio JSON |
| `public.ingest_sources` | 本轮两份源文件的 URL、采集时间、缓存状态、哈希和 Storage 路径 |
| 私有 bucket `perpparrot-ingest` | 两份源文件 gzip，以及本轮完整文件归档 gzip；没有公开下载链接 |

归档格式是 `perpparrot-ingest-archive.v1`，`files` 将原始相对路径映射到未经重新序列化的文件文本。
源文件按 SHA-256 去重；本轮归档路径也包含内容哈希。同一个 run ID 的内容改变会拒绝覆盖。
导入时不更新已存在的数据行，失败保留 `sync_status=uploading`，重新运行可继续。
全部表内容读回比对、Storage 文件下载校验哈希后，才标记 `sync_status=complete`。
下游读取时必须同时检查 `sync_status` 和 `manifest.status`：导入成功不等于原始采集全部成功。

候选表的美元金额保持十进制字符串，避免 JavaScript 浮点精度损失；SQL 计算时可转换为 `numeric`。
未进入 shortlist 的非 HyperCore 地址 `kind` 为 null，表示未检测，不能当成已确认的 Trader。

建表脚本在根目录 `supabase/migrations/20261006070000_ingest.sql`。
本次已通过 Supabase SQL Editor 应用到指定项目；**未通过 GitHub 自动部署**。
后续接通 GitHub 时需要核对现有数据库与迁移记录，再启用迁移流程。

2026-10-06 实际导入并读回验证：**20,909 条候选记录、200 条历史记录、2 条来源记录、3 个私有归档文件**。
本地证据为 `data/supabase-sync.stdout.json`，成功标记 `SUPABASE_SYNC_OK`。
这仅保存 Ingest 数据；队友的 executor、mirror、AI 日志持久化仍需分别对接。

## 与其他模块的边界

- 现有 `bun run dev` 仍服务 mirror 使用的 `/snapshots/{runAt}` 持仓快照。
  本模块的历史采集快照是另一种数据，不能直接替换那个接口响应。
- 后续 Score 读取本模块的候选者和原始历史，计算指标；这里不虚构收益、持仓时长或回测结果。
- `ai-agent-workflow` 分支的 CandidateCurationFrame 需要 OOS、相关性、执行覆盖等额外证据。
  当前输出不声称已满足该契约，缺失字段不能用 0 或示例值补齐。
- 当前排行榜存在幸存者偏差；从现在起保存的快照可用于向前积累证据，不能还原过去的完整候选集。

## 已验证的本地运行

2026-10-06 的运行 `2026-10-06T06-22-17-136Z-ef9bba4b` 返回 `INGEST_OK`：

| 检查项 | 结果 |
| --- | ---: |
| 排行榜地址 | 47,444 |
| 开放 HyperCore 金库 | 3,091 |
| 合并、去重并通过 $10k 门槛 | 20,909 |
| shortlist / portfolio 成功 | 200 / 200 |
| Trader / HyperCore vault | 197 / 3 |
| 失败地址 | 0 |

这次完整采集使用了同日公开下载的两份源文件缓存；200 个 portfolio 和 HyperEVM 查询是实际网络请求。
两份源文件和 200 份历史文件的 SHA-256 均已复核，单地址记录与汇总记录一致。
该 shortlist 没有命中 ERC-4626；双方法成功、回滚及网络失败的分类分支通过了模拟响应测试，
不把这些测试称为真实 ERC-4626 金库验证。与最新 `main` 合并后，后端 `bun test` 共 326 项通过，
`bun run typecheck` 通过；Postgres 集成测试还需设置 `TEST_DATABASE_URL`。
运行数据保留在本机 `data/ingest/runs/<runId>/`，不包含在 Git 代码提交内。

另一次从空缓存启动的运行 `2026-10-06T06-28-49-303Z-9b057ff0` 也返回 `INGEST_OK`：
命令为 `bun run ingest --limit 5 --out ./data/ingest-download-smoke`，两个源文件均由本模块实际下载
（`cacheHit: false`），5 个历史全部成功。该轮预筛数量为 20,888，说明公开名单会变化；
下游应始终读取对应 run 的 manifest，不使用本文实测数量作为固定常量。

## 来源

- [Hyperliquid Info API：账户地址与 portfolio](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [Hyperliquid API 限流](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)
- [ERC-4626 asset / totalAssets 定义](https://eips.ethereum.org/EIPS/eip-4626)
- 当前项目 README §4.1；公开文件 URL 在 `src/ingest/client.ts` 中集中定义。
