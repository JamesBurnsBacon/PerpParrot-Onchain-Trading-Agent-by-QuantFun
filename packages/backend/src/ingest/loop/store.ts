import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ScoreInput } from "../../score/types";
import type { Candidate, KindResult } from "../types";
import { digest } from "../store";

export const INTERVAL_MS = 600_000;
export const TARGET_COUNT = 100;
export const bucketAt = (now: number) => Math.floor(now / INTERVAL_MS) * INTERVAL_MS;
export const runIdAt = (bucket: number) => `ingest-${bucket / 1000}`;
export type Account = {
  candidate: Candidate; input: ScoreInput; fetchedAt: string; rawHash: string;
  classification: KindResult | null; classificationAt: string | null;
  fillsHash: string | null; fillsCheckedAt: string | null;
  basis: "research-priority" | "verified-input";
};
export type Selection = { address: string; score: number; pool: string; rank: number; fetchedAt: string; basis: Account["basis"] };
export type AccountHealth = { lastAttemptAt: number | null; lastSuccessAt: number | null; lastFailureAt: number | null;
  consecutiveFailures: number; totalFailures: number; quarantinedUntil: number; lastError: string | null };
export type AccountFailure = { address: string; slot: number; at: number; reason: string; consecutiveFailures: number };
export type Substitution = { slot: number; from: string; to: string; at: number; reason: string; rankingSha256: string };
export type Run = {
  id: string; bucket: number; status: "queued" | "running" | "failed" | "complete";
  selected: Selection[]; startedAt: number | null; finishedAt: number | null; attempts: number;
  error: string | null; artifactHash: string | null;
  effectiveSelection?: Selection[]; substitutions?: Substitution[]; accountFailures?: AccountFailure[];
};

