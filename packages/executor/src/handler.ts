import type { ReportEnvelope } from "../../shared/report";
import { verifyEnvelope, type VerifiedReport, type VerifyMode } from "./verify";

export type HandlerDeps = {
  mode: VerifyMode;
  frozenManifestHash: string;
  account: string;
  // Unix seconds.
  now: () => number;
  // How far asOf may be ahead of our clock (DON clock skew; the simulator stamps the next :x0).
  maxLeadSeconds: number;
  claim: (id: string) => Promise<boolean>;
  // Starts execution without waiting for it: DON nodes time out after 10 s.
  accept: (report: VerifiedReport, envelope: ReportEnvelope) => void;
};

export type HandlerResult = { status: number; body: Record<string, unknown> };

// Every DON node POSTs its own copy: the first valid one is accepted, the rest get
// 200 duplicate so the workflow's identical consensus on the status code holds.
export const handleReport = async (payload: unknown, deps: HandlerDeps): Promise<HandlerResult> => {
  let report: VerifiedReport;
  try {
    report = await verifyEnvelope(payload as ReportEnvelope, deps.mode);
  } catch (e) {
    return { status: 401, body: { error: (e as Error).message } };
  }

  const { body, id } = report;
  const reject = (error: string) => ({ status: 422, body: { error, id } });
  if (body.manifestHash.toLowerCase() !== deps.frozenManifestHash.toLowerCase()) return reject("manifest mismatch");
  if (body.account.toLowerCase() !== deps.account.toLowerCase()) return reject("account mismatch");
  const now = deps.now();
  if (now > Number(body.expiresAt)) return reject(`expired report (${now - Number(body.expiresAt)}s past expiry)`);
  if (Number(body.asOf) > now + deps.maxLeadSeconds) return reject("report from the future");

  if (!(await deps.claim(id))) return { status: 200, body: { status: "duplicate", id } };
  deps.accept(report, payload as ReportEnvelope);
  return { status: 200, body: { status: "accepted", id, runId: body.runId } };
};
