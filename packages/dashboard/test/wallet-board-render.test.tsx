import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WalletBoard, WalletTile, WaitingFlock } from "../components/parrot/WalletBoard";
import { ParrotEffectsProvider } from "../components/parrot/ParrotEffects";
import { walletNickname } from "../lib/wallet-board";
import { PARROT_PRESETS } from "../lib/parrot-presets";

test("tile face has one bird and one meter; exact evidence lives in closed details", () => {
  const html = renderToStaticMarkup(<WalletTile address="0x448bbd0cfd9c8aa81c4db28a36edca446d5e3609" evidence={{ address: "0x448bbd0cfd9c8aa81c4db28a36edca446d5e3609", rank: 7, maxDrawdown: .0123, realizedVol: .0043, tags: ["clone-checked"] }} reason="low drawdown" quiet />);
  const face = html.split("</summary>")[0];
  expect(face).toContain(walletNickname("0x448bbd0cfd9c8aa81c4db28a36edca446d5e3609"));
  expect(face).toContain("calm vibe");
  expect(face.match(/<svg/g)).toHaveLength(1);
  expect(face.match(/class="wallet-risk"/g)).toHaveLength(1);
  for (const old of ["SELECTED", "selected", "Score rank", "Drawdown", "Volatility", "clone-checked", "low drawdown", "1.23%"])
    expect(face).not.toContain(old);
  expect(html).toContain("<details");
  expect(html).not.toContain(" open=");
  for (const detail of ["Score rank: 7", "Drawdown: 1.23%", "Realized volatility: 0.43%", "clone-checked", "low drawdown"]) expect(html).toContain(detail);
});

test("static changes keep stickers, kept tiles do not roll, and cached evidence stays neutral", () => {
  for (const change of ["new", "removed", undefined] as const) {
    const html = renderToStaticMarkup(<WalletTile address="0xa359fdc22e3828ff99173b42a133515329549883" change={change} quiet />);
    expect(html).toContain(`aria-label="${walletNickname("0xa359fdc22e3828ff99173b42a133515329549883")}, steady vibe${change ? `, ${change}` : ""}"`);
    expect(html).not.toContain("wallet-reel");
    if (change) expect(html).toContain(change === "new" ? "NEW!" : "Bye!");
    else expect(html).not.toContain("wallet-sticker");
    expect(html).toContain("Metrics unavailable");
  }
  expect(renderToStaticMarkup(<WalletTile address="0xa359fdc22e3828ff99173b42a133515329549883" />)).not.toContain("wallet-reel");
  expect(renderToStaticMarkup(<WalletTile address="0xa359fdc22e3828ff99173b42a133515329549883" change="new" />)).toContain("wallet-reel");
});

test("board retains sample provenance, hidden announcements and the short waiting state", () => {
  const html = renderToStaticMarkup(<ParrotEffectsProvider><WalletBoard chat={PARROT_PRESETS[0].chat} /></ParrotEffectsProvider>);
  expect(html).toContain("The Flock");
  expect(html).toContain("SAMPLE DATA");
  expect(html).toContain('class="sr-only" aria-live="polite"');
  expect(html.match(/class="wallet-position wallet-current"/g)).toHaveLength(5);
  const empty = renderToStaticMarkup(<ParrotEffectsProvider><WalletBoard chat={{ ...PARROT_PRESETS[0].chat, shortlist: { dataSource: "sample", addresses: [] } }} /></ParrotEffectsProvider>);
  expect(empty).toContain("Waiting for birds...");
  // Live data carries no badge at all; only sample data is labelled.
  const live = renderToStaticMarkup(<ParrotEffectsProvider><WalletBoard chat={{ ...PARROT_PRESETS[0].chat, shortlist: { ...PARROT_PRESETS[0].chat.shortlist, dataSource: "live" } }} /></ParrotEffectsProvider>);
  expect(live).not.toContain("SAMPLE DATA");
  expect(live).not.toContain("parrot-badge");
  const waiting = renderToStaticMarkup(<WaitingFlock />);
  expect(waiting).toContain("The Flock");
  expect(waiting).not.toContain("SAMPLE DATA"); // nothing is shown yet, so nothing to label
  expect(waiting).toContain("Waiting for birds...");
});

test("expanded details contain the full selectable wrapped address as plain text", () => {
  const address = "0x448bbd0cfd9c8aa81c4db28a36edca446d5e3609";
  const html = renderToStaticMarkup(<WalletTile address={address} quiet />);
  const [face, details] = html.split("</summary>");
  expect(face).toContain("0x448b...3609");
  expect(face).not.toContain(address);
  expect(details).toContain(`<p class="select-text whitespace-normal break-all">${address}</p>`);
  expect(details).not.toMatch(/<a(?:\s|>)/);
});

test("extra evidence appears only when supplied, in tile details", () => {
  const address = PARROT_PRESETS[0].chat.shortlist.addresses[0];
  const base = { address, rank: 1, maxDrawdown: .1, realizedVol: .2, tags: [] };
  for (const extras of [{}, { periodReturn: null, sharpe: null }, { periodReturn: -.1234, sharpe: 0 }]) {
    const html = renderToStaticMarkup(<WalletTile address={address} evidence={{ ...base, ...extras }} quiet />);
    expect(html.split("</summary>")[0]).not.toMatch(/Period return|Sharpe/);
    if (extras.periodReturn != null) {
      expect(html).toContain("Period return: -12.34%");
      expect(html).toContain("Sharpe: 0");
    } else expect(html).not.toMatch(/Period return|Sharpe/);
  }
});

test("context is one plain muted line under the flock, absent for sample or empty context", () => {
  const chat = PARROT_PRESETS[0].chat;
  const render = (context?: import("../../shared/live-context").LiveContext) => renderToStaticMarkup(
    <ParrotEffectsProvider><WalletBoard chat={{ ...chat, context }} /></ParrotEffectsProvider>);
  expect(render()).not.toContain('data-testid="live-context"');
  expect(render({ facts: [] })).not.toContain('data-testid="live-context"');
  const html = render({ facts: [], compare: { total: 8, existing: 3, new: 5 },
    paper: [{ bookId: "aggressive-470", label: "aggressive-470", returnPct: 4.2, days: 12 }], book: { gross: 1.8, top: [] } });
  expect(html).toContain('<p class="mt-2 text-xs text-[var(--muted)]" data-testid="live-context">3 of 8 already in the live book · paper aggressive-470 +4.2% (12d replay) · book gross 1.8x (last snapshot)</p>');
  expect(html.indexOf('data-testid="live-context"')).toBeGreaterThan(html.indexOf('class="wallet-grid"'));
  const escaped = render({ facts: [], paper: [{ bookId: "id", label: "<script>alert(1)</script>", returnPct: 0, days: 1 }] });
  expect(escaped).toContain("&lt;script&gt;"); expect(escaped).not.toContain("<script>");
});
