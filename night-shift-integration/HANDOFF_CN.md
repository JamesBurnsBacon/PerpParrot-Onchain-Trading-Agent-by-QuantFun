# 夜间集成交接

目标是让队友模块完整连接、复现和恢复。算法保持简单；实际数据不满足条件时，保留真实的拒绝结果。

最新结果见 `FOLLOWUP_REPORT.md`，数据含义与复现方式见 `MEASURED_PIPELINE.md`，队友版本对齐见 `TEAM_SYNC.md`。本次不等待 24 小时，但也不把短时验证当作长期托管稳定性证明。

## 从这里开始

1. 看 `FOLLOWUP_REPORT.md`：最终真实数据、模型调用、运行结果和剩余工作；此前完整演示见 `DELIVERY_REPORT.md`。
2. 按 `README.md` 安装依赖，运行 `bun --no-env-file night-shift-integration/demo.ts`，打开 `out/demo/demo.html`。
3. 查看受控的 Score → Review → 冻结 → targets → 执行器 dry-run → SQL → 展示。再次运行检查复用，按 README 注入故障并恢复。
4. 从[交付 Release](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/releases/tag/night-integration-2026-10-07)下载真实测量数据及独立 `review-input`；按 `MEASURED_PIPELINE.md` 校验 SHA-256、复现 Score 和离线验证模型审计。
5. 修改算法前先看 `INTERFACES.md`，保持接口、单位、冻结策略与证据哈希约定。

## 证据分别证明什么

- **实际周期采集**：截至约 04:17 +08，原 worker 观察了约 4.72 小时，28 次尝试中 27 次完成、1 次失败，另有 2 个缺失调度窗口。27 次发布均有 100 个唯一账户且哈希有效；完成轮次耗时最短/中位/最长为 137.203/138.655/632.651 秒，末尾连续 12 个窗口及时完成。它仍运行旧版本，尚未切换新轮巡代码。
- **真实历史回放**：10,934 个归档输入、四个窗口、两个简单规则及 BTC 基准，证明回测数据与展示接口可连接；存在回溯选样偏差。
- **最终真实测量**：25 个账户、76 组读取（73 组全 DEX、3 组历史不完整读取）、96 页成交、936 个原始文件、984 条归档请求/响应绑定。两种简单规则均被 Review 拒绝；9 个持仓周期不足一小时、16 个未知、23 个 execution-fit 不达标，原因可以重叠。没有冻结账户。
- **真实模型调用**：[运行 37524055099](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/actions/runs/37524055099)成功执行两个固定版本模型（`gpt-4.1-mini-2025-04-14`、`gpt-4.1-2025-04-14`）的 Role/Risk，共 4 次 HTTP 200、零重试。两者均为 `INVALID_BUCKET / INSUFFICIENT_EVIDENCE`；未运行 Red-Team、冻结或执行器。离线验证通过 4 条审计，并拒绝 5 种篡改；HTTP 状态仍是运行器记录，不是提供商签名。
- **受控完整闭环**：模拟账户和确定性模型适配器进入队友真实模块，实际运行 SQL、HTTP、去重、恢复与 dry-run。它证明模块集成成功，不代表上述真实账户已获准执行，也没有发送交易。

代码版本 `4b75b59` 的 verification、backend、executor、dashboard、offline-proof 五项 CI 均通过；最终加速恢复演练 20 项检查通过，耗时 6.011 秒。受控闭环的离线验证检查了 54 个文件。

## 明早如何继续

- James：确认 PR #32 服务接口、迁移和部署路径，评审后安排部署。04:18 +08 检查时 PR #32/#30/#31 仍开放且无新增人工评论。
- Masa：保留 Score 接口。数据 ZIP 内的 `score-inputs.jsonl` 包含 25 个可复现输入，使用生产 `scoreCandidates()` 重现 `score-result.json`；研究候选的 `picked` 仍不等于已冻结。
- Review：两个真实模型已经运行。下一步根据实际拒绝原因寻找更适合复制的永续账户、补齐可核实的持仓/执行证据，再运行相同门槛。不要将现货表现或推测持仓时间填成已知事实，也不能据本次两模型拒绝结果判定哪个模型更优。
- 执行与部署：先在目标托管环境验证认证健康检查、重复 dry-run、持久化、告警和重启恢复。当前预览健康请求仍跳转登录；构建成功不等于部署验证通过。当前没有变更钱包、生产冻结配置或 Supabase。

## 保留的原有工作

开始记录：2026-10-07 02:26:44 +08:00；备份快照：02:27:27 +08:00。
本机 `analysis/backups/20261007T022727+0800` 保存原有五个工作目录的代码状态、Git bundle、diff、夜间运行证据和校验清单。备份不提交 GitHub。
原始 `perpparrot-ingest-loop.service` 仍使用原工作目录。新接口工作位于独立 Git worktree，未覆盖它。活跃数据库另于 02:44:24 +08 通过 SQLite online backup 完成约 2.12 GB 的一致性备份，quick_check 通过，包含 10,987 个账户、19 轮运行、22,883 个 blob。新验证通过只读事务导入独立数据库。
