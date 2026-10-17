/** Original tapered harmonic feather geometry, stable for each source identity. */
export function featherFingerprint(id: string) {
  let seed = 2166136261;
  for (const character of id)
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  const phase = (seed / 4294967296) * Math.PI * 2;
  const width = (t: number, layer: number) =>
    Math.pow(Math.sin(Math.PI * t), 0.8) *
    (27 - layer * 2.5) *
    (1 + Math.sin(t * Math.PI * 6 + phase) * 0.09);
  const stem = (t: number) =>
    Math.sin(t * Math.PI) * 7 + Math.sin(t * 5 + phase) * 2;
  const contours = Array.from({ length: 7 }, (_, layer) => {
    let d = "";
    for (let side = 0; side < 2; side++) {
      for (let step = 0; step <= 48; step++) {
        const t = side ? 1 - step / 48 : step / 48;
        const x = stem(t) + width(t, layer) * (side ? -1 : 1);
        const y = -t * (108 - layer * 1.2);
        d += `${side || step ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)} `;
      }
    }
    return d + "Z";
  });
  const barbs = Array.from({ length: 16 }, (_, index) => {
    const t = 0.1 + index * 0.049;
    const x = stem(t),
      y = -t * 108;
    return `M${(x - width(t, 0)).toFixed(2)} ${(y - 6).toFixed(2)} Q${x.toFixed(2)} ${(y + 7).toFixed(2)} ${(x + width(t, 0)).toFixed(2)} ${(y - 6).toFixed(2)}`;
  });
  return { contours, barbs, phase };
}
