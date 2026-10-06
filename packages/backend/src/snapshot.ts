import {validateFrozenConfiguration} from '../../shared/src/frozen.ts';
import type {FrozenConfiguration} from '../../shared/src/frozen.ts';
import {snapshotHash} from '../../shared/src/mirror-state.ts';
import type {AccountState,PositionsSnapshot} from '../../shared/src/mirror-state.ts';
/** The :x9 producer publishes only complete batches. Persistence and scheduling
 * adapters must atomically replace the current snapshot; no partial publication. */
export async function produceSnapshot(configuration:FrozenConfiguration,fetchAccount:(address:string,signal:AbortSignal)=>Promise<AccountState>,now:()=>number,signal:AbortSignal):Promise<PositionsSnapshot> {
  validateFrozenConfiguration(configuration);
  const saved=structuredClone(configuration);
  const sources=structuredClone(await Promise.all(saved.sources.map(source=>fetchAccount(source.sourceAddress,signal))));
  const publishedAtMs=now();
  if(signal.aborted||!Number.isSafeInteger(publishedAtMs)||publishedAtMs<saved.frozenAtMs||sources.some((state,i)=>state.address!==saved.sources[i].sourceAddress||state.observedAtMs>publishedAtMs||publishedAtMs-state.observedAtMs>60000))throw new Error('incomplete or stale snapshot batch');
  const payload={configurationHash:saved.configurationHash,publishedAtMs,sources};
  if(new TextEncoder().encode(JSON.stringify({...payload,snapshotHash:'0x'+'0'.repeat(64)})).length>23000)throw new Error('snapshot exceeds consensus budget');
  return {...payload,snapshotHash:snapshotHash(payload)};
}
