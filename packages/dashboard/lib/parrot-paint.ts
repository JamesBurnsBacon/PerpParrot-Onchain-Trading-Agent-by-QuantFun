import { walletNickname } from "../../shared/wallet-persona";

export type Stroke = { tool: "dab" | "line"; color: string; width: number; points: [number, number][] };
const SKY = 10, HILLS = 5, PER_BIRD = 10;
const PLUMAGE = ["#568eb7", "#dbad49", "#c96555", "#7aa37a", "#a37ab8", "#d98f4a"];

/** Closed, JSON-shaped vocabulary in an 800 × 500 canvas. */
export function validateStrokes(input: unknown): Stroke[] {
  if (!Array.isArray(input) || input.length > 400) throw new Error("Expected at most 400 strokes");
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Reflect.ownKeys(value).length !== 4 ||
        !["tool", "color", "width", "points"].every(key => Object.hasOwn(value, key))) throw new Error("Invalid stroke fields");
    const { tool, color, width, points } = value;
    if (tool !== "dab" && tool !== "line") throw new Error("Invalid tool");
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Invalid color");
    if (typeof width !== "number" || !Number.isFinite(width) || width < 1 || width > 60) throw new Error("Invalid width");
    if (!Array.isArray(points) || points.length < 1 || points.length > 8) throw new Error("Invalid points");
    for (const point of points) {
      if (!Array.isArray(point) || point.length !== 2 ||
          typeof point[0] !== "number" || !Number.isFinite(point[0]) || point[0] < 0 || point[0] > 800 ||
          typeof point[1] !== "number" || !Number.isFinite(point[1]) || point[1] < 0 || point[1] > 500) throw new Error("Invalid coordinates");
    }
  }
  return input as Stroke[];
}

export function paintFlock(addresses: string[]): Stroke[] {
  const strokes: Stroke[] = [];
  const add = (tool: Stroke["tool"], color: string, width: number, ...points: Stroke["points"]) => strokes.push({ tool, color, width, points });
  for (let i = 0; i < SKY; i++) add("line", i < 5 ? "#a8cede" : "#c5dedc", 60, [0, 25 + i * 50], [800, 25 + i * 50]);
  for (let i = 0; i < HILLS; i++) add("line", i % 2 ? "#92ad80" : "#aac392", 60,
    [0, 310 + i * 35], [200, 275 + i * 35], [430, 310 + i * 35], [650, 270 + i * 35], [800, 300 + i * 35]);
  const ids = addresses.slice(0, 25), columns = Math.min(5, ids.length), rows = Math.ceil(ids.length / 5);
  ids.forEach((id, i) => {
    const name = walletNickname(id);
    const tilt = name.length % 7 - 3;
    const x = (i % columns + 1) * 800 / (columns + 1), y = 190 + Math.floor(i / columns) * 62 + (5 - rows) * 25;
    // Sample ids carry no risk metrics, so the vibe would be neutral for every bird. Plumage is therefore decorative here
    // (picked from the nickname) and does not mean calm/steady/wild as it does on the flock board.
    const color = PLUMAGE[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PLUMAGE.length];
    add("line", color, 9, [x - 12, y + 7], [x - 37, y + 21 + tilt]);
    add("line", color, 7, [x - 10, y + 10], [x - 29, y + 28]);
    add("dab", color, 45, [x, y]);
    add("dab", color, 36, [x - 7, y + 6]);
    add("dab", color, 30, [x + 13, y - 18 + tilt]);
    add("dab", "#f0ce78", 22, [x - 4, y + 2]);
    add("line", "#c67b3e", 8, [x + 25, y - 21 + tilt], [x + 36, y - 16 + tilt], [x + 25, y - 13 + tilt]);
    add("dab", "#353744", 6, [x + 17, y - 23 + tilt]);
    add("dab", "#fff4da", 2, [x + 18, y - 24 + tilt]);
    add("line", "#fff4da", 3, [x - 11, y - 8], [x - 4, y - 11], [x + 1, y - 9]);
  });
  return validateStrokes(strokes);
}

export function captionAt(progress: number, count: number): string {
  const p = Number.isNaN(progress) ? 0 : Math.max(0, Math.min(1, progress));
  const birds = Number.isFinite(count) ? Math.max(0, Math.min(25, Math.floor(count))) : 0;
  const step = Math.floor(p * (SKY + HILLS + birds * PER_BIRD));
  if (p === 1) return "Done. Not financial advice, I'm a bird.";
  if (step < SKY) return "Sky!";
  if (step < SKY + HILLS || birds === 0) return "Hills!";
  return `Bird #${Math.min(birds, Math.floor((step - SKY - HILLS) / PER_BIRD) + 1)}... Hold still, feathers!`;
}
