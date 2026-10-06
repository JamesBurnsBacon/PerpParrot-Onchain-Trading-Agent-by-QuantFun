import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, hexToBytes, parseAbiParameters } from "viem";
import { REPORT_BODY_ABI } from "../../shared/report";
import { buildMirrorReport, initWorkflow, type Config } from "./main";
import { encodeReportBody, toEnvelope } from "./report";

const config: Config = {
  schedule: "0 */10 * * * *",
  executorUrl: "http://localhost:8787/reports",
  frozenSetHash: `0x${"01".padStart(64, "0")}`,
};

describe("encodeReportBody", () => {
  test("round-trips through the shared ABI", () => {
    const report = buildMirrorReport(config, 1_791_264_000n);
    const [runId, , asOf, frozenSetHash, equityE6, targets] = decodeAbiParameters(
      parseAbiParameters(REPORT_BODY_ABI),
      encodeReportBody(report),
    );
    expect(runId).toBe("mirror-1791264000");
    expect(asOf).toBe(1_791_264_000n);
    expect(frozenSetHash).toBe(config.frozenSetHash);
    expect(equityE6).toBe(470_000_000n);
    expect(targets).toEqual(report.targets);
  });
});

describe("toEnvelope", () => {
  test("hex-encodes without 0x", () => {
    const env = toEnvelope({
      rawReport: hexToBytes("0x0102"),
      reportContext: hexToBytes("0x03"),
      sigs: [{ signature: hexToBytes("0xff") }],
    });
    expect(env).toEqual({ report: "0102", context: "03", signatures: ["ff"] });
  });
});

describe("initWorkflow", () => {
  test("registers one cron handler with the configured schedule", () => {
    const handlers = initWorkflow(config);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].trigger.config.schedule).toBe("0 */10 * * * *");
  });
});
