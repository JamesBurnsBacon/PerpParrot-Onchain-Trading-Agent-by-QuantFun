import type { TimePoint, WindowHistory } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseHistory = (raw: unknown): TimePoint[] => {
  if (!Array.isArray(raw)) throw new Error("portfolio: history must be an array");
  return raw.map((point: unknown): TimePoint => {
    if (!Array.isArray(point) || point.length !== 2) throw new Error("portfolio: invalid history point");
    const [timestamp, value] = point as unknown[];
    if (typeof timestamp !== "number" || !Number.isInteger(timestamp)) {
      throw new Error("portfolio: timestamp must be an integer");
    }
    if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
      throw new Error("portfolio: value must be a decimal string");
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("portfolio: value must be finite");
    return [timestamp, numeric];
  });
};

// Parse only the scoring windows; ordering and alignment are validated separately (README §4.2).
export const parsePortfolio = (raw: unknown): { month: WindowHistory | null; allTime: WindowHistory | null } => {
  if (!Array.isArray(raw)) throw new Error("portfolio: response must be an array");
  const result: { month: WindowHistory | null; allTime: WindowHistory | null } = { month: null, allTime: null };
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("portfolio: invalid window entry");
    const [name, history] = entry as unknown[];
    if (typeof name !== "string" || !isRecord(history)) throw new Error("portfolio: invalid window entry");
    // A repeated window is a malformed response, whichever window it is (SPEC "parsePortfolio").
    if (seen.has(name)) throw new Error(`portfolio: duplicate window ${name}`);
    seen.add(name);
    if (name !== "month" && name !== "allTime") continue;
    result[name] = {
      accountValueHistory: parseHistory(history.accountValueHistory),
      pnlHistory: parseHistory(history.pnlHistory),
    };
  }
  return result;
};
