import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EffectsLab } from "../components/parrot/EffectsLab";
import { ParrotEffectsProvider } from "../components/parrot/ParrotEffects";
import { PARROT_PRESETS } from "../lib/parrot-presets";

test("the effects lab offers every cached strategy, the fever banners and every sound", () => {
  const html = renderToStaticMarkup(<ParrotEffectsProvider><EffectsLab onPreset={() => {}} onLock={() => {}} onReset={() => {}} /></ParrotEffectsProvider>);
  for (const preset of PARROT_PRESETS) expect(html).toContain(preset.label.replace(/&/g, "&amp;"));
  for (const text of ["Lab: safe (6)", "Lab: balanced (12)", "Lab: aggressive (16)", "Lab: only the wild ones (8)", "Lock request", "Reset", "STRATEGY SET", "BOUNDED BY CODE", "LOCKED IN", "Swoosh in", "Pop out", "Clamp bonk", "Lock stamp + jingle", "Calm off"]) expect(html).toContain(text);
  expect(html).toContain("development only");
});
