// weight is selection allocation %. btc/eth are signed, already-weighted portfolio contributions (% equity).
export type Source = {
  id: string;
  name: string;
  market: string;
  risk: "Low" | "Medium" | "High";
  weight: number;
  return30d: number;
  drawdown: number;
  btc: number;
  eth: number;
  description: string;
};
export type EndpointResult =
  | { status: "available"; data: unknown }
  | { status: "unavailable"; error: string };
export type DashboardSnapshot = {
  mode: "demo" | "live";
  loadedAt: string;
  sources: Source[];
  evidence: Record<string, EndpointResult>;
};
