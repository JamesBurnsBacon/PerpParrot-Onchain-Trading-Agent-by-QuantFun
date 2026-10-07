import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, type ChatResponse } from "../../lib/parrot";
import { setMicEnabled, functionResultMessages, hasUnfinishedLiveStrategy, initialLiveEvents, isLiveSession, isLiveStrategy, liveAsChat, pendingLiveCalls, reduceLiveEvent, type LiveEvents } from "../../lib/parrot-live";
import { post, type Failure } from "./api";

type Phase = "idle" | "connecting" | "live" | "closing";
type Runtime = {
  controller: AbortController; peer?: RTCPeerConnection; channel?: RTCDataChannel; mic?: MediaStream; muted?: boolean;
  timers: Set<ReturnType<typeof setTimeout>>; events: LiveEvents; closing: boolean; draining: boolean;
  processedCalls: Set<string>; staleNotified?: boolean; deadline?: number;
};
export type LiveView = { phase: Phase; user: string; parrot: string; avatar: "listening" | "speaking" | "thinking"; remaining: number; status: string; failure: Failure | null; playbackBlocked: boolean; muted: boolean };
const idle: LiveView = { phase: "idle", user: "", parrot: "", avatar: "listening", remaining: 0, status: "", failure: null, playbackBlocked: false, muted: false };

