export type DemoVideo =
  | { kind: "iframe"; src: string; title: string }
  | { kind: "video"; src: string };

function startSeconds(value: string | null): number | null {
  if (!value) return null;
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : parts ? Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0) : NaN;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

/** Canonicalize supported providers; never pass an arbitrary URL to an iframe. */
export function parseDemoVideo(url: string): DemoVideo | null {
  const input = url.trim();
  // URL() repairs missing slashes, backslashes and embedded newlines; reject those inputs.
  if (!/^https:\/\/[^/]/i.test(input) || /[\s\\]/.test(input)) return null;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;

  const host = parsed.hostname;
  let id: string | undefined;
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    id = parsed.pathname === "/watch"
      ? parsed.searchParams.get("v") ?? undefined
      : /^\/(?:embed|shorts|live)\/([^/]+)\/?$/.exec(parsed.pathname)?.[1];
  } else if (["youtu.be", "www.youtu.be", "m.youtu.be"].includes(host)) {
    id = /^\/([^/]+)\/?$/.exec(parsed.pathname)?.[1];
  }
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
    const src = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
    src.searchParams.set("rel", "0");
    src.searchParams.set("modestbranding", "1");
    const start = startSeconds(parsed.searchParams.get("start")) ?? startSeconds(parsed.searchParams.get("t"));
    if (start !== null) src.searchParams.set("start", String(start));
    return { kind: "iframe", src: src.href, title: "PerpParrot demo on YouTube" };
  }

  const vimeoId = ["vimeo.com", "www.vimeo.com"].includes(host)
    ? /^\/(\d+)\/?$/.exec(parsed.pathname)?.[1]
    : host === "player.vimeo.com" ? /^\/video\/(\d+)\/?$/.exec(parsed.pathname)?.[1] : undefined;
  if (vimeoId) return { kind: "iframe", src: `https://player.vimeo.com/video/${vimeoId}`, title: "PerpParrot demo on Vimeo" };

  if (/\.(mp4|webm)$/i.test(parsed.pathname)) return { kind: "video", src: parsed.href };
  return null;
}

// NEXT_PUBLIC values are inlined at build time. Missing/invalid configuration hides Demo.
export const DEMO_VIDEO = parseDemoVideo(process.env.NEXT_PUBLIC_DEMO_VIDEO_URL ?? "");
