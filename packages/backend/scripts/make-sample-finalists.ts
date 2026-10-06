import { parsePortfolio, scoreCandidates, type ScoreInput } from "../src/score";
import type { FinalistLike } from "../../shared/parrot-intent";
import sample from "../test/fixtures/score/portfolio-sample.json";

export const makeSampleFinalists = (): FinalistLike[] => {
  const inputs: ScoreInput[] = sample.map((entry) => ({
    address: entry.id,
    kind: "trader",
    accountValue: entry.accountValue,
    closed: entry.closed,
    tradeCount: entry.tradeCount,
    history: null,
    ...parsePortfolio(entry.portfolio),
  }));
  // Keep ranked candidates, including clones, so each intent can choose its own shortlist.
  return scoreCandidates(inputs, { allowUnknown: ["minTrades"] }).candidates
    .filter((candidate) => candidate.rank !== null)
    .map((candidate) => ({
      address: candidate.address,
      kind: candidate.kind,
      score: candidate.score,
      flags: candidate.metrics!.flags,
      maxDrawdown: candidate.metrics!.maxDrawdown,
      annualisedVol: candidate.metrics!.annualisedVol,
      cloneOf: candidate.cloneOf !== null,
    }));
};

if (import.meta.main) {
  await Bun.write(new URL("../fixtures/sample-finalists.json", import.meta.url), `${JSON.stringify(makeSampleFinalists(), null, 2)}\n`);
}
