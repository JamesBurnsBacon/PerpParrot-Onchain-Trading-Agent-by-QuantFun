import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parsePortfolio } from "../../score";
import { orderEvidence } from "../score-input";
import { digest } from "../store";
import { rankAsync } from "./ranking";
import { scoreSourceHash } from "./export-data";
import { LoopStore, TARGET_COUNT, type Account, type Selection } from "./store";

/** Copy evidence, never a running worker's leases, pending requests or publications.
 * SQLite's read transaction sees a consistent WAL snapshot while the old worker runs.
 * The source is opened read-only. Destination must be an empty, independent database.
 */
export async function importRegistry(sourcePath: string, target: LoopStore,
  now = Date.now(), rank: (accounts: Account[], now: number) => Promise<Selection[]> = rankAsync) {
  if (target.accounts().length || target.state("seed")) throw new Error("Destination registry must be empty");
  const source = new Database(sourcePath, { readonly: true, strict: true });
  const registryHash = createHash("sha256"), hashes = new Set<string>();
  let count = 0, verified = 0;
  const state = (key: string): unknown => {
    const row = source.query<{ body: string }, [string]>("SELECT body FROM state WHERE key=?").get(key);
    return row ? JSON.parse(row.body) : null;
  };
  const blob = source.query<{ raw: string }, [string]>("SELECT raw FROM blobs WHERE hash=?");
  const copyBlob = (hash: string) => {
    const row = blob.get(hash);
    if (!row || digest(row.raw) !== hash) throw new Error("Registry contains missing/corrupt evidence");
    if (!hashes.has(hash)) { target.blob(row.raw); hashes.add(hash); }
    return row.raw;
  };
  try {
    source.exec("BEGIN");
    const previousBootstrap = state("bootstrapComplete");
    if (!previousBootstrap) throw new Error("Source evidence bootstrap is incomplete");
    target.db.transaction(() => {
      for (const row of source.query<{ body: string }, []>("SELECT body FROM accounts ORDER BY address").iterate()) {
        const account = JSON.parse(row.body) as Account;
        const raw = copyBlob(account.rawHash);
        const fills = account.fillsHash ? JSON.parse(copyBlob(account.fillsHash)) : null;
        if (account.candidate.address !== account.input.address) throw new Error("Registry address mismatch");
        if (account.basis === "verified-input") {
          const windows = parsePortfolio(JSON.parse(raw));
          if (!account.classification || account.classification.kind !== account.input.kind
            || !isDeepStrictEqual(windows.month, account.input.month)
            || !isDeepStrictEqual(windows.allTime, account.input.allTime)
            || orderEvidence(fills, account.input.month?.pnlHistory.at(-1)?.[0] ?? 0).tradeCount !== account.input.tradeCount) {
            throw new Error("Registry input disagrees with preserved evidence");
          }
          verified++;
        }
        registryHash.update(row.body + "\n"); target.putAccount(account); count++;
      }
      target.setState("seed", { schema: "ingest-registry-import.v1", importedAt: new Date(now).toISOString(),
        accounts: count, verified, source: "read-only-sqlite-snapshot", sourceSeed: state("seed"),
        registrySha256: registryHash.digest("hex"), evidenceBlobs: hashes.size });
    })();
    source.exec("COMMIT");
    // Recompute with this checkout's Score; never inherit yesterday's selected order.
    const selected = await rank(target.accounts(), now);
    if (selected.length !== TARGET_COUNT) throw new Error("Imported registry has fewer than 100 fresh strict Score candidates");
    const codeHash = await scoreSourceHash();
    target.setState("selection", { generatedAt: now, selected, scoreSourceSha256: codeHash });
    target.setState("bootstrapComplete", { at: now, imported: true, verified, scoreSourceSha256: codeHash });
    return { marker: "INGEST_REGISTRY_IMPORTED", count, verified, selected: selected.length,
      scoreSourceSha256: codeHash, provenance: target.state("seed") };
  } catch (error) {
    if (source.inTransaction) source.exec("ROLLBACK");
    throw error;
  } finally { source.close(); }
}
