import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VerifyPanel } from "../components/parrot/VerifyPanel";

// Normal operation shows no badges; only the hand-authored cached demo is labelled.
test("verify panel labels only the cached demo", () => {
  const normal = renderToStaticMarkup(<VerifyPanel demo={false} onExecute={() => {}} canExecute={false} />);
  expect(normal).not.toContain("parrot-badge");
  for (const word of ["CACHED DEMO", "PRECOMPUTED", "REPLAY", "SAMPLE DATA"]) expect(normal).not.toContain(word);
  const demo = renderToStaticMarkup(<VerifyPanel demo onExecute={() => {}} canExecute={false} />);
  expect(demo.match(/CACHED DEMO/g)!.length).toBeGreaterThanOrEqual(2);
});
