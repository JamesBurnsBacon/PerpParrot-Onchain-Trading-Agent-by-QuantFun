import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveTalk } from "../components/parrot/LiveTalk";
import { setMicEnabled } from "../lib/parrot-live";

const live = (view: Record<string, unknown>) => ({
  active: true, audio: { current: null }, end: () => {}, start: () => {}, toggleMute: () => {}, resumeAudio: async () => {},
  view: { phase: "live", user: "", parrot: "", avatar: "listening", remaining: 120, status: "", failure: null, playbackBlocked: false, muted: false, ...view },
});
const render = (view: Record<string, unknown>) => renderToStaticMarkup(<LiveTalk live={live(view) as never} disabled={false} />);

test("muting only disables the microphone tracks (the session keeps running)", () => {
  const tracks = [{ enabled: true }, { enabled: true }];
  const stream = { getAudioTracks: () => tracks };
  setMicEnabled(stream, false);
  expect(tracks.map(t => t.enabled)).toEqual([false, false]);
  setMicEnabled(stream, true);
  expect(tracks.map(t => t.enabled)).toEqual([true, true]);
  expect(() => setMicEnabled(null, false)).not.toThrow();
});

test("the mute button appears only while the call is live and reflects the muted state", () => {
  const open = render({});
  expect(open).toContain('aria-label="Mute microphone"');
  expect(open).toContain('aria-pressed="false"');
  expect(open).toContain("End");
  const muted = render({ muted: true });
  expect(muted).toContain('aria-label="Unmute microphone"');
  expect(muted).toContain('aria-pressed="true"');
  expect(muted).toContain("Muted");
  for (const phase of ["connecting", "closing"]) expect(render({ phase })).not.toContain("microphone");
  expect(renderToStaticMarkup(<LiveTalk live={{ ...live({}), active: false, view: { ...live({}).view, phase: "idle" } } as never} disabled={false} />)).not.toContain("microphone");
});
