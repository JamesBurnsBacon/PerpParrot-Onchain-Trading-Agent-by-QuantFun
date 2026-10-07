import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MaterialsLab } from "../app/parrot/lab/LabClient";
import { ParrotEffectsProvider } from "../components/parrot/ParrotEffects";
import { SOUND_CATALOG } from "../lib/parrot-sfx-catalog";
import { MOMENTS } from "../lib/parrot-lab-scenario";

test("materials page renders accessible catalog, scenario and real visual samples under the provider", () => {
  const html = renderToStaticMarkup(<ParrotEffectsProvider><MaterialsLab /></ParrotEffectsProvider>);
  for (const label of ["Materials lab (development only)", "Unlock audio", "Mock scenario", "Run scenario", "Copy my picks", "Visual materials", "NEW!", "Bye!", "STRATEGY SET", "BOUNDED BY CODE", "LOCKED IN", "Swap flock", "Calm off", "Sound on", "SAMPLE DATA"]) expect(html).toContain(label);
  for (const mood of ["calm","steady","wild"]) expect(html).toContain(`data-vibe="${mood}"`);
  expect(html.match(/<select(?: |>)/g)).toHaveLength(MOMENTS.length);
  expect(html.match(/aria-label="Play /g)).toHaveLength(SOUND_CATALOG.length);
  expect(html.match(/>in use</g)).toHaveLength(7);
  expect(html).toContain('aria-label="My sound picks"');
  expect(html).toContain('class="wallet-nickname"');
  expect(html).not.toContain("<audio");
});
