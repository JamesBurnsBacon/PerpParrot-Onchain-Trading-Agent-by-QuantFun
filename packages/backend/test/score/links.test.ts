import { describe, expect, test } from "bun:test";
import { scoreCandidates, type ScoreResult } from "../../src/score";
import fixture from "../fixtures/score/links.json";
import { expectOutput, sampleInputs } from "./helpers";

type Projection = Pick<ScoreResult, "finalists" | "funnel"> & {
  candidates: Pick<ScoreResult["candidates"][number], "address" | "rank" | "scoreNumerator" | "cloneOf" | "clones" | "finalist">[];
};

// Compare ranked output from the independent reference (SPEC "Clone grouping").
const project = (result: ScoreResult): Projection => ({
  finalists: result.finalists,
  funnel: result.funnel,
  candidates: result.candidates.filter(({ rank }) => rank !== null)
    .map(({ address, rank, scoreNumerator, cloneOf, clones, finalist }) =>
      ({ address, rank, scoreNumerator, cloneOf, clones, finalist })),
});

const expectProjection = (actual: Projection, expected: Projection): void => {
  expectOutput(actual, expected);
  // Only correlations use tolerance; every other field compares exactly (SPEC "Clone grouping").
  const exact = (value: Projection) => ({
    ...value,
    candidates: value.candidates.map((c) => ({
      ...c,
      cloneOf: c.cloneOf === null ? null : { ...c.cloneOf, correlation: null },
    })),
  });
  expect(exact(actual)).toEqual(exact(expected));
};

describe("link groups (SPEC Clone grouping)", () => {
  for (const scenario of fixture.cases) {
    const links: Record<string, string[] | undefined> = scenario.links;
    const inputs = sampleInputs.map((input) => ({ ...input, links: links[input.address] ?? [] }));

    test(`reference output: ${scenario.name}`, () => {
      const result = scoreCandidates(inputs);
      expectProjection(project(result), scenario.expected as Projection);
      expect(result.correlations.every(({ linked }) => !linked)).toBe(true);
    });

    test(`input order, link case and direction do not matter: ${scenario.name}`, () => {
      const expected = project(scoreCandidates(inputs));
      expectProjection(project(scoreCandidates([...inputs].reverse())), expected);
      expectProjection(project(scoreCandidates(inputs.map((input) => ({
        ...input, links: input.links.map((address) => address.toUpperCase()),
      })))), expected);
      const reversed = sampleInputs.map((input) => ({
        ...input,
        links: inputs.filter((source) => source.links.includes(input.address)).map(({ address }) => address),
      }));
      expectProjection(project(scoreCandidates(reversed)), expected);
    });
  }
});
