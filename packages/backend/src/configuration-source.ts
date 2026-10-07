import type { SQL } from "bun";
import { checkFrozenConfiguration, type FrozenConfiguration } from "../../shared/frozen";
import { keccakUtf8 } from "./snapshot";

// Where the frozen configuration comes from: the one the pipeline activated in Supabase
// (src/pipeline), else the JSON file the environment pins (the fixture until the first activation).
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
    // Fail here rather than build a snapshot the executor would reject (wrong configuration hash).
    checkFrozenConfiguration(keccakUtf8, configuration, this.pinnedHash, nowMs);
    return configuration;
  }
}

export class ActiveConfigurationSource implements ConfigurationSource {
  constructor(
    private readonly sql: SQL,
    private readonly fallback: ConfigurationSource,
  ) {}

  async load(nowMs: number): Promise<FrozenConfiguration> {
    const [row] = await this.sql`select configuration from configurations where status = 'active'`;
    if (!row) return this.fallback.load(nowMs);
    const configuration = row.configuration as FrozenConfiguration;
    // Self-consistent: the executor checks the targets against the same active hash.
    checkFrozenConfiguration(keccakUtf8, configuration, configuration.configurationHash, nowMs);
    return configuration;
  }
}
