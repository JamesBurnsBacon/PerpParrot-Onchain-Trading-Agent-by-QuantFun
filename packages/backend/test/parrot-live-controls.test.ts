import { expect, test } from "bun:test";

// Runtime import keeps the backend typecheck independent of dashboard JSX settings.
const { LiveTalk } = await import(new URL("../../dashboard/components/parrot/LiveTalk.tsx", import.meta.url).href);

test("live connecting offers an enabled Cancel button that invokes end", () => {
  let ended = 0;
  const tree = LiveTalk({ disabled: true, live: {
    active: true, view: { phase: "connecting", avatar: "thinking", status: "Warming up my voice…" },
    audio: { current: null }, end: () => { ended++; }, start: () => { throw new Error("must cancel"); },
  } });
  const [button, label] = tree.props.children;
  expect(button.props.disabled).toBe(false);
  expect(button.props["aria-label"]).toBe("Cancel connecting");
  expect(label.props.children).toBe("Cancel");
  expect(button.props.children.type).toBe("svg");
  expect(button.props.children.props.children.type).toBe("rect");
  button.props.onClick();
  expect(ended).toBe(1);
});
