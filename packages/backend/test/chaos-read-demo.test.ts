import { describe, expect, test } from "bun:test";

type Out = { results: { arm: string; ok: number; failed: number; failovers: number; nownodesRequests: number }[] };

const demo = async (...args: string[]): Promise<Out> => {
  const proc = Bun.spawn(["bun", "run", new URL("../scripts/chaos-read-demo.ts", import.meta.url).pathname, "--json", ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  return JSON.parse(text) as Out;
};

describe("chaos read demo", () => {
  test("the injected outage fails reads without NOWNodes and none with it", async () => {
    const { results } = await demo("--reads", "120", "--outage", "30:90");
    const [official, overflow] = results;
    expect(official!.failed).toBeGreaterThan(0); // the injection bites (positive control)
    expect(official!.nownodesRequests).toBe(0);
    expect(overflow!.failed).toBe(0);
    expect(overflow!.failovers).toBeGreaterThan(0);
  });

  test("with no outage in range both runs read everything and never fail over", async () => {
    const { results } = await demo("--reads", "40", "--outage", "1000:1100");
    for (const r of results) {
      expect(r.failed).toBe(0);
      expect(r.failovers).toBe(0);
    }
  });
});
