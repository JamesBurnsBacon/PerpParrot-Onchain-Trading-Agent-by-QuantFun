import { priority } from "./rank";
import type { Account } from "./store";
declare const self: { onmessage: ((event: MessageEvent<{ accounts: Account[]; now: number }>) => void) | null };
self.onmessage = (event) => {
  try { postMessage({ selected: priority(event.data.accounts, event.data.now) }); }
  catch (error) { postMessage({ error: String(error) }); }
};
