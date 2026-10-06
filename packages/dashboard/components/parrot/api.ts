import { BACKEND } from "../../lib/data";
import { isApiError, type ApiError } from "../../lib/parrot";

export type Failure = { code: ApiError["code"] | "network"; retryAfterSec?: number };
export const canDemo = (failure: Failure | null) => failure !== null && ["disabled", "model_unavailable", "network"].includes(failure.code);

// Reject an off-origin environment override before making any request, and omit cookies.
export async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`${BACKEND.replace(/\/$/, "")}${path}`, window.location.origin);
  if (url.origin !== window.location.origin || url.username || url.password) throw new Error("Same-origin backend required");
  return fetch(url, { ...init, credentials: "omit", cache: "no-store", redirect: "error" });
}

export async function post<T>(path: string, body: unknown, guard: (value: unknown) => value is T, signal: AbortSignal): Promise<{ data: T } | { error: Failure }> {
  try {
    const response = await backendFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    let value: unknown;
    try { value = await response.json(); } catch { return { error: { code: response.ok ? "invalid_model_output" : "network" } }; }
    if (isApiError(value)) return { error: { code: value.code, retryAfterSec: value.retryAfterSec } };
    if (response.ok && guard(value)) return { data: value };
    return { error: { code: response.ok ? "invalid_model_output" : "network" } };
  } catch {
    return { error: { code: "network" } };
  }
}
