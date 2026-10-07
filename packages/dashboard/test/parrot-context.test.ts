import { expect, test } from "bun:test";
import { isLiveStrategy, liveAsChat } from "../lib/parrot-live";
import { PARROT_PRESETS } from "../lib/parrot-presets";
import { updateWalletBoard } from "../lib/wallet-board";
import type { LiveContext } from "../../shared/live-context";

const context: LiveContext = { facts: ["Facts."], compare: { total: 5, existing: 2, new: 3 },
  paper: [{ bookId: "aggressive-470", label: "aggressive-470", returnPct: 4.2, days: 12 }],
  book: { gross: 1.8, top: [{ asset: "ETH", fraction: .9 }] } };
const chat = PARROT_PRESETS[0].chat;
const response = { ...chat, evidence: chat.shortlist.addresses.map(address => ({ address, rank: 1, maxDrawdown: .1, realizedVol: .2, tags: [] })), facts: "Facts.", context };

test("optional context survives the live conversion and board state update", () => {
  expect(isLiveStrategy(response)).toBe(true);
  const converted = liveAsChat(response);
  expect(converted.context).toEqual(context);
  expect(updateWalletBoard({ chat, before: [], ghosts: [], epoch: 0, labels: false }, converted, 0).chat.context).toEqual(context);
  expect(isLiveStrategy({ ...response, context: undefined })).toBe(true);
  expect(isLiveStrategy({ ...response, context: { facts: [] } })).toBe(true);
  expect(PARROT_PRESETS.every(p => p.chat.context === undefined)).toBe(true);
});

test("context rejects malformed, oversized, unknown, and nonfinite fields", () => {
  const invalid = [null, [], {}, { ...context, extra: true }, { ...context, facts: [42] },
    { ...context, facts: ["x".repeat(301)] }, { ...context, facts: Array(6).fill("x") }, { ...context, facts: Array(5).fill("x".repeat(250)) },
    { ...context, compare: { total: 5, existing: 2, new: 4 } }, { ...context, compare: { total: 26, existing: 26, new: 0 } },
    { ...context, compare: { total: 5, existing: 2, new: 3, extra: 0 } },
    ...[NaN, Infinity, -1, 1.5, "5"].map(total => ({ ...context, compare: { total, existing: 0, new: total } })),
    { ...context, paper: Array(4).fill(context.paper![0]) }, { ...context, paper: [context.paper![0], context.paper![0]] },
    ...["bookId", "label"].map(key => ({ ...context, paper: [{ ...context.paper![0], [key]: "x".repeat(41) }] })),
    ...["returnPct", "days"].flatMap(key => [NaN, Infinity, null, "1"].map(value => ({ ...context, paper: [{ ...context.paper![0], [key]: value }] }))),
    { ...context, paper: [{ ...context.paper![0], days: -1 }] }, { ...context, paper: [{ ...context.paper![0], extra: true }] },
    ...[NaN, Infinity, -1, null].map(gross => ({ ...context, book: { ...context.book, gross } })),
    { ...context, book: { ...context.book, extra: true } }, { ...context, book: { gross: 1, top: Array(4).fill({ asset: "ETH", fraction: 1 }) } },
    ...[{ asset: "x".repeat(33), fraction: 1 }, { asset: "ETH", fraction: Infinity }, { asset: "ETH", fraction: 1, extra: true }]
      .map(e => ({ ...context, book: { gross: 1, top: [e] } })),
  ];
  for (const bad of invalid) expect(isLiveStrategy({ ...response, context: bad })).toBe(false);
});
