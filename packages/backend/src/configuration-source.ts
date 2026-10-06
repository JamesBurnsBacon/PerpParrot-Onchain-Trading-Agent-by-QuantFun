import { checkFrozenConfiguration, type FrozenConfiguration } from "../../shared/frozen";
import { keccakUtf8 } from "./snapshot";

// Where the frozen configuration comes from: a JSON file for now (the review core's
// freeze output); a Supabase read once connected.
export interface ConfigurationSource {
  load(nowMs: number): Promise<FrozenConfiguration>;
}

export class FileConfigurationSource implements ConfigurationSource {
  constructor(
    private readonly path: string,
    private readonly pinnedHash: string,
  ) {}

  async load(nowMs: number): Promise<FrozenConfiguration> {
    const configuration = (await Bun.file(this.path).json()) as FrozenConfiguration;
    // Fail here rather than serve a snapshot every DON node would reject.
    checkFrozenConfiguration(keccakUtf8, configuration, this.pinnedHash, nowMs);
    return configuration;
  }
}
