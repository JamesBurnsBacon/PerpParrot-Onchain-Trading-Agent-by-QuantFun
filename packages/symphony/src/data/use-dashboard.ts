import { useQuery } from "@tanstack/react-query";
import { loadDashboard } from "./adapter";
import type { AdapterOptions } from "./adapter";

export type DashboardConfig = Pick<
  AdapterOptions,
  "mode" | "backendUrl" | "executorUrl"
>;

export function useDashboard(config: DashboardConfig) {
  return useQuery({
    queryKey: [
      "dashboard",
      config.mode,
      config.backendUrl?.trim() || "/api/backend",
      config.executorUrl?.trim() || "/api/executor",
    ],
    queryFn: ({ signal }) => loadDashboard({ ...config, signal }),
    enabled: config.mode === "demo" || config.mode === "live",
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
}
