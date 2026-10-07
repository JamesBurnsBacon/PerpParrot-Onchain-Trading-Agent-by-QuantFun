import { describe, expect, test } from "bun:test";
import { describeError, waitPillLabel } from "../lib/parrot";

describe("the idle status pill says how long to wait", () => {
  test("a rate-limited visitor sees minutes (positive control: built from the real error text)", () => {
    expect(waitPillLabel(describeError("rate_limited", 2900))).toBe("Wait 49 min");
    expect(waitPillLabel(describeError("budget", 3600))).toBe("Wait 60 min");
  });
  test("a short wait is shown in seconds", () => {
    expect(waitPillLabel(describeError("rate_limited", 45))).toBe("Wait 45s");
  });
  test("any other failure falls through to the generic label", () => {
    expect(waitPillLabel(describeError("model_unavailable"))).toBeNull();
    expect(waitPillLabel(describeError("rate_limited"))).toBeNull(); // no retry hint: "Try again shortly."
    expect(waitPillLabel("")).toBeNull();
  });
});
