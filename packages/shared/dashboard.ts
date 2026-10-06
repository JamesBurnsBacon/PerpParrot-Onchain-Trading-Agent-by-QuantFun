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
