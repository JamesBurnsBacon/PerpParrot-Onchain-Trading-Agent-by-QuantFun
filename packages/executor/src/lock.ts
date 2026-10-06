// One run at a time across executor processes (README §4.8). The Runner's queue serializes
// runs inside one process; this covers two processes, e.g. old and new during a deploy, or
// any platform that may run more than one instance. Session-level advisory lock: if the
// holder's connection dies, Postgres releases it.
import type { SQL } from "bun";

export type RunLock = {
  // Resolves with a release function once held; rejects after timeoutMs.
  acquire(timeoutMs: number): Promise<() => Promise<void>>;
};

// One process, no database: the Runner's queue is enough.
export const noLock: RunLock = { acquire: async () => async () => undefined };

// pg_try_advisory_lock key: "PPrun" in ASCII.
const RUN_LOCK_KEY = 0x50_50_72_75_6e;

export const postgresRunLock = (sql: SQL, key = RUN_LOCK_KEY): RunLock => ({
  async acquire(timeoutMs) {
    const conn = await sql.reserve();
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        const [row] = await conn`select pg_try_advisory_lock(${key}) as ok`;
        if (row.ok) break;
        if (Date.now() >= deadline) throw new Error(`another executor process held the run lock for ${Math.round(timeoutMs / 1000)}s`);
        await Bun.sleep(250);
      }
    } catch (e) {
      conn.release();
      throw e;
    }
    return async () => {
      try {
        await conn`select pg_advisory_unlock(${key})`;
      } finally {
        conn.release();
      }
    };
  },
});
