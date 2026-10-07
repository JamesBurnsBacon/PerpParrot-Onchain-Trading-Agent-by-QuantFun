import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutePanel } from "../components/parrot/ExecutePanel";
import { PARROT_PRESETS } from "../lib/parrot-presets";


test("review-10: cached demo consistently describes simulation and live still describes saved request", () => {
  const { chat, preview } = PARROT_PRESETS[0];
  const render = (demo: boolean, result: typeof preview | null, busy = false) => renderToStaticMarkup(ExecutePanel({
    chat, result, demo, busy, failure: null, executionDisabled: false, onConfirm: () => {},
  })) as string;
  const html = render(true, preview);
  expect(html).toContain("Simulated request. Nothing was saved; no operator will review it.");
  expect(html).toContain("CACHED DEMO");
  expect(html).toContain("SIMULATED");
  expect(html).toContain("Not saved");
  for (const value of [html, render(true, null), render(true, null, true)]) {
    expect(value).not.toContain("Awaiting operator freeze");
    expect(value).not.toContain("PENDING");
    expect(value).not.toContain("Saving the pending request");
    expect(value).not.toContain("for an operator to review");
    expect(value).not.toContain("Available after the request is saved");
  }
  const live = render(false, preview);
  expect(live).toContain(`Request ${preview.requestId} saved. Awaiting operator freeze.`);
  expect(live).toContain("PENDING");
  expect(live).not.toContain("Simulated request.");
});
