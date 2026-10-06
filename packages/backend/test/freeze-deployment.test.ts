import { expect, test } from "bun:test";
import fixture from "../fixtures/frozen-configuration.json";
import type { FrozenConfiguration } from "../../shared/frozen";
import { prepareFreezeDeployment, writeFreezeDeployment } from "../src/freeze-deployment";

const configuration = fixture as FrozenConfiguration;
const mirror = {
  schedule: "0 */10 * * * *",
  backendUrl: "https://snapshot.example.com",
  executorUrl: "https://executor.example.com/reports",
  frozenConfigurationHash: `0x${"0".repeat(64)}`,
  spotCheckCount: 4,
  maxDeviationBps: 500,
  maxSnapshotAgeSeconds: 120,
  reportTtlSeconds: 300,
};
const prepare = (config: unknown = mirror, account = configuration.account) =>
  prepareFreezeDeployment(configuration, account, config, configuration.frozenAtMs);

test("freeze preparation synchronizes commitments, account and executor limits", () => {
  const plan = prepare();
  expect(JSON.parse(plan.liveJson).configurationHash).toBe(plan.environment.FROZEN_CONFIGURATION_HASH);
  expect(JSON.parse(plan.mirrorJson).frozenConfigurationHash).toBe(plan.environment.FROZEN_CONFIGURATION_HASH);
  expect(plan.environment.HL_ACCOUNT).toBe(configuration.account);
  expect(plan.environment.MAX_REPORT_TTL_SECONDS).toBe(String(mirror.reportTtlSeconds));
  expect(plan.environment.MAX_GROSS_LEVERAGE).toBe(String(configuration.policy.maxGrossLeverage));
  expect(mirror.frozenConfigurationHash).toBe(`0x${"0".repeat(64)}`);
  plan.configuration.sources[0].weightUnits = 1;
  expect(JSON.parse(plan.liveJson).sources[0].weightUnits).toBe(configuration.sources[0].weightUnits);
});

test.each([
  null, [], { ...mirror, extra: true },
  { ...mirror, spotCheckCount: 5 },
  { ...mirror, maxDeviationBps: 501 },
  { ...mirror, backendUrl: "http://snapshot.example.com" },
  { ...mirror, executorUrl: "https://user:secret@executor.example.com/reports" },
  { ...mirror, reportTtlSeconds: 0 },
  { ...mirror, schedule: "* * * * * *" },
].map((config) => ({ config })))("invalid mirror settings prevent preparation: %j", ({ config }) => {
  expect(() => prepare(config)).toThrow();
});

test("freeze preparation rejects another account", () => {
  expect(() => prepare(mirror, `0x${"a".repeat(40)}`)).toThrow("freeze account mismatch");
});


test.each([true, false])("failed mirror write restores previous pair (existing live=%s)", async (existing) => {
  const contents = new Map<string, string>([["mirror", JSON.stringify(mirror)]]);
  if (existing) contents.set("live", "previous live bytes");
  const before = new Map(contents);
  let failOnce = true;
  await expect(writeFreezeDeployment(prepare(), {
    read: async (path) => contents.get(path),
    write: async (path, value) => {
      contents.set(path, value);
      if (path === "mirror" && failOnce) { failOnce = false; throw new Error("disk write failed"); }
    },
    remove: async (path) => { contents.delete(path); },
  })).rejects.toThrow("previous artifacts restored");
  expect(contents).toEqual(before);
});

test("changed mirror settings abort before writing either artifact", async () => {
  let writes = 0;
  await expect(writeFreezeDeployment(prepare(), {
    read: async (path) => path === "mirror" ? JSON.stringify({ ...mirror, reportTtlSeconds: 200 }) : undefined,
    write: async () => { writes++; },
    remove: async () => { writes++; },
  })).rejects.toThrow("changed since preparation");
  expect(writes).toBe(0);
});

test("rollback failure is explicit and requires artifact inspection", async () => {
  await expect(writeFreezeDeployment(prepare(), {
    read: async (path) => path === "mirror" ? JSON.stringify(mirror) : "old live",
    write: async () => { throw new Error("disk unavailable"); },
    remove: async () => {},
  })).rejects.toThrow("freeze write and rollback failed");
});