export function useLiveTalk(onStrategy: (chat: ChatResponse) => void, onStale: () => void, previousIds: string[] = [], activity?: { gesture: () => void; input: () => void }) {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const shown = useRef(previousIds);
  const activityRef = useRef(activity);
  useEffect(() => { shown.current = previousIds; activityRef.current = activity; }, [previousIds, activity]);
  const [view, setView] = useState<LiveView>(idle);
  const audio = useRef<HTMLAudioElement | null>(null);
  const active = useRef<Runtime | null>(null);
  const callback = useRef(onStrategy);
  const staleCallback = useRef(onStale);
  useEffect(() => { callback.current = onStrategy; staleCallback.current = onStale; }, [onStrategy, onStale]);

  const notifyStale = useCallback((run: Runtime) => {
    if (!run.staleNotified && hasUnfinishedLiveStrategy(run.events, run.processedCalls)) {
      run.staleNotified = true;
      staleCallback.current();
    }
  }, []);

  const cleanup = useCallback((run: Runtime, status?: string, failure: Failure | null = null) => {
    if (active.current !== run) return;
    active.current = null;
    setRemoteStream(null);
    run.controller.abort();
    for (const timer of run.timers) clearTimeout(timer);
    run.mic?.getTracks().forEach(track => track.stop());
    run.channel?.close(); run.peer?.close();
    if (audio.current) { audio.current.pause(); audio.current.srcObject = null; }
    if (status !== undefined) {
      notifyStale(run); // Unmount cleanup deliberately has no page callback.
      setView(v => ({ ...v, phase: "idle", status, failure, playbackBlocked: false, muted: false }));
    }
  }, [notifyStale]);

  const end = useCallback(() => {
    const run = active.current;
    if (!run || run.closing) return;
    if (!run.events.started || run.channel?.readyState !== "open") { cleanup(run, "Conversation canceled."); return; }
    run.closing = true;
    setRemoteStream(null);
    run.mic?.getTracks().forEach(track => track.stop());
    notifyStale(run);
    setView(v => ({ ...v, phase: "closing", status: "Finishing our conversation…" }));
    try { run.channel.send(JSON.stringify({ type: "session.close" })); }
    catch { cleanup(run, "Conversation ended; final usage was not confirmed."); return; }
    run.timers.add(setTimeout(() => cleanup(run, "Conversation ended; final usage was not confirmed."), 15_000));
  }, [cleanup, notifyStale]);

  useEffect(() => {
    const hide = () => {
      if (!document.hidden || !active.current) return;
      const run = active.current;
      end();
      // Visibility loss stops capture immediately, even while final events drain.
      run.mic?.getTracks().forEach(track => track.stop());
      if (audio.current) audio.current.pause();
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      const run = active.current;
      if (run) {
        try { if (run.channel?.readyState === "open") run.channel.send(JSON.stringify({ type: "session.close" })); } catch {}
        cleanup(run);
      }
    };
  }, [cleanup, end]);

  async function start() {
    if (active.current) return;
    activityRef.current?.gesture();
    const run: Runtime = { controller: new AbortController(), timers: new Set(), events: initialLiveEvents(), closing: false, draining: false, processedCalls: new Set() };
    active.current = run;
    setView({ ...idle, phase: "connecting", avatar: "thinking", status: "Warming up my voice…" });
    const current = () => active.current === run && !run.controller.signal.aborted;
    const fail = (status: string, failure: Failure | null = null) => {
      try { if (run.channel?.readyState === "open") run.channel.send(JSON.stringify({ type: "session.close" })); } catch {}
      cleanup(run, status, failure);
    };
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => { run.timers.delete(timer); if (current()) fn(); }, ms);
      run.timers.add(timer); return timer;
    };
    const signal = () => AbortSignal.any([run.controller.signal, AbortSignal.timeout(20_000)]);
    const drain = async () => {
      if (run.draining || run.closing || !current()) return;
      run.draining = true;
      try {
        for (const responseId of run.events.readyResponses) {
          const calls = pendingLiveCalls(run.events, run.processedCalls).filter(c => c.responseId === responseId);
          if (!calls.length) continue;
          const results: { callId: string; output: string }[] = [];
          for (const call of calls) {
            if (!current() || run.closing) return;
            let output = call.error ?? "Strategy could not be checked. Please try again.";
            if (call.args) {
              const result = await post("/live/strategy", { intent: call.args, previous: shown.current }, isLiveStrategy, signal());
              if (!current() || run.closing) return;
              if ("data" in result) {
                if (run.events.calls.at(-1)?.callId === call.callId) {
                  shown.current = result.data.shortlist.addresses;
                  callback.current(liveAsChat(result.data));
                }
                output = result.data.facts;
              }
            }
            run.processedCalls.add(call.callId);
            results.push({ callId: call.callId, output });
          }
          if (current() && !run.closing && run.channel?.readyState === "open") {
            for (const message of functionResultMessages(results, responseId)) run.channel.send(JSON.stringify(message));
          }
        }
      } catch { if (current()) fail(describeError("model_unavailable"), { code: "model_unavailable" }); }
      finally { run.draining = false; }
      if (current() && !run.closing && pendingLiveCalls(run.events, run.processedCalls).length) void drain();
    };
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error("unsupported");
      const startup = later(() => fail("My voice could not connect; please try again.", { code: "network" }), 45_000);
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current()) { mic.getTracks().forEach(track => track.stop()); return; }
      run.mic = mic;
      const peer = new RTCPeerConnection(); run.peer = peer;
      peer.ontrack = event => {
        if (!current() || !audio.current) return;
        const stream = new MediaStream([event.track]);
        audio.current.srcObject = stream;
        setRemoteStream(stream);
        void audio.current.play().catch(() => { if (current()) setView(v => ({ ...v, playbackBlocked: true })); });
      };
      peer.onconnectionstatechange = () => {
        if (current() && ["failed", "disconnected", "closed"].includes(peer.connectionState)) fail("The voice connection ended; please try again.", { code: "network" });
      };
      mic.getAudioTracks().forEach(track => {
        peer.addTrack(track, mic);
        track.onended = () => { if (current()) fail("The microphone disconnected; check it and try again."); };
      });
      const channel = peer.createDataChannel("oai-events"); run.channel = channel;
      let speakingTimer: ReturnType<typeof setTimeout> | undefined;
      channel.onmessage = event => {
        if (!current()) return;
        const previous = run.events;
        run.events = reduceLiveEvent(previous, event.data);
        if (run.events.error) { fail(describeError("model_unavailable"), { code: "model_unavailable" }); return; }
        if (run.events.closed) { cleanup(run, "Conversation ended; your microphone is off."); return; }
        if (!previous.started && run.events.started) {
          clearTimeout(startup); run.timers.delete(startup);
          setView(v => ({ ...v, phase: "live", avatar: "listening", status: "I'm listening. What strategy is on your mind?" }));
        }
        if (previous.transcripts !== run.events.transcripts && run.events.transcripts.at(-1)?.speaker === "user") activityRef.current?.input();
        const speaking = previous.parrot !== run.events.parrot;
        const thinking = run.events.delegations.some(d => d.running) || run.draining ||
          run.events.calls.some(c => !run.processedCalls.has(c.callId));
        setView(v => ({ ...v, user: run.events.user, parrot: run.events.parrot, avatar: speaking ? "speaking" : thinking ? "thinking" : "listening" }));
        if (speaking) {
          if (speakingTimer) { clearTimeout(speakingTimer); run.timers.delete(speakingTimer); }
          speakingTimer = later(() => setView(v => ({ ...v, avatar: run.events.delegations.some(d => d.running) || run.draining ? "thinking" : "listening" })), 1200);
        }
        void drain();
      };
      channel.onerror = () => { if (current()) fail("The voice connection failed; please try again.", { code: "network" }); };
      channel.onclose = () => { if (current()) fail("Conversation ended; final usage was not confirmed.", { code: "network" }); };
      await peer.setLocalDescription(await peer.createOffer());
      if (!current()) return;
      if (peer.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
        const finish = (ok: boolean) => {
          clearTimeout(timer); run.timers.delete(timer);
          peer.removeEventListener("icegatheringstatechange", changed);
          run.controller.signal.removeEventListener("abort", aborted);
          if (ok) resolve(); else reject(new Error("ICE"));
        };
        const changed = () => { if (peer.iceGatheringState === "complete") finish(true); };
        const aborted = () => finish(false);
        const timer = setTimeout(() => finish(false), 10_000); run.timers.add(timer);
        peer.addEventListener("icegatheringstatechange", changed);
        run.controller.signal.addEventListener("abort", aborted, { once: true }); changed();
      });
      if (!current()) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("SDP");
      const result = await post("/live/session", { sdp }, isLiveSession, signal());
      if (!current()) return;
      if ("error" in result) {
        const message = result.error.code === "disabled" ? "Live voice is resting right now."
          : describeError(result.error.code, result.error.retryAfterSec);
        fail(message, result.error); return;
      }
      run.deadline = Date.now() + result.data.maxSessionSeconds * 1000;
      const tick = () => {
        const remaining = Math.max(0, Math.ceil((run.deadline! - Date.now()) / 1000));
        setView(v => ({ ...v, remaining }));
        if (!remaining) end(); else if (!run.closing) later(tick, 250);
      };
      tick();
      await peer.setRemoteDescription({ type: "answer", sdp: result.data.transport.sdp });
    } catch (error) {
      if (!current()) return;
      const micDenied = error instanceof Error && error.name === "NotAllowedError";
      const micMissing = error instanceof Error && ["NotFoundError", "NotReadableError"].includes(error.name);
      fail(micDenied ? "Allow microphone access in your browser to talk live."
        : micMissing ? "Check your microphone and try again."
        : "My voice could not connect; please try again.", micDenied || micMissing ? null : { code: "network" });
    }
  }
  function toggleMute() {
    const run = active.current;
    if (!run || run.closing || !run.mic || !run.events.started) return;
    run.muted = !run.muted;
    setMicEnabled(run.mic, !run.muted);
    setView(v => ({ ...v, muted: !!run.muted }));
  }
  async function resumeAudio() {
    const run = active.current;
    if (!run || !audio.current) return;
    try {
      await audio.current.play();
      if (active.current === run) setView(v => ({ ...v, playbackBlocked: false }));
    } catch { /* Keep the user-gesture retry available if playback is still blocked. */ }
  }
  return { view, audio, remoteStream, start, end, toggleMute, resumeAudio, active: view.phase !== "idle" };
}
