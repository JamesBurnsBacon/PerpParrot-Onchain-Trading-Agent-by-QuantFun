import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WalletBoard, WalletTile, WaitingFlock } from "../components/parrot/WalletBoard";
import { ParrotEffectsProvider } from "../components/parrot/ParrotEffects";
import { walletNickname } from "../lib/wallet-board";
import { PARROT_PRESETS } from "../lib/parrot-presets";

test("tile face has one bird and one meter; exact evidence lives in closed details", () => {
  const html = renderToStaticMarkup(<WalletTile address="addr-01" evidence={{ address: "addr-01", rank: 7, maxDrawdown: .1234, annualisedVol: .4321, tags: ["clone-checked"] }} reason="low drawdown" quiet />);
  const face = html.split("</summary>")[0];
  expect(face).toContain(walletNickname("addr-01"));
  expect(face).toContain("calm vibe");
  expect(face.match(/<svg/g)).toHaveLength(1);
  expect(face.match(/class="wallet-risk"/g)).toHaveLength(1);
  for (const old of ["SELECTED", "selected", "Score rank", "Drawdown", "Volatility", "clone-checked", "low drawdown", "12.34%"])
    expect(face).not.toContain(old);
  expect(html).toContain("<details");
  expect(html).not.toContain(" open=");
  for (const detail of ["Score rank: 7", "Drawdown: 12.34%", "Volatility: 43.21%", "clone-checked", "low drawdown"]) expect(html).toContain(detail);
});

test("static changes keep stickers, kept tiles do not roll, and cached evidence stays neutral", () => {
  for (const change of ["new", "removed", undefined] as const) {
    const html = renderToStaticMarkup(<WalletTile address="addr-02" change={change} quiet />);
    expect(html).toContain(`aria-label="${walletNickname("addr-02")}, steady vibe${change ? `, ${change}` : ""}"`);
    expect(html).not.toContain("wallet-reel");
    if (change) expect(html).toContain(change === "new" ? "NEW!" : "Bye!");
    else expect(html).not.toContain("wallet-sticker");
    expect(html).toContain("Metrics unavailable");
  }
  expect(renderToStaticMarkup(<WalletTile address="addr-02" />)).not.toContain("wallet-reel");
  expect(renderToStaticMarkup(<WalletTile address="addr-02" change="new" />)).toContain("wallet-reel");
});

test("board retains sample provenance, hidden announcements and the short waiting state", () => {
  const html = renderToStaticMarkup(<ParrotEffectsProvider><WalletBoard chat={PARROT_PRESETS[0].chat} /></ParrotEffectsProvider>);
  expect(html).toContain("The Flock");
  expect(html).toContain("SAMPLE DATA");
  expect(html).toContain('class="sr-only" aria-live="polite"');
  expect(html.match(/class="wallet-position wallet-current"/g)).toHaveLength(5);
  const empty = renderToStaticMarkup(<ParrotEffectsProvider><WalletBoard chat={{ ...PARROT_PRESETS[0].chat, shortlist: { dataSource: "sample", addresses: [] } }} /></ParrotEffectsProvider>);
  expect(empty).toContain("Waiting for birds...");
  const waiting = renderToStaticMarkup(<WaitingFlock />);
  expect(waiting).toContain("The Flock");
  expect(waiting).toContain("SAMPLE DATA");
  expect(waiting).toContain("Waiting for birds...");
});
