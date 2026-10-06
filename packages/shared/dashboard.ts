// Dashboard artifacts (README §4.11): results other modules publish for the dashboard.
// Stored in Supabase `dashboard_artifacts` (name → body) and served by the backend at
// GET /artifacts/:name. Writers: the backtest and score/ingest jobs (service role).

// name "backtest": out-of-sample equity curves vs holding BTC (README §4.9).
export type BacktestArtifact = {
  generatedAt: number; // unix ms
  window: string; // e.g. "1 month"
  // Indexed series: value 1.0 = start of the out-of-sample window.
  series: { id: string; label: string; points: [t: number, value: number][] }[];
};

// name "funnel": address universe → filters → finalists → frozen set (README §4.2, §4.6).
export type FunnelArtifact = {
  generatedAt: number;
  steps: { stage: string; label: string; count: number }[];
  finalists?: { address: string; kind: string; score: number; picked: boolean; rationale?: string }[];
};

export type DashboardArtifacts = { backtest: BacktestArtifact; funnel: FunnelArtifact };

// Shape checks before publishing (scripts/publish-artifact.ts): a malformed artifact would
// render wrong, not fail, so refuse it here. Returns the problems found (empty = ok).
const MS_2020 = Date.UTC(2020, 0, 1);
const isMs = (t: unknown) => typeof t === "number" && Number.isFinite(t) && t > MS_2020 && t < Date.now() + 86_400e3;

export const checkBacktestArtifact = (a: BacktestArtifact): string[] => {
  const problems: string[] = [];
  if (!isMs(a?.generatedAt)) problems.push("generatedAt must be unix milliseconds");
  if (typeof a?.window !== "string" || !a.window) problems.push("window must be a label such as \"1 month\"");
  if (!Array.isArray(a?.series) || a.series.length === 0) return [...problems, "series must be a non-empty array"];
  if (!a.series.some((s) => s.id === "btc")) problems.push('one series must have id "btc" (the benchmark)');
  const ids = new Set<string>();
  for (const s of a.series) {
    const name = `series ${JSON.stringify(s?.id)}`;
    if (typeof s?.id !== "string" || !s.id || ids.has(s.id)) problems.push(`${name}: id must be unique and non-empty`);
    ids.add(s?.id);
    if (typeof s?.label !== "string" || !s.label) problems.push(`${name}: label is required`);
    if (!Array.isArray(s?.points) || s.points.length < 2) {
      problems.push(`${name}: needs at least 2 points`);
      continue;
    }
    let last = -Infinity;
    for (const p of s.points) {
      if (!Array.isArray(p) || p.length !== 2 || !isMs(p[0]) || !(typeof p[1] === "number" && p[1] > 0 && Number.isFinite(p[1]))) {
        problems.push(`${name}: points must be [unix ms, value > 0] (got ${JSON.stringify(p)})`);
        break;
      }
      if (p[0] <= last) {
        problems.push(`${name}: points must be in increasing time order`);
        break;
      }
      last = p[0];
    }
    if (Math.abs(s.points[0]?.[1] - 1) > 1e-9) problems.push(`${name}: must be indexed to 1.0 at the first point (got ${s.points[0]?.[1]})`);
  }
  return problems;
};

export const checkFunnelArtifact = (a: FunnelArtifact): string[] => {
  const problems: string[] = [];
  if (!isMs(a?.generatedAt)) problems.push("generatedAt must be unix milliseconds");
  if (!Array.isArray(a?.steps) || a.steps.length === 0) return [...problems, "steps must be a non-empty array"];
  let prev = Infinity;
  for (const s of a.steps) {
    if (typeof s?.stage !== "string" || typeof s?.label !== "string" || !Number.isInteger(s?.count) || s.count < 0) {
      problems.push(`step ${JSON.stringify(s?.stage)}: needs stage, label and a whole count ≥ 0`);
      continue;
    }
    if (s.count > prev) problems.push(`step ${s.stage}: count ${s.count} is larger than the step before (${prev})`);
    prev = s.count;
  }
  if (a.finalists !== undefined) {
    if (!Array.isArray(a.finalists)) return [...problems, "finalists must be an array"];
    const seen = new Set<string>();
    for (const f of a.finalists) {
      const name = `finalist ${JSON.stringify(f?.address)}`;
      if (typeof f?.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(f.address)) problems.push(`${name}: address must be 0x + 40 hex`);
      else if (seen.has(f.address.toLowerCase())) problems.push(`${name}: listed twice`);
      else seen.add(f.address.toLowerCase());
      if (typeof f?.kind !== "string") problems.push(`${name}: kind is required`);
      if (typeof f?.score !== "number" || !Number.isFinite(f.score)) problems.push(`${name}: score must be a number`);
      if (typeof f?.picked !== "boolean") problems.push(`${name}: picked must be true or false`);
      if (f?.rationale !== undefined && typeof f.rationale !== "string") problems.push(`${name}: rationale must be text`);
    }
  }
  return problems;
};
