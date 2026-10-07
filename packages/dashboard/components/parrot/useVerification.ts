// Read-only funnel and paper polling used by VerifyPanel.
// Fetch backend evidence only; never contact the executor or treat demos as verified.
import { useEffect, useState } from "react";
import type { FunnelArtifact } from "../../../shared/dashboard";
import type { PaperView } from "../../lib/data";
import { backendFetch } from "./api";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function isFunnel(v: unknown): v is FunnelArtifact {
  return record(v) && finite(v.generatedAt) && Array.isArray(v.steps) && v.steps.every(s => record(s) &&
    typeof s.stage === "string" && typeof s.label === "string" && finite(s.count) && Number.isInteger(s.count) && s.count >= 0);
}
function isPaper(v: unknown): v is PaperView {
  return record(v) && (v.lastRunAt === null || finite(v.lastRunAt)) && Array.isArray(v.books) && v.books.every(b => record(b) &&
    typeof b.id === "string" && typeof b.label === "string" && (b.kind === "copy" || b.kind === "btc") &&
    finite(b.startingEquityUsd) && finite(b.equityUsd) && finite(b.returnPct) && finite(b.feesUsd) &&
    (b.fundingUsd === undefined || finite(b.fundingUsd)) && finite(b.trades) && finite(b.openPositions) &&
    Array.isArray(b.curve) && b.curve.every(p => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])));
}

// Same minute refresh / unmount protection as useDashboard. Its executor reads are
// intentionally excluded: this page is restricted to the same-origin BACKEND.
export function useVerification(enabled: boolean) {
  const [data, setData] = useState<{ funnel: FunnelArtifact | null; paper: PaperView | null }>({ funnel: null, paper: null });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    async function get<T>(path: string, guard: (v: unknown) => v is T): Promise<T | null> {
      try {
        const res = await backendFetch(path, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        const value: unknown = res.ok ? await res.json() : null;
        return guard(value) ? value : null;
      } catch { return null; }
    }
    async function tick() {
      const [funnel, paper] = await Promise.all([get("/artifacts/funnel", isFunnel), get("/paper", isPaper)]);
      if (!controller.signal.aborted) setData({ funnel, paper });
    }
    void tick();
    const timer = setInterval(() => void tick(), 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [enabled]);
  return enabled ? data : { funnel: null, paper: null };
}
