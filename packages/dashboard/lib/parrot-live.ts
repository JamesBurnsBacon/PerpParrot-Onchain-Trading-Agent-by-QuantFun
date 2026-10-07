import { isChatResponse, type ChatResponse } from "./parrot";

export type LiveStrategy = Pick<ChatResponse, "ok" | "intent" | "policy" | "shortlist" | "changes"> & { evidence: NonNullable<ChatResponse["evidence"]> } & { facts: string };
export type LiveSession = { ok: true; session: { id: string }; transport: { sdp: string }; maxSessionSeconds: number };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,256}$/.test(v);
const bytes = (text: string) => new TextEncoder().encode(text).length;
export const isLiveSession = (v: unknown): v is LiveSession => record(v) && v.ok === true && record(v.session) && id(v.session.id) &&
  record(v.transport) && typeof v.transport.sdp === "string" && v.transport.sdp.startsWith("v=0") && bytes(v.transport.sdp) <= 65536 &&
  typeof v.maxSessionSeconds === "number" && Number.isInteger(v.maxSessionSeconds) && v.maxSessionSeconds >= 1 && v.maxSessionSeconds <= 900;
export const liveAsChat = (v: LiveStrategy): ChatResponse => ({ ...v, reply: v.intent.reply, clarify: null, model: "Live voice", latencyMs: 0 });
export const isLiveStrategy = (v: unknown): v is LiveStrategy => record(v) && record(v.intent) && typeof v.facts === "string" &&
  Array.isArray(v.evidence) && v.facts.length <= 1200 && isChatResponse({ ...v, reply: v.intent.reply, clarify: null, model: "Live voice", latencyMs: 0 });

export type Transcript = { delta: string; startMs: number; endMs: number; speaker: "user" | "parrot" };
export type ToolCall = { callId: string; responseId: string; delegationId: string; args?: Record<string, unknown>; error?: string };
type Delegation = { id: string; responseId?: string; running: boolean };
export type LiveEvents = {
  started: boolean; closed: boolean; error: boolean; user: string; parrot: string;
  transcripts: Transcript[]; delegations: Delegation[]; calls: ToolCall[]; seenCalls: string[];
  readyResponses: string[]; finalUsageSeconds?: number;
};
export const initialLiveEvents = (): LiveEvents => ({ started: false, closed: false, error: false, user: "", parrot: "",
  transcripts: [], delegations: [], calls: [], seenCalls: [], readyResponses: [] });
// Track handled call IDs, not completed responses: more calls may arrive after completion.
export const pendingLiveCalls = (state: LiveEvents, processedCalls: ReadonlySet<string>) =>
  state.calls.filter(call => state.readyResponses.includes(call.responseId) && !processedCalls.has(call.callId));

// A POST remains unfinished until drain handles its result and records the call ID.
export const hasUnfinishedLiveStrategy = (state: LiveEvents, processedCalls: ReadonlySet<string>) =>
  state.calls.some(call => !processedCalls.has(call.callId));

const invalidCall = "Strategy could not be checked: invalid tool arguments.";

export function reduceLiveEvent(state: LiveEvents, raw: unknown): LiveEvents {
  if (state.closed || state.error) return state;
  if (typeof raw !== "string" || bytes(raw) > 64 * 1024) return { ...state, error: true };
  let event: unknown;
  try { event = JSON.parse(raw); } catch { return { ...state, error: true }; }
  if (!record(event)) return state;
  if (event.type === "session.started") return { ...state, started: true };
  if (event.type === "session.closed") return { ...state, closed: true, finalUsageSeconds: record(event.usage) && typeof event.usage.seconds === "number" ? event.usage.seconds : undefined };
  if (event.type === "error") return { ...state, error: true };
  if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
    if (typeof event.delta !== "string" || bytes(event.delta) > 8192 || typeof event.start_ms !== "number" || !Number.isFinite(event.start_ms) ||
        typeof event.end_ms !== "number" || !Number.isFinite(event.end_ms) || event.start_ms < 0 || event.end_ms < event.start_ms) return state;
    const speaker = event.type === "session.input_transcript.delta" ? "user" : "parrot";
    const fragment: Transcript = { speaker, delta: event.delta, startMs: event.start_ms, endMs: event.end_ms };
    return { ...state, [speaker]: (state[speaker] + event.delta).slice(-4000), transcripts: [...state.transcripts, fragment].slice(-256) };
  }
  if (event.type === "session.delegation.created") {
    if (!record(event.delegation) || !id(event.delegation.id) || event.delegation.target !== "responses") return state;
    const delegationId = event.delegation.id;
    if (state.delegations.some(d => d.id === delegationId)) return state;
    if (state.delegations.length >= 128) return { ...state, error: true };
    return { ...state, delegations: [...state.delegations, { id: delegationId, responseId: id(event.delegation.response_id) ? event.delegation.response_id : undefined, running: true }] };
  }
  if (event.type !== "response.event" || !id(event.delegation_id) || !record(event.event)) return state;
  const delegationId = event.delegation_id;
  const nested = event.event;
  if (nested.type === "response.created" && record(nested.response) && id(nested.response.id)) {
    const responseId = nested.response.id;
    if (state.delegations.length >= 128 && !state.delegations.some(d => d.id === delegationId)) return { ...state, error: true };
    return { ...state, delegations: [...state.delegations.filter(d => d.id !== delegationId), { id: delegationId, responseId, running: true }] };
  }
  const delegation = state.delegations.find(d => d.id === delegationId);
  if (!delegation?.responseId) return state;
  if (nested.type === "response.completed") {
    if (!record(nested.response) || !id(nested.response.id)) return state;
    const responseId = nested.response.id;
    return { ...state, readyResponses: [...new Set([...state.readyResponses, responseId])].slice(-128),
      delegations: state.delegations.map(d => d.id === delegationId && d.responseId === responseId ? { ...d, running: false } : d) };
  }
  if (nested.type === "response.failed" || nested.type === "response.incomplete" || nested.type === "error") return { ...state, error: true };
  if (nested.type !== "response.output_item.done" || !record(nested.item) || nested.item.type !== "function_call") return state;
  const item = nested.item;
  if (!id(item.call_id)) return { ...state, error: true };
  if (state.seenCalls.includes(item.call_id)) return state;
  if (state.seenCalls.length >= 128) return { ...state, error: true };
  const call: ToolCall = { callId: item.call_id, responseId: delegation.responseId, delegationId };
  try {
    if (item.name !== "set_strategy" || typeof item.arguments !== "string" || bytes(item.arguments) > 2048) throw new Error();
    const args: unknown = JSON.parse(item.arguments);
    if (!record(args)) throw new Error();
    call.args = args;
  } catch { call.error = invalidCall; }
  return { ...state, seenCalls: [...state.seenCalls, item.call_id], calls: [...state.calls, call] };
}

export const functionOutput = (callId: string, output: string) => ({
  type: "response.item.create", event_id: `tool_${callId}`, item: { type: "function_call_output", call_id: callId, output },
} as const);
export const continueResponse = (responseId: string) => ({ type: "response.create", event_id: `continue_${responseId}` } as const);
export const functionResultMessages = (calls: { callId: string; output: string }[], responseId: string) =>
  [...calls.map(c => functionOutput(c.callId, c.output)), continueResponse(responseId)];

// Muting only disables the microphone tracks: the session, the parrot's voice and the data channel keep running.
export const setMicEnabled = (stream: { getAudioTracks: () => { enabled: boolean }[] } | null | undefined, enabled: boolean): void => {
  stream?.getAudioTracks().forEach(track => { track.enabled = enabled; });
};
