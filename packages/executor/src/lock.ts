// One run at a time across executor processes (README §4.8). The Runner's queue serializes
// runs inside one process; this covers two processes, e.g. old and new during a deploy, or
// any platform that may run more than one instance. Session-level advisory lock: if the
// holder's connection dies, Postgres releases it. Bun's pool closes a reserved connection that
// sits idle past the pool's idleTimeout (5 s on Vercel), even while it is reserved, so the holder
// pings it while the run works.
import type { SQL } from "bun";

export type RunLock = {
  // Resolves with a release function once held; rejects after timeoutMs.
  acquire(timeoutMs: number): Promise<() => Promise<void>>;
};

// One process, no database: the Runner's queue is enough.
export const noLock: RunLock = { acquire: async () => async () => undefined };

// pg_try_advisory_lock key: "PPrun" in ASCII.
const RUN_LOCK_KEY = 0x50_50_72_75_6e;

export const postgresRunLock = (sql: SQL, key = RUN_LOCK_KEY, keepAliveMs = 2000): RunLock => ({
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
    const keepAlive = setInterval(() => void conn`select 1`.catch(() => clearInterval(keepAlive)), keepAliveMs);
    keepAlive.unref?.();
    return async () => {
      clearInterval(keepAlive);
      try {
        await conn`select pg_advisory_unlock(${key})`;
      } catch {
        // A connection back in the pool would keep holding the lock, and every later run would
        // time out on it. Closing ends the session, so Postgres releases the lock.
        await conn.close().catch(() => undefined);
        return;
      }
      conn.release();
    };
  },
});