// One durable local worker database. WAL + FULL durability and an owner-fenced lease
// make replays/restarts safe; deployment to multiple hosts needs a shared DB adapter.
export class LoopStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS accounts(address TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY, raw TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, bucket INTEGER UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(run_id TEXT NOT NULL, address TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,address));
      CREATE TABLE IF NOT EXISTS request_attempts(id TEXT PRIMARY KEY, run_id TEXT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_health(address TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS request_attempt_run ON request_attempts(run_id);
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS budget(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, at INTEGER NOT NULL, weight INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS budget_scope_time ON budget(scope,at);`);
  }
  close() { this.db.close(); }
  blob(raw: string): string {
    const hash = digest(raw);
    this.db.query("INSERT OR IGNORE INTO blobs VALUES(?,?)").run(hash, raw);
    if (this.raw(hash) !== raw) throw new Error("Blob integrity conflict");
    return hash;
  }
  raw(hash: string): string {
    const row = this.db.query<{ raw: string }, [string]>("SELECT raw FROM blobs WHERE hash=?").get(hash);
    if (!row || digest(row.raw) !== hash) throw new Error("Missing/corrupt evidence blob");
    return row.raw;
  }
  state<T>(key: string): T | null {
    const row = this.db.query<{ body: string }, [string]>("SELECT body FROM state WHERE key=?").get(key);
    return row ? JSON.parse(row.body) : null;
  }
  setState(key: string, value: unknown) {
    this.db.query("INSERT OR REPLACE INTO state VALUES(?,?)").run(key, JSON.stringify(value));
  }
  requestAttempt(id: string, runId: string | null, value: unknown) {
    this.db.query("INSERT OR REPLACE INTO request_attempts VALUES(?,?,?)").run(id, runId, JSON.stringify(value));
  }
  requestAttempts(runId: string): unknown[] {
    return this.db.query<{ body: string }, [string]>("SELECT body FROM request_attempts WHERE run_id=? ORDER BY rowid").all(runId).map(r => JSON.parse(r.body));
  }
  interruptUnfinishedRequests(runId: string, owner: string, now: number) {
    this.db.transaction(() => {
      this.assertOwner(owner, now);
      this.db.query(`UPDATE request_attempts SET body=json_set(body,'$.status','interrupted','$.finishedAt',?,
        '$.error','previous worker ended before recording an outcome')
        WHERE run_id=? AND json_extract(body,'$.status')='started'`).run(now, runId);
    })();
  }
  accounts(): Account[] {
    return this.db.query<{ body: string }, []>("SELECT body FROM accounts ORDER BY address").all().map(r => JSON.parse(r.body));
  }
  account(address: string): Account {
    const row = this.db.query<{ body: string }, [string]>("SELECT body FROM accounts WHERE address=?").get(address);
    if (!row) throw new Error("Unknown account");
    return JSON.parse(row.body);
  }
  putAccount(a: Account) {
    this.db.query("INSERT OR REPLACE INTO accounts VALUES(?,?)").run(a.input.address, JSON.stringify(a));
  }
  health(address: string): AccountHealth {
    const row = this.db.query<{ body: string }, [string]>("SELECT body FROM account_health WHERE address=?").get(address);
    return row ? JSON.parse(row.body) : { lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null,
      consecutiveFailures: 0, totalFailures: 0, quarantinedUntil: 0, lastError: null };
  }
  healthMap(): Map<string, AccountHealth> {
    return new Map(this.db.query<{ address: string; body: string }, []>("SELECT address,body FROM account_health").all().map(r => [r.address, JSON.parse(r.body)]));
  }
  accountAttempt(address: string, owner: string, now: number, outcome?: { success: true } | { error: string }): AccountHealth {
    return this.db.transaction(() => {
      this.assertOwner(owner, now);
      const health = this.health(address); health.lastAttemptAt = now;
      if (outcome && "success" in outcome) {
        health.lastSuccessAt = now; health.consecutiveFailures = 0; health.quarantinedUntil = 0; health.lastError = null;
      } else if (outcome && "error" in outcome) {
        health.lastFailureAt = now; health.consecutiveFailures++; health.totalFailures++; health.lastError = outcome.error.slice(0, 240);
        if (health.consecutiveFailures >= 2) health.quarantinedUntil = now + Math.min(6 * 3_600_000, 1_800_000 * 2 ** Math.min(4, health.consecutiveFailures - 2));
      }
      this.db.query("INSERT OR REPLACE INTO account_health VALUES(?,?)").run(address, JSON.stringify(health));
      return health;
    })();
  }
  seed(accounts: Account[], provenance: unknown) {
    this.db.transaction(() => {
      if (this.state("seed")) throw new Error("Registry already seeded; use a new database");
      for (const a of accounts) this.putAccount(a);
      this.setState("seed", provenance);
    })();
  }
  run(id: string): Run | null {
    const row = this.db.query<{ body: string }, [string]>("SELECT body FROM runs WHERE id=?").get(id);
    return row ? JSON.parse(row.body) : null;
  }
  runs(limit = 20): Run[] {
    return this.db.query<{ body: string }, [number]>("SELECT body FROM runs ORDER BY bucket DESC LIMIT ?").all(limit).map(r => JSON.parse(r.body));
  }
  saveRun(run: Run) {
    this.db.query("INSERT OR REPLACE INTO runs VALUES(?,?,?)").run(run.id, run.bucket, JSON.stringify(run));
  }
  enqueue(bucket: number, selected: Selection[], now: number): Run {
    if (bucket !== bucketAt(bucket) || bucket > now || now - bucket >= INTERVAL_MS) throw new Error("Trigger outside current ten-minute bucket");
    return this.db.transaction(() => {
      const id = runIdAt(bucket), existing = this.run(id);
      if (existing) return existing;
      if (selected.length !== TARGET_COUNT || new Set(selected.map(s => s.address)).size !== TARGET_COUNT) throw new Error("Exactly 100 distinct ranked accounts required");
      const run: Run = { id, bucket, selected, status: "queued", startedAt: null, finishedAt: null, attempts: 0, error: null, artifactHash: null };
      this.saveRun(run);
      return run;
    })();
  }
  claim(now: number, ttl = 90_000): string | null {
    return this.db.transaction(() => {
      const lease = this.db.query<{ expires: number }, []>("SELECT expires FROM lease WHERE id=1").get();
      if (lease && lease.expires > now) return null;
      const owner = randomUUID();
      this.db.query("INSERT OR REPLACE INTO lease VALUES(1,?,?)").run(owner, now + ttl);
      return owner;
    })();
  }
  assertOwner(owner: string, now: number) {
    const lease = this.db.query<{ owner: string; expires: number }, []>("SELECT owner,expires FROM lease WHERE id=1").get();
    if (!lease || lease.owner !== owner || lease.expires <= now) throw new Error("Worker lease lost");
  }
  renew(owner: string, now: number) {
    this.assertOwner(owner, now);
    this.db.query("UPDATE lease SET expires=? WHERE id=1 AND owner=?").run(now + 90_000, owner);
  }
  release(owner: string) { this.db.query("DELETE FROM lease WHERE owner=?").run(owner); }
  records<T>(runId: string): Map<string, T> {
    return new Map(this.db.query<{ address: string; body: string }, [string]>("SELECT address,body FROM records WHERE run_id=?").all(runId).map(r => [r.address, JSON.parse(r.body)]));
  }
  saveRecord(runId: string, address: string, record: unknown, owner: string, now: number) {
    this.db.transaction(() => {
      this.assertOwner(owner, now);
      this.db.query("INSERT OR REPLACE INTO records VALUES(?,?,?)").run(runId, address, JSON.stringify(record));
    })();
  }
  publish(run: Run, accounts: Account[], artifact: unknown, next: Selection[], owner: string, now: number): string {
    return this.db.transaction(() => {
      this.assertOwner(owner, now);
      const latest = this.state<{ bucket: number }>("latest");
      if (latest && latest.bucket >= run.bucket) throw new Error("Publication must advance monotonically");
      if (run.bucket > now || now - run.bucket > INTERVAL_MS * 2) throw new Error("Invalid publication bucket");
      if (next.length !== TARGET_COUNT || new Set(next.map(a => a.address)).size !== TARGET_COUNT
        || next.some(a => a.basis !== "verified-input" || !Number.isFinite(a.score))) throw new Error("Invalid next strict selection");
      const effective = run.effectiveSelection ?? run.selected;
      if (effective.length !== TARGET_COUNT || new Set(effective.map(s => s.address)).size !== TARGET_COUNT
        || accounts.length !== TARGET_COUNT || new Set(accounts.map(a => a.input.address)).size !== TARGET_COUNT
        || accounts.some(a => !effective.some(s => s.address === a.input.address))) throw new Error("Incomplete batch cannot publish");
      const replay = run.selected.map(s => s.address);
      for (const change of run.substitutions ?? []) {
        if (replay[change.slot] !== change.from || replay.includes(change.to) || !change.reason || !/^[a-f0-9]{64}$/.test(change.rankingSha256)) throw new Error("Invalid substitution audit");
        replay[change.slot] = change.to;
      }
      if (replay.some((address, i) => address !== effective[i].address)) throw new Error("Effective selection lacks a substitution audit");
      if (accounts.some(a => !Number.isFinite(Date.parse(a.fetchedAt)) || Date.parse(a.fetchedAt) > now
        || now - Date.parse(a.fetchedAt) > 540_000)) throw new Error("Invalid publication freshness");
      for (const a of accounts) { this.raw(a.rawHash); this.putAccount(a); }
      const hash = this.blob(JSON.stringify(artifact));
      const receiptHash = this.blob(JSON.stringify({ schema: "ingest-cycle-receipt.v1", runId: run.id,
        bucket: run.bucket, completedAt: now, count: accounts.length, scoreLabel: "STRICT_REPOSITORY_SCORE", allowUnknown: [],
        artifactHash: hash, selected: effective.map(s => s.address), originalSelection: run.selected.map(s => s.address),
        effectiveSelection: effective.map(s => s.address), substitutions: run.substitutions ?? [], next: next.map(s => s.address),
        oldestFetchedAt: Math.min(...accounts.map(a => Date.parse(a.fetchedAt))) }));
      this.saveRun({ ...run, status: "complete", finishedAt: now, artifactHash: hash, error: null });
      this.setState(`published:${hash}`, { runId: run.id });
      this.setState(`receipt:${receiptHash}`, { runId: run.id });
      const publication = { runId: run.id, bucket: run.bucket, completedAt: now, artifactHash: hash, receiptHash, count: accounts.length };
      this.setState(`publication:${run.id}`, publication);
      this.setState("latest", publication);
      this.setState("selection", { generatedAt: now, sourceRun: run.id, selected: next });
      // An explicitly resumed successful batch also completes catch-up; it must
      // not leave the scheduler gated by an obsolete earlier failure marker.
      if (this.state("foregroundNeedsRefresh")) {
        this.setState("foregroundNeedsRefresh", null);
        this.setState("bootstrapComplete", { at: now, ready: true, selected: TARGET_COUNT, sourceRun: run.id });
      }
      return hash;
    })();
  }
  // Reserve worst-case response weight, then refund only after observing a valid
  // response. Reservations survive crashes and serialize callers on this DB.
  reserve(scope: string, weight: number, capacity: number, now: number): { id: number; wait: number } {
    if (weight > capacity || weight < 1) throw new Error("Invalid request budget");
    return this.db.transaction(() => {
      this.db.query("DELETE FROM budget WHERE at<=?").run(now - 60_000);
      const rows = this.db.query<{ at: number; weight: number }, [string]>("SELECT at,weight FROM budget WHERE scope=? ORDER BY at").all(scope);
      let total = rows.reduce((n, r) => n + r.weight, 0);
      for (const row of rows) {
        if (total + weight <= capacity) break;
        total -= row.weight;
        if (total + weight <= capacity) return { id: 0, wait: Math.max(1, row.at + 60_001 - now) };
      }
      const result = this.db.query("INSERT INTO budget(scope,at,weight) VALUES(?,?,?)").run(scope, now, weight);
      return { id: Number(result.lastInsertRowid), wait: 0 };
    })();
  }
  refund(id: number, actual: number) { this.db.query("UPDATE budget SET weight=MIN(weight,?) WHERE id=?").run(actual, id); }
}
