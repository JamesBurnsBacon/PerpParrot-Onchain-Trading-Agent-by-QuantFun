import { checkFrozenManifest, type Manifest } from "../../shared/manifest";
import { keccakUtf8 } from "./snapshot";

// Where the frozen live manifest comes from. A JSON file for now (the review
// core's output, frozen at go-live); a Supabase `buckets` read once connected.
export interface ManifestSource {
  load(nowMs: number): Promise<Manifest>;
}

export class FileManifestSource implements ManifestSource {
  constructor(
    private readonly path: string,
    private readonly frozenHash: string,
  ) {}

  async load(nowMs: number): Promise<Manifest> {
    const manifest = (await Bun.file(this.path).json()) as Manifest;
    // Fail here rather than serve a snapshot every DON node would reject.
    checkFrozenManifest(keccakUtf8, manifest, nowMs, this.frozenHash);
    return manifest;
  }
}
