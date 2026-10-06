import type { ReportEnvelope } from "../../shared/report";
import { verifyEnvelope, type VerifiedReport, type VerifyMode } from "./verify";

export type HandlerDeps = {
  mode: VerifyMode;
  frozenSetHash: string;
  maxAgeSeconds: number;
  now: () => number;
  // Returns false if the report ID was already claimed. In-memory for the spike;
  // Supabase (unique report_id) once the executor is real.
  claim: (id: string) => Promise<boolean>;
  execute: (report: VerifiedReport) => Promise<void>;
};

export type HandlerResult = { status: number; body: Record<string, unknown> };

// Every DON node POSTs its own copy: the first valid one executes, the rest get
// 200 duplicate so the workflow's identical-consensus on `ok` still holds.
export const handleReport = async (payload: unknown, deps: HandlerDeps): Promise<HandlerResult> => {
  let report: VerifiedReport;
  try {
    report = await verifyEnvelope(payload as ReportEnvelope, deps.mode);
  } catch (e) {
    return { status: 401, body: { error: (e as Error).message } };
  }

  const { body } = report;
  if (body.frozenSetHash.toLowerCase() !== deps.frozenSetHash.toLowerCase()) {
    return { status: 422, body: { error: "frozen set mismatch", id: report.id } };
  }
  const age = deps.now() - Number(body.asOf);
  if (age > deps.maxAgeSeconds) {
    return { status: 422, body: { error: `stale report (${age}s old)`, id: report.id } };
  }

  if (!(await deps.claim(report.id))) {
    return { status: 200, body: { status: "duplicate", id: report.id } };
  }
  await deps.execute(report);
  return { status: 200, body: { status: "executed", id: report.id, runId: body.runId } };
};
