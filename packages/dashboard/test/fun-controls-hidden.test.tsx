import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FunControls, ParrotEffectsProvider, SHOW_FUN_CONTROLS, useParrotEffects } from "../components/parrot/ParrotEffects";

// The owner hid the Sound / Calm buttons: sound ON and full motion are the fixed defaults; the toggle logic is kept for later.
test("the Sound and Calm buttons are not rendered", () => {
  expect(SHOW_FUN_CONTROLS).toBe(false);
  const html = renderToStaticMarkup(<ParrotEffectsProvider><FunControls /></ParrotEffectsProvider>);
  expect(html).not.toContain("Calm mode");
  expect(html).not.toContain("Sound");
  expect(html).not.toContain("<button");
});

test("defaults are sound on and motion on (calm off), and the toggle logic is still exposed", () => {
  let seen: ReturnType<typeof useParrotEffects> | null = null;
  const Probe = () => { seen = useParrotEffects(); return null; };
  renderToStaticMarkup(<ParrotEffectsProvider><Probe /></ParrotEffectsProvider>);
  expect(seen).not.toBeNull();
  expect(seen!.sound).toBe(true);
  expect(seen!.calm).toBe(false);
  expect(typeof seen!.toggleSound).toBe("function");
  expect(typeof seen!.toggleCalm).toBe("function");
});
