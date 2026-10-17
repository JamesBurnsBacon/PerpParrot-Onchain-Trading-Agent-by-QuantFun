import { createNoise3D } from "simplex-noise";
export type FlightMode = "flow" | "flock" | "orbit";
export type FlightParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  history: { x: number; y: number }[];
  cursor: number;
  count: number;
};
export type FlightPointer = { x: number; y: number; active: boolean };
export const PARTICLE_COUNT = 105,
  HISTORY_LENGTH = 26,
  MAX_SPEED = 0.009;
export const FLIGHT_PALETTE = [
  "#3465ef",
  "#56b9ff",
  "#f3ca59",
  "#ef795e",
] as const;
export function createFlightEngine({
  seed,
  mode,
  intensity = 55,
}: {
  seed: number;
  mode: FlightMode;
  intensity?: number;
}) {
  let state = seed >>> 0,
    tick = 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const field = Array.from({ length: 5 }, (_, i) => ({
    k: 2 + i * 1.4,
    phase: random() * Math.PI * 2,
    amp: 1 / (i + 1),
  }));
  const particles: FlightParticle[] = Array.from(
    { length: PARTICLE_COUNT },
    (_, i) => {
      const a = random() * Math.PI * 2,
        r = 0.1 + random() * 0.32;
      return {
        x: mode === "orbit" ? 0.55 + Math.cos(a) * r : random(),
        y: mode === "orbit" ? 0.48 + Math.sin(a) * r : random(),
        vx: 0.002 + random() * 0.003,
        vy: (random() - 0.5) * 0.005,
        color:
          FLIGHT_PALETTE[i % 10 < 4 ? 0 : i % 10 < 7 ? 1 : i % 10 < 9 ? 2 : 3],
        size: 0.6 + random() * 1.3,
        history: Array.from({ length: HISTORY_LENGTH }, () => ({ x: 0, y: 0 })),
        cursor: 0,
        count: 0,
      };
    },
  );
  const snapshot = particles.map((p) => ({
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
  }));
  // Seed only at initialization. Scalar potential is a three-octave fBm sum.
  const noise = createNoise3D(random);
  const potential = (x: number, y: number, time: number) => {
    let value = 0,
      amplitude = 1,
      frequency = 1,
      total = 0;
    for (let octave = 0; octave < 3; octave++) {
      value +=
        noise(
          x * frequency * 1.7 + field[octave].phase,
          y * frequency * 1.7,
          time * 0.23,
        ) * amplitude;
      total += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    return value / total;
  };
  // curl(phi) = (dphi/dy, -dphi/dx). Central differences retain local coherence.
  const sampleField = (x: number, y: number, time: number) => {
    if (![x, y, time].every(Number.isFinite))
      throw new RangeError("Field coordinates must be finite.");
    const epsilon = 0.002;
    const dx =
      (potential(x + epsilon, y, time) - potential(x - epsilon, y, time)) /
      (2 * epsilon);
    const dy =
      (potential(x, y + epsilon, time) - potential(x, y - epsilon, time)) /
      (2 * epsilon);
    return { x: dy * 0.00065, y: -dx * 0.00065 };
  };
  const force = (p: FlightParticle) => {
    const flow = sampleField(p.x, p.y, tick * 0.006);
    const phrase = 0.75 + 0.25 * Math.sin(tick * 0.013 + field[0].phase);
    return { x: flow.x * phrase + 0.0013, y: flow.y * phrase };
  };
  const advance = (
    options: { intensity?: number; pointer?: FlightPointer } = {},
  ) => {
    const requested = options.intensity ?? intensity;
    const level = Number.isFinite(requested)
      ? Math.max(10, Math.min(100, requested))
      : 55;
    const pointer = options.pointer;
    particles.forEach((p, i) =>
      Object.assign(snapshot[i], { x: p.x, y: p.y, vx: p.vx, vy: p.vy }),
    );
    particles.forEach((p, i) => {
      let f = force(p);
      if (mode === "orbit") {
        const dx = p.x - 0.55,
          dy = p.y - 0.48,
          r = Math.hypot(dx, dy);
        f = {
          x: -dy * 0.025 - dx * (r - 0.27) * 0.012,
          y: dx * 0.025 - dy * (r - 0.27) * 0.012,
        };
      } else if (mode === "flock") {
        let n = 0,
          ax = 0,
          ay = 0,
          cx = 0,
          cy = 0,
          sx = 0,
          sy = 0;
        snapshot.forEach((q, j) => {
          if (i === j) return;
          const dx = p.x - q.x,
            dy = p.y - q.y,
            d = Math.hypot(dx, dy);
          if (d < 0.16) {
            n++;
            ax += q.vx;
            ay += q.vy;
            cx += q.x;
            cy += q.y;
            if (d < 0.045 && d > 0.001) {
              sx += dx / (d * d);
              sy += dy / (d * d);
            }
          }
        });
        f = {
          x:
            f.x * 0.6 +
            (n ? (ax / n) * 0.6 + (cx / n - p.x) * 0.013 : 0) +
            sx * 0.000025,
          y:
            f.y * 0.6 +
            (n ? (ay / n) * 0.6 + (cy / n - p.y) * 0.013 : 0) +
            sy * 0.000025,
        };
      }
      if (
        pointer?.active &&
        Number.isFinite(pointer.x) &&
        Number.isFinite(pointer.y)
      ) {
        const dx = pointer.x - p.x,
          dy = pointer.y - p.y,
          d = Math.hypot(dx, dy);
        if (d > 0.03 && d < 0.65) {
          f.x += dx * 0.004;
          f.y += dy * 0.004;
        }
      }
      p.vx = p.vx * 0.88 + f.x * 0.12;
      p.vy = p.vy * 0.88 + f.y * 0.12;
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > MAX_SPEED) {
        p.vx *= MAX_SPEED / speed;
        p.vy *= MAX_SPEED / speed;
      }
      p.x += p.vx * (0.45 + level * 0.016);
      p.y += p.vy * (0.45 + level * 0.016);
      if (p.x < -0.03 || p.x > 1.03 || p.y < -0.03 || p.y > 1.03) {
        p.x = (p.x + 1) % 1;
        p.y = (p.y + 1) % 1;
        p.count = 0;
        p.cursor = 0;
      }
      const point = p.history[p.cursor];
      point.x = p.x;
      point.y = p.y;
      p.cursor = (p.cursor + 1) % HISTORY_LENGTH;
      p.count = Math.min(HISTORY_LENGTH, p.count + 1);
    });
    tick++;
  };
  return {
    particles,
    advance,
    sampleField,
    get tick() {
      return tick;
    },
  };
}
