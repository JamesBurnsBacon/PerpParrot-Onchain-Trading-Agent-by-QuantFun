import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import PaintPage from "../app/parrot/paint/page";
import { captionAt, paintFlock, validateStrokes } from "../lib/parrot-paint";
import { SAMPLE_WALLET_IDS } from "../../shared/sample-wallet-ids";

const stroke = { tool: "dab", color: "#123aBC", width: 10, points: [[0, 500]] };
test("paint is deterministic, identity-dependent and always validates", () => {
  for (let n = 0; n <= 40; n++) {
    const ids = SAMPLE_WALLET_IDS.slice(0, n);
    const output = paintFlock(ids);
    expect(output).toEqual(paintFlock(ids));
    expect(validateStrokes(output)).toEqual(output);
    expect(output.length).toBe(15 + Math.min(n, 25) * 10);
  }
  expect(paintFlock([SAMPLE_WALLET_IDS[0]])).not.toEqual(paintFlock([SAMPLE_WALLET_IDS[1]]));
});
test("25 birds fit the stroke cap and additional IDs are ignored", () => {
  expect(paintFlock([...SAMPLE_WALLET_IDS]).length).toBeLessThanOrEqual(400);
  expect(paintFlock([...SAMPLE_WALLET_IDS])).toEqual(paintFlock(SAMPLE_WALLET_IDS.slice(0, 25)));
});
test("validation cap rejects 401 otherwise valid strokes", () => {
  expect(validateStrokes(Array(400).fill(stroke))).toHaveLength(400);
  expect(() => validateStrokes(Array(401).fill(stroke))).toThrow();
});
for (const [label, value] of [
  ["null", null], ["object", {}], ["string", "paint"], ["sparse strokes", Array(1)],
  ["null stroke", [null]], ["missing field", [{ tool: "dab" }]],
  ["extra field", [{ ...stroke, opacity: 1 }]], ["tool", [{ ...stroke, tool: "spray" }]],
  ...["red", "#fff", "#ffffff00", "#gggggg", 123].map(color => [String(color), [{ ...stroke, color }]]),
  ...[0, 61, NaN, Infinity, "3", null].map(width => [`width ${width}`, [{ ...stroke, width }]]),
  ...[[], Array(9).fill([1, 2]), Array(1), [[-1, 0]], [[801, 0]], [[0, -1]], [[0, 501]],
    [[NaN, 0]], [[0, Infinity]], [["1", 2]], [[1]], [[1, 2, 3]], [null], [Array(2)], null].map(points => ["points " + JSON.stringify(points), [{ ...stroke, points }]]),
] as [string, unknown][]) test(`validation rejects ${label}`, () => expect(() => validateStrokes(value)).toThrow());
test("valid vocabulary boundaries", () => {
  expect(validateStrokes([])).toEqual([]);
  expect(validateStrokes([{ ...stroke, width: 1 }, { ...stroke, tool: "line", width: 60, points: Array(8).fill([800, 500]) }])).toHaveLength(2);
});
test("captions are total, bounded and cover all phases", () => {
  for (const p of [-Infinity, -1, 0, .1, .5, .9999, 1, 2, Infinity, NaN]) {
    for (const n of [-Infinity, -5, 0, 1, 8, 25, 100, Infinity, NaN]) {
      const caption = captionAt(p, n);
      expect(caption.length).toBeGreaterThan(0);
      expect(caption).not.toMatch(/NaN|Infinity|undefined/);
    }
  }
  expect(captionAt(0, 8)).toBe("Sky!");
  expect(captionAt(11 / 95, 8)).toBe("Hills!");
  expect(captionAt(35 / 95, 8)).toContain("Bird #3");
  expect(captionAt(1, 8)).toBe("Done. Not financial advice, I'm a bird.");
});
test("page renders accessible canvas, sample badge, credit and controls", () => {
  const html = renderToStaticMarkup(<PaintPage />);
  expect(html).toMatch(/<canvas[^>]*role="img"[^>]*aria-label="A brushstroke painting/);
  expect(html).toContain('aria-label="Painting progress"');
  expect(html).toContain("SAMPLE DATA");
  expect(html).toContain("Inspired by Stillwet by Alice (stillwet.art, MIT). No code or paintings reused.");
  for (const button of ["Replay", "1x", "2x", "4x", "New flock"]) expect(html).toContain(`>${button}</button>`);
});
