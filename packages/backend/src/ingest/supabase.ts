import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { Fetcher } from "./client";
import type { DbRow, Table } from "./sync-snapshot";
import type { IngestRemote } from "./sync";

export const PROJECT_REF = "clheeepphmomkymawsfq";
export const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
export const BUCKET = "perpparrot-ingest";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function connectionConfig(env: Record<string, string | undefined>) {
  const url = (env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_SECRET_KEY ?? "").trim();
  if (url !== PROJECT_URL) throw new Error("SUPABASE_URL must match the confirmed PerpParrot project");
  if (!key.startsWith("sb_secret_") || key.length < 25 || /\s/.test(key)) {
    throw new Error("Set a Supabase Secret key in the backend .env file (SUPABASE_SECRET_KEY)");
  }
  return { url, key };
}

function failure(action: string, error: unknown): Error {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const safeCode = /^[A-Za-z0-9_]{1,24}$/.test(code) ? ` (${code})` : "";
  // Never include server response bodies, request headers or credentials in logs.
  return new Error(`Supabase ${action} failed${safeCode}`);
}

export class SupabaseRemote implements IngestRemote {
  private readonly client: SupabaseClient;
  constructor(config: { url: string; key: string }, fetcher: Fetcher = fetch) {
    const transport: Fetcher = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== PROJECT_URL) throw new Error("Refusing to send credentials outside the confirmed project");
      const headers = new Headers(init?.headers);
      // New secret keys go in apikey only, never in Authorization: Bearer.
      if (headers.get("authorization") === `Bearer ${config.key}`) headers.delete("authorization");
      const signals = [AbortSignal.timeout(120000), ...(init?.signal ? [init.signal] : [])];
      try {
        return await fetcher(input, { ...init, headers, redirect: "error", signal: AbortSignal.any(signals) });
      } catch { throw new Error("Supabase network request failed"); }
    };
    this.client = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: Object.assign(transport, { preconnect: fetch.preconnect }) },
    });
  }

  async ensureBucket() {
    let { data, error } = await this.client.storage.getBucket(BUCKET);
    if (error && (String(error.statusCode) === "404" || error.message === "Bucket not found")) {
      const created = await this.client.storage.createBucket(BUCKET, {
        public: false, fileSizeLimit: 50 * 1024 * 1024, allowedMimeTypes: ["application/gzip"],
      });
      if (created.error) throw failure("create private bucket", created.error);
      ({ data, error } = await this.client.storage.getBucket(BUCKET));
    }
    if (error || !data) throw failure("read private bucket", error);
    if (data.public) throw new Error("Ingest bucket is public; refusing to upload");
  }

  async putObject(path: string, bytes: Uint8Array) {
    const { error } = await this.client.storage.from(BUCKET).upload(path, Buffer.from(bytes), {
      contentType: "application/gzip", upsert: false,
    });
    if (error && !["409", "Duplicate"].includes(String(error.statusCode)) && error.message !== "The resource already exists") {
      throw failure("upload snapshot", error);
    }
    const downloaded = await this.client.storage.from(BUCKET).download(path);
    if (downloaded.error || !downloaded.data) throw failure("read back snapshot", downloaded.error);
    if (sha(new Uint8Array(await downloaded.data.arrayBuffer())) !== sha(bytes)) throw new Error("Stored snapshot hash mismatch");
  }

  async insert(table: Table, rows: DbRow[], conflict: string) {
    const { error } = await this.client.from(table).upsert(rows, { onConflict: conflict, ignoreDuplicates: true });
    if (error) throw failure(`write ${table}`, error);
  }

  async read(table: Table, runId: string): Promise<DbRow[]> {
    const key = table === "ingest_runs" ? "run_id" : table === "ingest_sources" ? "name" : "address";
    const result: DbRow[] = [];
    for (let offset = 0; offset < 100000; offset += 1000) {
      const { data, error } = await this.client.from(table).select("*").eq("run_id", runId)
        .order(key).range(offset, offset + 999);
      if (error || !data) throw failure(`read ${table}; check migration and backend key`, error);
      result.push(...data);
      if (data.length < 1000) return result;
    }
    throw new Error("Remote snapshot exceeds readback limit");
  }

  async finish(runId: string) {
    const { error } = await this.client.from("ingest_runs")
      .update({ sync_status: "complete", synced_at: new Date().toISOString() }).eq("run_id", runId);
    if (error) throw failure("finalize snapshot", error);
  }
}
