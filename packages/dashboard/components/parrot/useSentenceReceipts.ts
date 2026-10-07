"use client";
import { useEffect, useRef, useState } from "react";
import { createSentenceSplitter } from "../../lib/parrot-sentences";
import { createJudgeQueue, emptyReceiptFeed, type Judge, type ReceiptFeed, type ReceiptRow } from "../../lib/parrot-judge-queue";
import { backendFetch } from "./api";
import type { LiveObservers } from "./useLiveTalk";

const judgeReceipt: Judge = async (claim, facts, signal) => {
  const response = await backendFetch("/decide/receipt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim, facts }), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  return { status: response.status, value: response.ok ? await response.json() : undefined };
};
export type ReceiptStatus = "off" | "ready" | "paused";
type Options = { pauseOnFailure?: boolean; judge?: Judge; now?: () => number; onVerdict?: (row: ReceiptRow) => void; initialFeed?: ReceiptFeed; initialFacts?: string };

// Display-only observer. No audio, storage, or path back into Live/strategy.
export function useSentenceReceipts(options: Options = {}) {
  const opts = useRef(options); opts.current = options;
  const [feed, setFeed] = useState(options.initialFeed ?? emptyReceiptFeed());
  const [facts, setFacts] = useState(options.initialFacts ?? "");
  const [worked, setWorked] = useState(false);
  const [visit, setVisit] = useState({ calls: 0, cost: 0 });
  const [judged, setJudged] = useState<ReceiptRow[]>([]);
  const splitter = useRef(createSentenceSplitter()), queue = useRef<ReturnType<typeof createJudgeQueue> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), mounted = useRef(true);
  function stop() { clearTimeout(timer.current); splitter.current.reset(); queue.current?.stop(); queue.current = null; }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop(); }; }, []);
  function flush() { splitter.current.flush().forEach(sentence => queue.current?.push(sentence)); }
  function begin() {
    stop(); setFacts(""); setFeed(emptyReceiptFeed()); setWorked(false); setJudged([]);
    let previous = emptyReceiptFeed();
    queue.current = createJudgeQueue(opts.current.judge ?? judgeReceipt, (next, row) => {
      if (!mounted.current) return;
      const calls = next.calls - previous.calls, cost = next.cost - previous.cost; previous = next;
      setVisit(v => ({ calls: v.calls + calls, cost: v.cost + cost })); setFeed(next);
      if (row?.decision) {
        setWorked(true);
        setJudged(rows => [row, ...rows.filter(r => r.id !== row.id)].sort((a, b) => b.id - a.id).slice(0, 10));
        opts.current.onVerdict?.(row);
      }
    }, opts.current.now, opts.current.pauseOnFailure ?? true);
  }
  const observers: LiveObservers = {
    onParrotDelta: delta => {
      clearTimeout(timer.current); splitter.current.push(delta).forEach(sentence => queue.current?.push(sentence));
      // Let the following delta attach closing quotes or finish a decimal/address.
      if (/[.!?。！？…\n]["'”’」』）)\]}\s]*$/u.test(delta)) timer.current = setTimeout(flush, 180);
    },
    onStrategyFacts: receipt => { clearTimeout(timer.current); flush(); queue.current?.setFacts(receipt); setFacts(receipt); },
    onEnd: stop,
  };
  const status: ReceiptStatus = !worked ? "off" : feed.paused ? "paused" : "ready";
  // Keep the last ten judged sentences even when a burst evicts them from the feed.
  const rows = [...feed.rows, ...judged.filter(r => !feed.rows.some(f => f.id === r.id))].sort((a, b) => b.id - a.id);
  return { rows, latest: feed.rows[0], calls: visit.calls, cost: visit.cost, status, feed, facts, begin, stop, observers };
}
