export type MorphShape = "parrot" | "plumage" | "orbit";
export type MorphPalette = "solar" | "ultraviolet";
const palettes = {
  solar: ["#fff276", "#ff9f66", "#98f4ed", "#b9a2ff", "#fd8fb8"],
  ultraviolet: ["#ad91ff", "#7ffff2", "#f3ff86", "#ff81d8", "#8eb6ff"],
};
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export function createParrotMorph(seed = 47, count = 1800) {
  if (!Number.isInteger(count) || count < 100 || count > 4000)
    throw new Error("Point count must be 100–4000.");
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const samples = Array.from({ length: count }, () => [
    random(),
    random(),
    random(),
    random(),
  ]);
  const positions = new Float32Array(count * 3),
    targets = new Float32Array(count * 3),
    velocities = new Float32Array(count * 3),
    colors = new Float32Array(count * 3);
  let colorVersion = 0;
  const setPalette = (palette: MorphPalette) => {
    samples.forEach((sample, index) => {
      const part = sample[3];
      const color =
          part < 0.35
            ? palette === "solar"
              ? part < 0.23
                ? "#ffd879"
                : "#fff5bf"
              : "#c5fff3"
            : part < 0.36
              ? "#171c3c"
              : part < 0.4
                ? "#ff926e"
                : part < 0.57
                  ? palette === "solar"
                    ? "#477caa"
                    : "#6474b9"
                  : part < 0.87
                    ? palettes[palette][Math.floor(sample[0] * 5)]
                    : palette === "solar"
                      ? "#ffad68"
                      : "#af96ff",
        value = parseInt(color.slice(1), 16);
      colors[index * 3] = (value >> 16) / 255;
      colors[index * 3 + 1] = ((value >> 8) & 255) / 255;
      colors[index * 3 + 2] = (value & 255) / 255;
    });
    colorVersion++;
  };
  const setShape = (shape: MorphShape) => {
    samples.forEach(([a, b, c, d], index) => {
      const angle = a * Math.PI * 2,
        sphereY = b * 2 - 1,
        radius = Math.sqrt(1 - sphereY * sphereY),
        k = index * 3;
      let x = 0,
        y = 0,
        z = 0;
      if (shape === "orbit") {
        const ring = Math.floor(d * 3),
          theta = angle + ring * 0.4,
          r = 0.6 + ring * 0.25 + (b - 0.5) * 0.07;
        x = Math.cos(theta) * r;
        y = Math.sin(theta) * r * 0.68;
        z = (c - 0.5) * 0.35;
        if (ring === 1) {
          const swap = y;
          y = z;
          z = swap;
        }
      } else if (shape === "plumage") {
        const feather = Math.floor(d * 5),
          t = a,
          spread = (feather - 2) * 0.35,
          width = Math.sin(t * Math.PI) * 0.22;
        const px = (b - 0.5) * width * 2,
          py = t * 1.8;
        x = px * Math.cos(spread) - py * Math.sin(spread);
        y = px * Math.sin(spread) + py * Math.cos(spread) - 0.8;
        z = (c - 0.5) * 0.23;
      } else {
        const part = d;
        if (part < 0.175) {
          // Filled projected breast, tapered into the swept upper shoulder.
          const disk = Math.sqrt(b),
            vertical = Math.sin(angle) * disk;
          x =
            0.03 + Math.cos(angle) * disk * 0.24 - Math.max(0, vertical) * 0.1;
          y = vertical * 0.36 - 0.08;
          z = (c - 0.5) * 0.23;
        } else if (part < 0.23) {
          // A substantial curved neck overlaps both skull and upper breast.
          const t = a,
            width = 0.135 - t * 0.042;
          x = -0.025 - t * 0.225 + (b - 0.5) * width * 2;
          y = 0.1 + t * 0.335 + (c - 0.5) * 0.085;
          z = 0.035 + (b - 0.5) * 0.1;
        } else if (part < 0.35) {
          if (part > 0.329) {
            // Three swept crest quills, rather than an anonymous round head.
            const quill = Math.floor(a * 3),
              t = (a * 3) % 1;
            x = -0.28 + quill * 0.058 + t * 0.18;
            y = 0.57 + t * 0.26 + (b - 0.5) * 0.018;
            z = 0.04 + (c - 0.5) * 0.07;
          } else {
            x = -0.27 + Math.cos(angle) * radius * 0.185;
            y = 0.44 + sphereY * 0.2;
            z = Math.sin(angle) * radius * 0.16 + 0.02;
          }
        } else if (part < 0.36) {
          x = -0.35 + Math.cos(angle) * radius * 0.024;
          y = 0.49 + sphereY * 0.025;
          z = 0.17 + Math.sin(angle) * radius * 0.014;
        } else if (part < 0.4) {
          // Hooked bill: broad upper mandible turns down into a fine tip.
          x = -0.42 - Math.sin(a * Math.PI * 0.7) * 0.24;
          y = 0.46 - a * a * 0.18 + (b - 0.5) * 0.11 * (1 - a);
          z = 0.035 + (c - 0.5) * 0.12 * (1 - a * 0.7);
        } else if (part < 0.57) {
          // Foreshortened far wing: subdued and visibly behind the body.
          const feather = Math.floor(b * 6),
            t = a;
          x = -0.04 - t * (0.43 + feather * 0.045);
          y = 0.06 + t * (0.49 - feather * 0.04) + Math.sin(t * Math.PI) * 0.1;
          z = -0.18 + (c - 0.5) * 0.035;
        } else if (part < 0.87) {
          // Separate primaries with dark gaps; every strip shares one hinge.
          const feather = Math.floor(b * 9),
            local = b * 9 - feather,
            t = a;
          const endX = 0.5 + feather * 0.13,
            endY = 1.12 - feather * 0.105;
          const width =
            Math.sin(t * Math.PI) *
            (0.035 + feather * 0.002 + Math.max(0, 0.52 - t) * 0.42);
          x =
            0.09 +
            t * endX +
            Math.sin(t * Math.PI) * 0.13 +
            (local - 0.5) * width;
          y =
            0.12 +
            t * endY +
            Math.sin(t * Math.PI) * 0.16 +
            (local - 0.5) * width;
          z = 0.16 + Math.sin(t * Math.PI) * 0.22 + (c - 0.5) * 0.045;
        } else {
          const feather = Math.floor(b * 3),
            t = a;
          x =
            0.11 +
            t * (0.36 + feather * 0.145) +
            (c - 0.5) * (0.065 - t * 0.037);
          y = -0.33 - t * (0.79 + feather * 0.09);
          z = 0.03 + feather * 0.02;
        }
      }
      targets[k] = x;
      targets[k + 1] = y;
      targets[k + 2] = z;
    });
  };
  setShape("parrot");
  setPalette("solar");
  positions.set(targets);
  return {
    positions,
    colors,
    targets,
    count,
    setShape,
    setPalette,
    get colorVersion() {
      return colorVersion;
    },
    burst() {
      for (let i = 0; i < count; i++) {
        const k = i * 3;
        velocities[k] += (samples[i][0] - 0.5) * 0.085;
        velocities[k + 1] += (samples[i][1] - 0.5) * 0.085;
        velocities[k + 2] += (samples[i][2] - 0.5) * 0.085;
      }
    },
    advance(delta: number, pointer: { x: number; y: number; active: boolean }) {
      if (!Number.isFinite(delta)) return;
      const validPointer =
        Number.isFinite(pointer.x) && Number.isFinite(pointer.y);
      const pointerX = validPointer ? pointer.x : 0;
      const pointerY = validPointer ? pointer.y : 0;
      const step = clamp(delta, 0, 50) / 16.667;
      if (!step) return;
      for (let i = 0; i < count; i++) {
        const k = i * 3,
          dx = positions[k] - pointerX,
          dy = positions[k + 1] - pointerY,
          distance = Math.hypot(dx, dy),
          force =
            validPointer && pointer.active && distance < 0.43
              ? (1 - distance / 0.43) * 0.012
              : 0;
        for (let axis = 0; axis < 3; axis++) {
          const j = k + axis,
            push = axis === 0 ? dx : axis === 1 ? dy : 0;
          velocities[j] = clamp(
            (velocities[j] +
              (targets[j] - positions[j]) * 0.018 * step +
              (push / (distance + 0.03)) * force * step) *
              Math.pow(0.86, step),
            -0.08,
            0.08,
          );
          positions[j] = clamp(positions[j] + velocities[j] * step, -2.5, 2.5);
        }
      }
    },
  };
}
export type ParrotMorph = ReturnType<typeof createParrotMorph>;
