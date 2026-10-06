import { parsePortfolio } from "../../score";
import { classify } from "../classify";
import { SOURCES } from "../client";
import { normalizedMonth, mergeHistory, historyBefore, type HistoryRow } from "../history";
import { orderEvidence } from "../score-input";
import { BudgetClient } from "./client";
import { LoopStore, type Account } from "./store";

export type Collected = { account: Account; historyWarnings: string[] };

export class OfficialCollector {
  constructor(private store: LoopStore, readonly client = new BudgetClient(store)) {}
  async collect(previous: Account, signal: AbortSignal): Promise<Collected> {
    const a: Account = structuredClone(previous);
    const raw = await this.client.request(SOURCES.info, { type: "portfolio", user: a.input.address }, signal);
    const fetched = Date.now();
    a.fetchedAt = new Date(fetched).toISOString(); a.rawHash = this.store.blob(raw);
    const parsed = JSON.parse(raw), windows = parsePortfolio(parsed);
    const rows = normalizedMonth(a.input.address, parsed, a.fetchedAt, "current");
    if (rows.some(p => p.accountValue < 0 || p.tsMs > fetched + 5000)
      || fetched - rows.at(-1)!.tsMs > 120_000) throw new Error("Stale/future/negative portfolio history");
    const historyWarnings: string[] = [];
    const old: HistoryRow[] = normalizedMonth(a.input.address, JSON.parse(this.store.raw(previous.rawHash)), previous.fetchedAt, "previous");
    for (const [index, p] of (previous.input.history?.accountValueHistory ?? []).entries()) {
      old.push({ address: a.input.address, tsMs: p[0], accountValue: p[1],
        pnlAllTime: previous.input.history!.pnlHistory[index][1], fetchedAt: previous.fetchedAt, runId: "stored" });
    }
    const merged = mergeHistory([...old, ...rows]);
    const history = merged.mismatches.length ? null : historyBefore(merged.rows, a.input.address, rows[0].tsMs);
    if (merged.mismatches.length) historyWarnings.push("Conflicting older history quarantined");
    Object.assign(a.input, windows, { history });
    // For direct account refresh, use current portfolio equity. Known vaults use
    // the official vault list's TVL and closure state, not a guessed portfolio TVL.
    a.input.accountValue = rows.at(-1)!.accountValue;
    if (a.candidate.knownHypercoreVault) {
      let source = this.store.state<{ at: number; hash: string }>("vaults");
      if (!source || fetched - source.at > 600_000) {
        const vaultsRaw = await this.client.request(SOURCES.vaults, undefined, signal);
        const list = JSON.parse(vaultsRaw);
        if (!Array.isArray(list)) throw new Error("Invalid vault list");
        source = { at: fetched, hash: this.store.blob(vaultsRaw) }; this.store.setState("vaults", source);
      }
      const list = JSON.parse(this.store.raw(source.hash));
      const vault = list.find((v: { summary?: { vaultAddress?: string } }) => v.summary?.vaultAddress?.toLowerCase() === a.input.address)?.summary;
      if (!vault || typeof vault.isClosed !== "boolean" || typeof vault.tvl !== "string"
        || !/^\d+(\.\d+)?$/.test(vault.tvl) || !Number.isFinite(Number(vault.tvl))) throw new Error("Selected vault missing valid current TVL/closure evidence");
      a.input.accountValue = Number(vault.tvl); a.input.closed = vault.isClosed;
      a.input.links = typeof vault.leader === "string" ? [vault.leader.toLowerCase()] : a.input.links;
      a.classification = { kind: "hypercore-vault", evidence: "vault-list" }; a.classificationAt = a.fetchedAt;
    } else if (!a.classificationAt || fetched - Date.parse(a.classificationAt) >= 86_400_000) {
      const chain = await this.client.rpc("eth_chainId", [], signal);
      if (BigInt(chain) !== 999n) throw new Error("Wrong HyperEVM chain");
      const block = await this.client.rpc("eth_blockNumber", [], signal);
      const rpc = { rpc: (method: "eth_blockNumber" | "eth_chainId" | "eth_getCode" | "eth_call", params: unknown[]) => this.client.rpc(method, params, signal) };
      a.classification = await classify(a.candidate, rpc, block); a.classificationAt = a.fetchedAt;
      a.input.kind = a.classification.kind; a.input.closed = a.classification.kind === "erc4626-vault" ? null : false;
    }
    if (!a.classification) throw new Error("Unverified classification");
    a.input.kind = a.classification.kind;
    // Ten observed filled orders are a durable lower bound. Reuse their raw
    // proof, checking its timestamps against this new history endpoint.
    const end = rows.at(-1)!.tsMs;
    let fills = a.fillsHash ? JSON.parse(this.store.raw(a.fillsHash)) : null;
    let evidence = orderEvidence(fills, end);
    if (evidence.tradeCount === null) {
      const fillRaw = await this.client.request(SOURCES.info,
        { type: "userFillsByTime", user: a.input.address, startTime: Math.max(0, end - 90 * 86_400_000), endTime: end, aggregateByTime: true },
        signal, 120, payload => Array.isArray(payload) && payload.length <= 2000 ? 20 + Math.ceil(payload.length / 20) : 121);
      fills = JSON.parse(fillRaw); a.fillsHash = this.store.blob(fillRaw); a.fillsCheckedAt = new Date().toISOString();
      evidence = orderEvidence(fills, end);
    }
    a.input.tradeCount = evidence.tradeCount;
    a.basis = "verified-input";
    return { account: a, historyWarnings };
  }
}
