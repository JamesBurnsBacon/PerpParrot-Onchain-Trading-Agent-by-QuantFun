import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, digest, eventSchema, envelopeSchema, runId, type Event, type Envelope } from './contracts.ts';

// A durable single-host orchestrator. No SDK, chain, exchange or signing dependency.
export class Simulator {
  readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), {recursive: true});
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,event TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS stages(run_id TEXT,stage TEXT,input_hash TEXT NOT NULL,artifact TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(run_id,stage));
      CREATE TABLE IF NOT EXISTS locks(id TEXT PRIMARY KEY,pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,stage TEXT,kind TEXT,at INTEGER);`);
  }
  close() {this.db.close();}
  async run(event: Event, work: (run: Run) => Promise<void>, options: {failAfter?: string} = {}) {
    eventSchema.parse(event);
    if (event.trigger === 'TICK' && (event.bucketMs > Date.now() || Date.now() - event.bucketMs > 1_200_000)) throw new Error('TICK_CLOCK_OUT_OF_RANGE');
    const id = runId(event), lockId = event.schemaVersion;
    this.db.transaction(() => {
      const owner = this.db.query('SELECT pid FROM locks WHERE id=?').get(lockId) as {pid: number} | null;
      if (owner) {
        let alive = true;
        try {process.kill(owner.pid, 0);} catch (e: any) {if (e.code === 'ESRCH') alive = false; else throw e;}
        if (alive) throw new Error('RUN_BUSY');
        this.db.query('DELETE FROM locks WHERE id=?').run(lockId);
      }
      this.db.query('INSERT INTO locks VALUES(?,?)').run(lockId, process.pid);
      this.db.query("INSERT OR IGNORE INTO runs VALUES(?,?,'PENDING',NULL)").run(id, canonical(event));
      const saved = this.db.query('SELECT event FROM runs WHERE id=?').get(id) as {event: string};
      if (saved.event !== canonical(event)) throw new Error('EVENT_CONFLICT');
      this.db.query("UPDATE runs SET status='RUNNING',error=NULL WHERE id=?").run(id);
    })();
    const run = new Run(this.db, id, options.failAfter);
    try {
      await work(run);
      this.db.query("UPDATE runs SET status='SUCCEEDED',error=NULL WHERE id=?").run(id);
      return {schemaVersion: 'night-receipt.v1', runId: id, status: 'SUCCEEDED', economicAuthority: false,
        steps: run.steps, artifactChainHash: digest(run.steps.map(x => ({stage: x.stage, bodyHash: x.bodyHash})))};
    } catch (error) {
      this.db.query("UPDATE runs SET status='FAILED',error=? WHERE id=?").run(String(error), id);
      throw error;
    } finally {this.db.query('DELETE FROM locks WHERE id=? AND pid=?').run(lockId, process.pid);}
  }
}

export class Run {
  steps: {stage: string; bodyHash: string; reused: boolean}[] = [];
  constructor(private db: Database, readonly id: string, private failAfter?: string) {}
  async step<T>(stage: string, input: unknown, handler: (signal: AbortSignal) => Promise<T>,
    validate: (body: unknown) => T, options: {timeoutMs?: number; retryTransient?: number} = {}): Promise<T> {
    if (!/^[a-z][a-z0-9-]{0,50}$/.test(stage) || this.steps.length >= 20 || this.steps.some(s => s.stage === stage)) throw new Error('INVALID_STAGE');
    if (!Number.isInteger(options.timeoutMs ?? 60_000) || (options.timeoutMs ?? 60_000) < 1 || (options.timeoutMs ?? 60_000) > 60_000 ||
      !Number.isInteger(options.retryTransient ?? 0) || (options.retryTransient ?? 0) < 0 || (options.retryTransient ?? 0) > 3) throw new Error('INVALID_STAGE_LIMITS');
    const inputHash = digest(input);
    const saved = this.db.query('SELECT * FROM stages WHERE run_id=? AND stage=?').get(this.id, stage) as {input_hash: string; artifact: string | null} | null;
    if (saved && saved.input_hash !== inputHash) throw new Error('STAGE_INPUT_CONFLICT');
    if (saved?.artifact) {
      const e = envelopeSchema.parse(JSON.parse(saved.artifact));
      if (e.runId !== this.id || e.stage !== stage || e.inputHash !== inputHash || digest(e.body) !== e.bodyHash) throw new Error('CORRUPT_CHECKPOINT');
      const value = validate(e.body); this.steps.push({stage, bodyHash: e.bodyHash, reused: true}); return value;
    }
    this.db.query('INSERT OR IGNORE INTO stages(run_id,stage,input_hash) VALUES(?,?,?)').run(this.id, stage, inputHash);
    for (let attempt = 0; ; attempt++) {
      this.db.query('UPDATE stages SET attempts=attempts+1 WHERE run_id=? AND stage=?').run(this.id, stage);
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([handler(controller.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => {controller.abort(); reject(new Error('STAGE_TIMEOUT'));}, options.timeoutMs ?? 60_000);
        })]);
        const body = validate(raw), bodyHash = digest(body);
        const e: Envelope = {schemaVersion: 'night-artifact.v1',runId:this.id,stage,inputHash,bodyHash,economicAuthority:false,body};
        this.db.transaction(() => {
          this.db.query('UPDATE stages SET artifact=?,error=NULL WHERE run_id=? AND stage=?').run(canonical(e), this.id, stage);
          this.db.query('INSERT INTO events(run_id,stage,kind,at) VALUES(?,?,?,?)').run(this.id, stage, 'COMMITTED', Date.now());
        })();
        this.steps.push({stage,bodyHash,reused:false});
        if (this.failAfter === stage) throw new Error('INJECTED_FAILURE_AFTER_COMMIT');
        return body;
      } catch (error) {
        this.db.query('UPDATE stages SET error=? WHERE run_id=? AND stage=?').run(String(error), this.id, stage);
        if (!(error instanceof TransientError) || attempt >= (options.retryTransient ?? 0)) throw error;
      } finally {if (timer) clearTimeout(timer); controller.abort();}
    }
  }
}
export class TransientError extends Error {}
