import type { Kind } from "../score";

export type ScreenedAccount = { address: string; kind: Kind };
export type ScreenedCohort = {
  schema: "research-screen.v1.regular";
  screenedAt: string;
  policyHash: string;
  count: number;
  accounts: ScreenedAccount[];
};

const fixture = new URL("../../fixtures/regular-screened-cohort-20261006.json", import.meta.url);

export const validateScreenedCohort = (value: ScreenedCohort): ScreenedCohort => {
  if (value.schema !== "research-screen.v1.regular" || !Number.isSafeInteger(value.count) ||
      !Array.isArray(value.accounts) || value.accounts.length !== value.count ||
      !Number.isFinite(Date.parse(value.screenedAt)) || !value.policyHash) {
    throw new Error("invalid regular-screened cohort metadata");
  }
  const seen = new Set<string>();
  for (const account of value.accounts) {
    if (!/^0x[0-9a-f]{40}$/.test(account.address) ||
        !["trader", "hypercore-vault", "erc4626-vault"].includes(account.kind) || seen.has(account.address)) {
      throw new Error("invalid or duplicate regular-screened account");
    }
    seen.add(account.address);
  }
  return value;
};

export const loadScreenedCohort = async (): Promise<ScreenedCohort> =>
  validateScreenedCohort(await Bun.file(fixture).json() as ScreenedCohort);
