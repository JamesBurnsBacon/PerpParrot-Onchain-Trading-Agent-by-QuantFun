import {buildMirrorPlan} from './core.ts';
import type {AccountState, MarketLimit, MirrorResult, PositionsSnapshot} from './core.ts';
import {selectSpotChecks} from './operations.ts';
import type {ConfirmedFreeze, FrozenConfiguration} from '../../shared/src/frozen.ts';

/** Adapters must authenticate the chain confirmation and query master accounts,
 * not signing wallets. This runner has no signing or order submission capability. */
export interface PaperMirrorAdapters {
  confirmedFreeze(signal: AbortSignal): Promise<ConfirmedFreeze>;
  snapshot(signal: AbortSignal): Promise<PositionsSnapshot>;
  account(address: string, signal: AbortSignal): Promise<AccountState>;
}
export interface PaperMirrorRun {
  configuration: FrozenConfiguration;
  /** Agreed unpredictable seed supplied by trusted orchestration. */
  sampleSeed: string;
  markets: MarketLimit[];
  runId: string;
  maxStateAgeMs: number;
  deadlineMs: number;
}
/** One snapshot plus at most eleven direct account calls; chain confirmation is
 * a separate adapter. No backend fallback, report delivery, or retries in-run. */
export async function runPaperMirror(
  input: PaperMirrorRun, adapters: PaperMirrorAdapters, now: () => number,
): Promise<MirrorResult> {
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0 || input.deadlineMs > 10_000) {
    return {status: 'HOLD', reason: 'invalid run deadline'};
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const saved = structuredClone(input);
    const startedAt = now();
    if (!Number.isSafeInteger(startedAt)) throw new Error('invalid run clock');
    const task = async (): Promise<MirrorResult> => {
      const sampledAddresses = selectSpotChecks(saved.configuration, saved.sampleSeed);
      const [confirmedFreeze, snapshot, account, checks] = await Promise.all([
        adapters.confirmedFreeze(controller.signal), adapters.snapshot(controller.signal),
        adapters.account(saved.configuration.account, controller.signal),
        Promise.all(sampledAddresses.map(address => adapters.account(address, controller.signal))),
      ]);
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs < startedAt || nowMs - startedAt >= saved.deadlineMs) {
        throw new Error('run deadline or clock violation');
      }
      return buildMirrorPlan({...saved, confirmedFreeze, snapshot, account, checks, sampledAddresses, nowMs});
    };
    const deadline = new Promise<MirrorResult>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('mirror deadline exceeded'));
      }, saved.deadlineMs);
    });
    return await Promise.race([task(), deadline]);
  } catch {
    // Adapter exceptions may contain credentials or upstream payloads.
    return {status: 'HOLD', reason: 'mirror fetch, validation, or deadline failed'};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
