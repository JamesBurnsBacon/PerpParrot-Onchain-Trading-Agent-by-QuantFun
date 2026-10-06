import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const sourceSchema = z.object({
  url: z.string().url(), fetchedAt: z.string().datetime(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(),
});
export type SourceEntry = z.infer<typeof sourceSchema>;
export type SourceName = "leaderboard" | "vaults";

export class SnapshotStore {
  constructor(public readonly root: string) {}
  async write(relative: string, text: string) {
    const path = join(this.root, relative);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, text, { flag: "wx" });
    await rename(temp, path);
  }
  async json(relative: string, value: unknown) { await this.write(relative, JSON.stringify(value, null, 2) + "\n"); }

  async cache(name: SourceName, raw: string, url: string, fetchedAt: string): Promise<SourceEntry> {
    JSON.parse(raw); // Never cache a partial download / non-JSON server response.
    const entry = sourceSchema.parse({ url, fetchedAt, sha256: digest(raw), bytes: Buffer.byteLength(raw) });
    const blob = `blobs/${entry.sha256}.json`;
    await mkdir(join(this.root, "blobs"), { recursive: true });
    try { await writeFile(join(this.root, blob), raw, { flag: "wx" }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (digest(await readFile(join(this.root, blob), "utf8")) !== entry.sha256) throw new Error("Corrupted immutable source blob");
    }
    await this.json(`cache/${name}.json`, entry);
    return entry;
  }

  async cached(name: SourceName, url: string, ttlMs: number, now = Date.now()) {
    try {
      const entry = sourceSchema.parse(JSON.parse(await readFile(join(this.root, `cache/${name}.json`), "utf8")));
      const age = now - Date.parse(entry.fetchedAt);
      if (entry.url !== url || age < 0 || age >= ttlMs) return null;
      const raw = await readFile(join(this.root, `blobs/${entry.sha256}.json`), "utf8");
      if (digest(raw) !== entry.sha256 || Buffer.byteLength(raw) !== entry.bytes) throw new Error("Cached source failed integrity check");
      return { entry, raw };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}
