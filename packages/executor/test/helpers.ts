import type { Hex } from "viem";
import type { Targets } from "../src/targets";

export const CONFIGURATION = `0x${"ab".repeat(32)}` as Hex;
export const ACCOUNT = "0x2222222222222222222222222222222222222222" as Hex;
export const AS_OF = 1_791_264_000;

// The backend's targets for a run (GET /targets/:runAt).
export const targets = (overrides: Partial<Targets> = {}): Targets => {
  const runAt = overrides.runAt ?? AS_OF;
  return {
    runId: `mirror-${runAt}`,
    runAt,
    snapshotHash: `0x${"cd".repeat(32)}`,
    configurationHash: CONFIGURATION,
    account: ACCOUNT,
    // At $400 equity: BTC +$1,200, ETH −$350.
    exposures: [
      { asset: "BTC", exposureE9: 3_000_000_000n },
      { asset: "ETH", exposureE9: -875_000_000n },
    ],
    pendingCloses: [],
    ...overrides,
  };
};
