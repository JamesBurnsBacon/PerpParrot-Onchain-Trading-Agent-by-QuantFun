// Run from root: bun packages/backend/scripts/live-mutations.ts.
// Expect GREEN baseline/restoration and five RED guard failures in disposable copies.
// Offline mutation proof on disposable source copies; never edits the working tree.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "../../..");
const target = "packages/backend/src/live/handler.ts";
const baseline = readFileSync(resolve(root, target), "utf8");
const sha = (source: string) => createHash("sha256").update(source).digest("hex");
const expected = sha(baseline);
const cases = [
  { name: "kill switch", test: "live kill switch precedes", mutate: (s: string) => s.replace('  if (!deps.env.enabled || !deps.env.apiKey) return failure(503, "disabled");', "") },
  { name: "unknown body keys", test: "live rejects unknown body keys", mutate: (s: string) => s.replace('Object.keys(body).length !== 1 || typeof body.sdp', 'typeof body.sdp') },
  { name: "upstream body leak", test: "live upstream", mutate: (s: string) => s.replace('let rejected = false;', 'let rejected = false; let leakedBody = "";').replace('rejected = true;', 'rejected = true; leakedBody = await response.text();').replace('return failure(502, "model_unavailable");', 'return new Response(leakedBody, { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });') },
  { name: "reservation skipped", test: "live reserves cost before fetch", mutate: (s: string) => s.replace(/const reservation = await deps\.limiter\.reserve\(\{ ipHash: ipHash\(req, deps\), kind: "live"[\s\S]*?globalDaily: deps\.env\.globalDaily \} \}\);/, 'const reservation = { ok: true, id: "unreserved" } as const;') },
  { name: "client config forwarded", test: "live client-supplied config never reaches", mutate: (s: string) => s.replace('Object.keys(body).length !== 1 || typeof body.sdp', 'typeof body.sdp').replace('session: buildLiveConfig(deps.env)', 'session: body.session ?? body') },
];
const temp = mkdtempSync(resolve(tmpdir(), "parrot-live-mutations-"));
mkdirSync(resolve(temp, "packages/backend"), { recursive: true });
for (const dir of ["src", "test", "fixtures"]) cpSync(resolve(root, "packages/backend", dir), resolve(temp, "packages/backend", dir), { recursive: true });
cpSync(resolve(root, "packages/dashboard/lib"), resolve(temp, "packages/dashboard/lib"), { recursive: true });
cpSync(resolve(root, "packages/shared"), resolve(temp, "packages/shared"), { recursive: true });
symlinkSync(resolve(root, "packages/backend/node_modules"), resolve(temp, "packages/backend/node_modules"));
symlinkSync(resolve(root, "node_modules"), resolve(temp, "node_modules"));
const run = (test?: string) => Bun.spawnSync([process.execPath, "test", "test/live-session.test.ts", ...(test ? ["--test-name-pattern", test] : [])], {
  cwd: resolve(temp, "packages/backend"), env: { ...process.env, TEST_DATABASE_URL: "" }, stdout: "pipe", stderr: "pipe",
});
const green = run();
if (green.exitCode !== 0) throw new Error(`Baseline failed: ${green.stderr.toString()}`);
console.log(`GREEN baseline; SHA-256 ${expected}`);
for (const c of cases) {
  const changed = c.mutate(baseline);
  if (changed === baseline) throw new Error(`Mutation did not apply: ${c.name}`);
  try {
    writeFileSync(resolve(temp, target), changed);
    const result = run(c.test);
    const output = result.stdout.toString() + result.stderr.toString();
    writeFileSync(resolve(temp, `${c.name.replaceAll(" ", "-")}.log`), output);
    if (result.exitCode === 0 || !output.includes("(fail)") || !/expect\(received\)|SyntaxError: JSON Parse error/.test(output)) {
      throw new Error(`Mutation survived or did not run: ${c.name}\n${output}`);
    }
    console.log(`RED: ${c.name} — ${c.test}`);
  } finally {
    writeFileSync(resolve(temp, target), baseline);
  }
  if (sha(readFileSync(resolve(temp, target), "utf8")) !== expected || sha(readFileSync(resolve(root, target), "utf8")) !== expected) {
    throw new Error("SHA-256 mismatch");
  }
  if (run(c.test).exitCode !== 0) throw new Error(`Restoration failed: ${c.name}`);
  console.log(`GREEN: ${c.name} restored; disposable and workspace SHA-256 match`);
}
if (run().exitCode !== 0) throw new Error("Restored baseline failed");
console.log(`GREEN restored baseline. Logs: ${temp}`);
