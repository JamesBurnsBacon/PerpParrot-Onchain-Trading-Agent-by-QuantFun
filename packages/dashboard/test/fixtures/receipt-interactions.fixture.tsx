import assert from "node:assert/strict";
import { mock } from "bun:test";
mock.module("../../components/parrot/ParrotEffects", () => ({ useParrotEffects: () => null }));
import { hookHost, fakeClock, nodes } from "./receipt-hook-host";
import { row } from "./receipt-data";
const host = hookHost(), clock = fakeClock();
const { CompactReceipt } = await import("../../components/parrot/CompactReceipt");
const { DecisionsDrawer } = await import("../../components/parrot/DecisionsDrawer");
let latest = row(), status: "ready" | "paused" = "ready", active = true;
const render = () => { const tree = host.render(() => CompactReceipt({ active, status, rows: [latest, row(1)], latest, calls: 2, cost: .0001 })); host.effects(); return tree; };
let tree = render();
const announced = () => nodes(render()).find(n => n.props?.["aria-live"] === "polite")?.props.children;
clock.advance(0); assert(announced().includes("MATCHES"));
latest = row(2, "contradicted", .03); render(); clock.advance(1499); assert(!announced().includes(latest.claim));
clock.advance(1); assert(announced().includes(latest.claim));
latest = row(3, "faithful", 1, .1); render(); clock.advance(1500); assert(!announced().includes(latest.claim), "banter is not announced");
latest = row(4); render(); status = "paused"; render(); clock.advance(1500); assert(!announced().includes(latest.claim), "pause cancels pending stamp announcement");
status = "ready"; tree = render();
for (const className of ["compact-receipt-row", "compact-receipt-header"]) {
  const opener = { isConnected: true, focus() {} };
  nodes(tree).find(n => n.props?.className === className).props.onClick({ currentTarget: opener });
  tree = render();
  const drawer = nodes(tree).find(n => n.type === DecisionsDrawer);
  assert.equal(drawer.props.initial.id, latest.id); assert.equal(drawer.props.opener, opener);
  drawer.props.onClose(); tree = render(); assert(!nodes(tree).some(n => n.type === DecisionsDrawer));
}
active = false; assert.equal(render(), null); host.unmount(); assert.equal(clock.pending(), 0);
// Exercise the actual dialog handlers with a minimal native-dialog host contract.
// showModal supplies Tab containment/Escape in browsers; this host verifies delegation, not browser focus behavior.
for (const mode of ["close", "escape", "unmount"]) {
  let focus = "opener", shows = 0, closes = 0, dismissed = 0;
  const opener = { isConnected: true, focus() { focus = "opener"; } } as HTMLButtonElement;
  let rows = [row(3), row(2, "faithful", .24), row(1, "faithful", 1, .1)];
  let dialogTree: any;
  const native = {
    open: false,
    showModal() { this.open = true; shows++; focus = "close"; },
    close() { if (!this.open) return; this.open = false; closes++; dialogTree.props.onClose(); },
  };
  const draw = () => {
    dialogTree = host.render(() => DecisionsDrawer({ rows, initial: rows[0], calls: 3, cost: .00015, opener, onClose: () => { dismissed++; } }));
    dialogTree.props.ref.current = native; host.effects(); return dialogTree;
  };
  draw(); assert.equal(shows, 1); assert.equal(focus, "close"); assert.equal(dialogTree.type, "dialog");
  assert.equal(dialogTree.props.open, undefined, "must open modally, not via non-modal open attribute");
  assert.equal(dialogTree.props["aria-modal"], "true");
  // Real browsers fire `close` asynchronously: after a StrictMode effect replay the event arrives while the dialog is open again and must not dismiss it.
  native.open = true; dialogTree.props.onClose(); assert.equal(dismissed, 0, "a stale close event while open must be ignored");
  const select = nodes(dialogTree).find(n => n.type === "select"); select.props.onChange({ target: { value: "1" } }); draw();
  assert.equal(nodes(dialogTree).find(n => n.props?.label === "The claim").props.text, row(1).claim);
  rows = [row(4), ...rows]; draw(); assert.equal(shows, 1, "new speech never reopens the modal or changes selection");
  assert.equal(nodes(dialogTree).find(n => n.type === "select").props.value, 1);
  if (mode === "close") nodes(dialogTree).find(n => n.type === "button").props.onClick();
  if (mode === "escape") { assert.equal(dialogTree.props.onCancel, undefined, "native Escape is not prevented"); native.close(); }
  host.unmount(); assert.equal(closes, 1); assert.equal(dismissed, 1); assert.equal(focus, "opener");
}
console.log("receipt interactions GREEN: modal contract, both openers, close/Escape cleanup, focus return, stable selection, throttled stamped-only announcements");
