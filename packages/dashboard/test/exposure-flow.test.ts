// Bun runs node:test directly; use the existing Node types without adding dependencies.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Exposures } from "../lib/data";
import { bandWidth, buildExposureFlow, shiftLabel, sideLabel, targetsWithMutes, walletLabel } from "../lib/exposure-flow";

const first = "0x2bd600000000000000000000000000000000b8d8";
const second = "0x5a7200000000000000000000000000000000eec4";
const response: Exposures = {
  runAt: 1,
  exposures: [{ asset: "BTC", fraction: 0.25 }, { asset: "ETH", fraction: -0.375 }],
  sources: [
    { address: first, weight: 0.25, contributions: [{ asset: "BTC", fraction: 0.5 }, { asset: "ETH", fraction: -0.125 }] },
    { address: second, weight: 0.75, contributions: [{ asset: "BTC", fraction: -0.25 }, { asset: "ETH", fraction: -0.25 }] },
  ],
};
const target = (muted: string[], asset = "BTC") => targetsWithMutes(buildExposureFlow(response), new Set(muted)).find((row) => row.asset === asset)!;

describe("exposure flow", () => {
  test("builds labels and percentage weights, retaining signed equity fractions", () => {
    const model = buildExposureFlow(response);
    assert.equal(model.wallets[0].label, "0x2bd6…b8d8");
    assert.equal(model.wallets[0].weightPct, 25);
    assert.deepEqual(model.wallets[0].contributions, response.sources![0].contributions);
    assert.equal(model.maxContribution, 0.5);
    assert.equal(model.bands.length, 4);
  });

  test("unmuted contributions reconcile to returned targets, with zero delta", () => {
    for (const { asset, fraction } of response.exposures) {
      assert.deepEqual(target([], asset), { asset, net: fraction, delta: 0 });
    }
  });

  test("muting a long contributor can turn the net short, without reweighting", () => {
    assert.deepEqual(target([first]), { asset: "BTC", net: -0.25, delta: -0.5 });
  });

  test("muting an offset increases the long target", () => {
    assert.deepEqual(target([second]), { asset: "BTC", net: 0.5, delta: 0.25 });
  });

  test("muting a short contributor reduces a short target", () => {
    assert.deepEqual(target([first], "ETH"), { asset: "ETH", net: -0.25, delta: 0.125 });
  });

  test("muting all sources leaves zero, and restoring them restores the baseline", () => {
    assert.deepEqual(target([first, second]), { asset: "BTC", net: 0, delta: -0.25 });
    assert.deepEqual(target([first, second], "ETH"), { asset: "ETH", net: 0, delta: 0.375 });
    assert.equal(target([]).net, 0.25);
  });

  test("the returned targets stay the baseline even if the attribution does not add up to them", () => {
    const skewed: Exposures = { ...response, exposures: [{ asset: "BTC", fraction: 0.3 }, { asset: "ETH", fraction: -0.375 }] };
    const rows = targetsWithMutes(buildExposureFlow(skewed), new Set<string>());
    assert.deepEqual(rows.find((row) => row.asset === "BTC"), { asset: "BTC", net: 0.3, delta: 0 });
    const muted = targetsWithMutes(buildExposureFlow(skewed), new Set([first])).find((row) => row.asset === "BTC")!;
    assert.deepEqual(muted, { asset: "BTC", net: 0.3 - 0.5, delta: -0.5 });
  });

  test("wallet matching is case insensitive and unknown mutes have no effect", () => {
    assert.deepEqual(target([first.toUpperCase()]), target([first]));
    assert.deepEqual(target(["unknown"]), target([]));
  });

  test("missing and empty sources do not invent wallets or bands", () => {
    for (const sources of [undefined, []]) {
      const model = buildExposureFlow({ runAt: 1, exposures: [], sources });
      assert.deepEqual(model, { wallets: [], assets: [], bands: [], maxContribution: 0 });
      assert.deepEqual(targetsWithMutes(model, new Set()), []);
    }
  });

  test("flat wallets and zero terms have no visible band or nonzero target", () => {
    const model = buildExposureFlow({ runAt: 1, exposures: [{ asset: "BTC", fraction: 0 }], sources: [
      { address: first, weight: 0.5, contributions: [] },
      { address: second, weight: 0.5, contributions: [{ asset: "BTC", fraction: 0 }] },
    ] });
    assert.equal(model.wallets.length, 2);
    assert.deepEqual(model.bands, []);
    assert.equal(model.maxContribution, 0);
    assert.deepEqual(targetsWithMutes(model, new Set([first])), [{ asset: "BTC", net: 0, delta: 0 }]);
  });

  test("opposing signs cancel and asset ordering stays fixed when muted", () => {
    const model = buildExposureFlow({ ...response, exposures: [{ asset: "BTC", fraction: 0 }, { asset: "ETH", fraction: -0.375 }], sources: response.sources!.map((source) => ({ ...source,
      contributions: [{ asset: "BTC", fraction: source.address === first ? 0.5 : -0.5 }],
    })) });
    assert.equal(targetsWithMutes(model, new Set()).find((row) => row.asset === "BTC")!.net, 0);
    assert.deepEqual(targetsWithMutes(model, new Set([first])).map((row) => row.asset), model.assets.map((row) => row.asset));
  });

  test("band widths are proportional, sign independent, minimum visible, and zero safe", () => {
    assert.equal(bandWidth(0.5, 0.5), 24);
    assert.equal(bandWidth(0.25, 0.5), 12);
    assert.equal(bandWidth(-0.25, 0.5), 12);
    assert.equal(bandWidth(1e-9, 0.5), 1.4);
    assert.equal(bandWidth(0, 0.5), 0);
    assert.equal(bandWidth(0, 0), 0);
  });

  test("wallet labels shorten for desktop and narrow layouts, preserving short strings", () => {
    assert.equal(walletLabel(first), "0x2bd6…b8d8");
    assert.equal(walletLabel(first, true), "0x2b…8d8");
    assert.equal(walletLabel("0x1234"), "0x1234");
    assert.equal(walletLabel("0x1234", true), "0x1234");
    assert.equal(walletLabel(""), "");
  });

  test("targets read as a side and a size, never as a signed number", () => {
    assert.equal(sideLabel(0.251), "Long 25.1%");
    assert.equal(sideLabel(-0.251), "Short 25.1%");
    assert.equal(sideLabel(0), "Flat");
    assert.equal(sideLabel(-0), "Flat");
    assert.equal(sideLabel(1e-12), "Flat"); // float noise
    assert.equal(sideLabel(-0.00001), "Short <0.1%"); // a real, tiny position is not hidden
    assert.equal(sideLabel(0.00049), "Long <0.1%");
  });

  test("a mute reads as a move toward long or short", () => {
    assert.equal(shiftLabel(0.141), "14.1 pp more long");
    assert.equal(shiftLabel(-0.141), "14.1 pp more short");
    assert.equal(shiftLabel(0), "no change");
    assert.equal(shiftLabel(1e-12), "no change");
    assert.equal(shiftLabel(-0.00001), "<0.1 pp more short");
  });
});
