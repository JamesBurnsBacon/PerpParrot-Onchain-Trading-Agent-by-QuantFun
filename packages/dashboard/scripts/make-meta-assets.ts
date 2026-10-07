// Regenerates the site's icons and share images from the parrot drawing and the mascot photo:
//   app/icon.svg, app/favicon.ico, app/apple-icon.png, app/opengraph-image.png (X falls back to it, so there is no separate twitter image),
//   public/icon-192.png, public/icon-512.png
// Run from packages/dashboard:  bun scripts/make-meta-assets.ts
// The outputs are committed; this script is only here so they can be reproduced or restyled.
import { createElement as h } from "react";
import { ImageResponse } from "next/og";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = (...p: string[]) => join(root, ...p);

// The perched parrot (the same paths as components/lp/ParrotSymbols.tsx), viewBox 0 0 400 420.
const PARROT = `
<g><path d="M178 262 C150 318 118 372 92 408 C132 396 172 352 200 292 Z" fill="#2a9d8f"/><path d="M196 270 C186 330 168 378 150 414 C190 392 222 340 228 282 Z" fill="#e9c46a"/><path d="M214 276 C216 332 214 380 208 416 C240 384 256 332 246 282 Z" fill="#f29a2e"/></g>
<path d="M214 96 C168 116 150 178 164 236 C176 286 214 306 246 296 C282 280 292 232 286 182 C282 140 262 108 232 96 Z" fill="#6cc04a"/>
<path d="M246 296 C282 280 292 232 286 182 C268 206 252 240 246 296 Z" fill="#7bd88f"/>
<g><path d="M196 150 C160 168 150 222 172 262 C188 290 214 296 226 286 C222 252 230 196 196 150 Z" fill="#3f9a3a"/><path d="M172 262 C176 276 186 288 198 294 L190 262 Z" fill="#2a78d6"/><path d="M190 268 C196 282 208 292 220 294 L212 262 Z" fill="#e9c46a"/></g>
<g><circle cx="246" cy="112" r="44" fill="#6cc04a"/><path d="M214 84 C218 52 246 40 270 52 C252 54 240 66 238 84 Z" fill="#f29a2e"/><path d="M206 96 C196 78 204 58 222 52 C214 66 214 80 222 92 Z" fill="#f29a2e"/></g>
<path d="M284 98 C312 96 334 112 330 138 C326 150 314 154 306 148 C312 134 300 124 284 126 Z" fill="#f29a2e"/>
<path d="M284 126 C298 126 310 134 306 148 C298 144 288 140 284 134 Z" fill="#f29a2e"/>
<circle cx="262" cy="106" r="11" fill="#fff"/><circle cx="265" cy="107" r="5.5" fill="#262c48"/><circle cx="267" cy="105" r="1.8" fill="#fff"/>
<path d="M96 318 C170 308 250 308 340 318 L340 330 C250 322 170 322 96 332 Z" fill="#8a6a4a"/>
<path d="M214 296 L214 316 M236 296 L236 316" stroke="#f29a2e" stroke-width="7" stroke-linecap="round"/>`;

const SAND = "#efe3d0";
const CREAM = "#fffcf5";
const INK = "#262c48";
const DEEP = "#3f9a3a";

// The icon: the parrot on a rounded sand tile (the parrot spans roughly x 90..340, y 40..420 of its box).
const iconSvg = (size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 400 400"><rect width="400" height="400" rx="92" fill="${SAND}"/><g transform="translate(-12 4) scale(0.93)">${PARROT}</g></svg>`;

writeFileSync(out("app/icon.svg"), iconSvg(400).replace(' width="400" height="400"', "") + "\n");

const png = async (element: ReturnType<typeof h>, width: number, height: number) =>
  Buffer.from(await new ImageResponse(element, { width, height }).arrayBuffer());

const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const squareIcon = (size: number) =>
  h("img", { src: dataUri(iconSvg(size)), width: size, height: size, style: { width: size, height: size } });

const icon = async (size: number) => png(squareIcon(size), size, size);

// favicon.ico: three PNG frames (16, 32, 48) in one ICO container.
const ico = (frames: { size: number; data: Buffer }[]) => {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const dir = frames.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size, 0); e.writeUInt8(size, 1); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...frames.map((f) => f.data)]);
};
writeFileSync(out("app/favicon.ico"), ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await icon(size) })))));
writeFileSync(out("app/apple-icon.png"), await icon(180));
writeFileSync(out("public/icon-192.png"), await icon(192));
writeFileSync(out("public/icon-512.png"), await icon(512));

// The share image, 1200x630: just the name and one line on the left, the mascot on a green hill on the right.
const mascot = `data:image/jpeg;base64,${readFileSync(out("public/lp/mascot.jpg")).toString("base64")}`;
const box = (style: Record<string, string | number>, ...children: unknown[]) =>
  h("div", { style: { position: "absolute", display: "flex", ...style } }, ...(children as never[]));

// The bundled font has one weight, so the title is drawn several times, 1px apart, to read as bold.
const boldTitle = (text: string, size: number) =>
  h(
    "div",
    { style: { display: "flex", position: "relative", height: size * 1.1 } },
    ...[[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [1, 2]].map(([dx, dy]) =>
      h("div", { key: `${dx}${dy}`, style: { position: "absolute", left: dx, top: dy, display: "flex", fontSize: size, color: INK, letterSpacing: -4, lineHeight: 1.1 } }, text),
    ),
  );

const share = h(
  "div",
  { style: { width: "100%", height: "100%", display: "flex", position: "relative", background: SAND, fontFamily: "sans-serif" } },
  box({ left: 36, top: 36, right: 36, bottom: 36, borderRadius: 56, background: CREAM, border: "4px solid #ffffff" }),
  // hills
  box({ left: 640, top: 440, width: 760, height: 520, borderRadius: "50%", background: "#8bcd69" }),
  box({ left: 780, top: 510, width: 700, height: 420, borderRadius: "50%", background: "#6cc04a" }),
  // mascot with a rainbow ring
  box({ left: 790, top: 140, width: 340, height: 340, borderRadius: "50%", background: "linear-gradient(135deg, #6cc04a, #eac744, #f29a2e, #9683bf, #639ec4)" }),
  box({ left: 802, top: 152, width: 316, height: 316, borderRadius: "50%", background: CREAM }),
  h("img", { src: mascot, width: 300, height: 300, style: { position: "absolute", left: 810, top: 160, width: 300, height: 300, borderRadius: "50%" } }),
  // text, vertically centred in the panel
  box(
    { left: 100, top: 36, bottom: 36, width: 680, flexDirection: "column", justifyContent: "center" },
    boldTitle("PerpParrot", 128),
    h("div", { style: { display: "flex", fontSize: 36, color: DEEP, marginTop: 26, whiteSpace: "nowrap" } }, "Copy the best Hyperliquid traders"),
  ),
);
const shareImage = await png(share, 1200, 630);
writeFileSync(out("app/opengraph-image.png"), shareImage);
console.log("wrote icon.svg, favicon.ico, apple-icon.png, icon-192/512.png, opengraph-image.png");
