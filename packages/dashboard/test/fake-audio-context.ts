import { mock } from "bun:test";

const param = () => ({ value: 0, setValueAtTime: mock(() => {}), linearRampToValueAtTime: mock(() => {}), exponentialRampToValueAtTime: mock(() => {}) });
const node = () => ({ connect: mock(() => {}), disconnect: mock(() => {}), start: mock(() => {}), stop: mock((at?: number) => {}), onended: null as null | (() => void) });
export function fakeContext() {
  const made = { sources: [] as ReturnType<typeof node>[], oscillators: 0, nodes: 0 };
  const context = { state: "running", currentTime: 0, sampleRate: 8000, destination: {}, resume: mock(async () => {}), close: mock(async () => {}),
    createGain: () => { made.nodes++; return { gain: param(), connect: mock(() => {}), disconnect: mock(() => {}) }; },
    createDynamicsCompressor: () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createBuffer: (_c: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => { made.nodes++; const v = { ...node(), buffer: null as unknown }; made.sources.push(v); return v; },
    createBiquadFilter: () => { made.nodes++; return { ...node(), type: "lowpass", frequency: param() }; },
    createOscillator: () => { made.nodes++; made.oscillators++; const v = { ...node(), frequency: param(), type: "sine" }; made.sources.push(v); return v; } };
  return { context, made };
}
