import { expect, test } from "bun:test";
import { PARROT_PRESETS } from "../../dashboard/lib/parrot-presets";

// Dynamic JSX import keeps the backend typecheck independent of dashboard JSX.
const { ExecutePanel } = await import(new URL("../../dashboard/components/parrot/ExecutePanel.tsx", import.meta.url).href);
const { renderToStaticMarkup } = await import(new URL("../../dashboard/node_modules/react-dom/server.bun.js", import.meta.url).href);

test("review-10: cached demo consistently describes simulation and live still describes saved request", () => {
  const { chat, preview } = PARROT_PRESETS[0];
  const render = (demo: boolean, result: typeof preview | null, busy = false) => renderToStaticMarkup(ExecutePanel({
    chat, result, demo, busy, failure: null, executionDisabled: false, onConfirm: () => {},
  })) as string;
  const html = render(true, preview);
  expect(html).toContain("Simulated request. Nothing was saved; no operator will review it.");
  expect(html).toContain("CACHED DEMO · SIMULATED");
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
