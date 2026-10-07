// Offline mutation checks in a disposable copy; never edits working source.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "parrot-paint-mutations-"));
const copy = join(temporary, "packages/dashboard");
const files = ["lib/parrot-paint.ts", "app/parrot/paint", "components/parrot/Badge.tsx",
  "test/parrot-paint.test.tsx", "test/parrot-paint-cleanup.test.tsx", "test/helpers/paint-dom.ts"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const targets = [
  { file: "lib/parrot-paint.ts", guard: " || input.length > 400", replacement: "", name: "validation cap rejects 401 otherwise valid strokes" },
  { file: "app/parrot/paint/PaintClient.tsx", guard: "      cancelAnimationFrame(frame);", replacement: "      // mutation: omitted cancellation", name: "unmount cancels the latest animation frame" },
];
const originals = targets.map(target => readFileSync(join(dashboard, target.file), "utf8"));
function run(name?: string) {
  return spawnSync(process.execPath, ["test", "./test/parrot-paint.test.tsx", "./test/parrot-paint-cleanup.test.tsx", ...(name ? ["--test-name-pattern", name] : [])], { cwd: copy, encoding: "utf8" });
}
function green(label: string) {
  const result = run();
  console.log(label, result.stdout.toString(), result.stderr.toString());
  if (result.status !== 0) throw new Error(`${label} failed`);
}
try {
  for (const file of files) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(join(dashboard, file), join(copy, file), { recursive: true });
  }
  mkdirSync(join(temporary, "packages/shared"), { recursive: true });
  for (const file of ["wallet-persona.ts", "sample-wallet-ids.ts"]) cpSync(join(dashboard, "../shared", file), join(temporary, "packages/shared", file));
  symlinkSync(realpathSync(join(dashboard, "node_modules")), join(copy, "node_modules"));
  green("GREEN baseline");
  for (const [index, target] of targets.entries()) {
    const path = join(copy, target.file), original = originals[index];
    if (original.split(target.guard).length !== 2) throw new Error("Guard must appear exactly once");
    try {
      writeFileSync(path, original.replace(target.guard, target.replacement));
      const result = run(target.name), output = result.stdout.toString() + result.stderr.toString();
      console.log(`RED ${target.name}\n${output}`);
      if (result.status !== 1 || !output.includes("(fail) " + target.name) || !output.includes("expect(")) throw new Error("Expected named assertion failure");
    } finally {
      writeFileSync(path, original);
      if (hash(readFileSync(path, "utf8")) !== hash(original)) throw new Error("Restoration hash mismatch");
      console.log(`SHA-256 restored ${target.file}: ${hash(original)}`);
    }
    green("GREEN restored");
  }
} finally {
  for (const [index, target] of targets.entries()) {
    if (hash(readFileSync(join(dashboard, target.file), "utf8")) !== hash(originals[index])) throw new Error("Working source changed");
  }
  rmSync(temporary, { recursive: true, force: true });
}
