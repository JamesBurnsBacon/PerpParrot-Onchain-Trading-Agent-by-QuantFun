// Refuses to deploy a workflow config that still has placeholders (README §4.14).
// Usage: bun run scripts/check-config.ts <workflow> <target>   (from packages/cre-workflows)
const [workflow, target] = process.argv.slice(2);
if (!workflow || !target) {
  console.error("usage: check-config.ts <workflow> <target>");
  process.exit(2);
}

const file = `${workflow}/config.${target === "production-settings" ? "production" : "staging"}.json`;
const config = (await Bun.file(new URL(`../${file}`, import.meta.url)).json()) as Record<string, unknown>;
const problems: string[] = [];

for (const [key, value] of Object.entries(config)) {
  if (typeof value === "string" && /REPLACE|example\.com|localhost|127\.0\.0\.1/i.test(value)) {
    problems.push(`${key} is a placeholder or local address: ${value}`);
  }
}

if (workflow === "mirror" && target === "production-settings") {
  for (const key of ["backendUrl", "executorUrl"]) {
    if (!String(config[key] ?? "").startsWith("https://")) problems.push(`${key} must be https`);
  }
  if (/^0x0{64}$/.test(String(config.frozenConfigurationHash))) problems.push("frozenConfigurationHash is unset (all zeros)");
  const checks = Number(config.spotCheckCount);
  if (!(checks >= 1 && checks <= 4)) problems.push("spotCheckCount must be 1–4 (HTTP budget)");
  if (Number(config.maxSnapshotAgeSeconds) > 180) problems.push("maxSnapshotAgeSeconds should be ≤ 180 in production");
}

if (problems.length > 0) {
  console.error(`${file} isn't ready to deploy:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`${file}: ok`);
