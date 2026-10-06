// Small, dependency-free statistics for the maker-share study. Everything is rank based or resampled, because
// trader returns are heavy tailed. Randomness is seeded so reruns print the same numbers.

export const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const shuffle = <T>(items: T[], random: () => number): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};

// Average ranks (1-based), ties share their mean rank.
export const ranks = (xs: number[]): number[] => {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
};

export const pearson = (x: number[], y: number[]): number => {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
};

export const spearman = (x: number[], y: number[]): number => pearson(ranks(x), ranks(y));

const erf = (x: number): number => {
  // Abramowitz–Stegun 7.1.26, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
    Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
export const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

// Mann–Whitney U, normal approximation with tie correction. z > 0 means `a` tends to be larger than `b`.
export const mannWhitney = (a: number[], b: number[]): { z: number; p: number; auc: number } => {
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) return { z: 0, p: 1, auc: 0.5 };
  const all = ranks([...a, ...b]);
  const r1 = all.slice(0, n1).reduce((s, r) => s + r, 0);
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const counts = new Map<number, number>();
  for (const r of all) counts.set(r, (counts.get(r) ?? 0) + 1);
  let tie = 0;
  for (const t of counts.values()) tie += t ** 3 - t;
  const variance = ((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1)));
  const z = variance > 0 ? (u - (n1 * n2) / 2) / Math.sqrt(variance) : 0;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))), auc: u / (n1 * n2) };
};

// Two-sided permutation p-value for Spearman's rho.
export const spearmanPermutation = (x: number[], y: number[], iterations: number, random: () => number) => {
  const rx = ranks(x);
  const ry = ranks(y);
  const observed = pearson(rx, ry);
  let extreme = 0;
  for (let i = 0; i < iterations; i++) if (Math.abs(pearson(rx, shuffle(ry, random))) >= Math.abs(observed)) extreme++;
  return { rho: observed, p: (extreme + 1) / (iterations + 1) };
};

// Percentile bootstrap CI of a statistic over resampled row indices.
export const bootstrap = (
  n: number,
  statistic: (indices: number[]) => number,
  iterations: number,
  random: () => number,
): [number, number] => {
  const values: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const idx = Array.from({ length: n }, () => Math.floor(random() * n));
    const v = statistic(idx);
    if (Number.isFinite(v)) values.push(v);
  }
  return [quantile(values, 0.025), quantile(values, 0.975)];
};

// Ordinary least squares; returns coefficients for [intercept, ...columns].
export const ols = (columns: number[][], y: number[]): number[] => {
  const n = y.length;
  const X = Array.from({ length: n }, (_, i) => [1, ...columns.map((c) => c[i])]);
  const k = X[0].length;
  const A = Array.from({ length: k }, (_, r) => [
    ...Array.from({ length: k }, (_, c) => X.reduce((s, row) => s + row[r] * row[c], 0)),
    X.reduce((s, row, i) => s + row[r] * y[i], 0),
  ]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) throw new Error("ols: singular design");
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[k] / row[i]);
};

// Standardised ranks (mean 0, sd 1), so rank-OLS coefficients read like partial Spearman effects.
export const zRanks = (xs: number[]): number[] => {
  const r = ranks(xs);
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1)) || 1;
  return r.map((v) => (v - m) / sd);
};
