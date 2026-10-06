import {keccak_256} from '@noble/hashes/sha3.js';
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js';
import type {Frame, Policy} from './contracts.ts';

function jsonOnly(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    // RFC 8785 requires valid Unicode: reject lone surrogate code units.
    if ([...value].some(character=>{const point=character.codePointAt(0)!;return point>=0xd800 && point<=0xdfff;})) throw new Error('invalid Unicode');
    return;
  }
  if (typeof value === 'number') {if(!Number.isFinite(value))throw new Error('nonfinite JSON number');return;}
  if (typeof value !== 'object' || value === undefined) throw new Error('non-JSON value');
  if (ancestors.has(value)) throw new Error('cyclic JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null) throw new Error('non-JSON object');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for(let i=0;i<value.length;i++){if(!Object.hasOwn(value,i))throw new Error('sparse JSON array');jsonOnly(value[i],ancestors);}
  } else {
    const object = value as Record<string, unknown>;
    for(const key of Object.keys(object).sort()){jsonOnly(key,ancestors);jsonOnly(object[key],ancestors);}
  }
  ancestors.delete(value);
}
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonicalize).join(',')+']';
  const object=value as Record<string,unknown>;
  return '{'+Object.keys(object).sort().map(key=>JSON.stringify(key)+':'+canonicalize(object[key])).join(',')+'}';
}
/** Wire format: keccak256(UTF8(JCS({domain,payload}))). */
export function commitment(domain: string, payload: unknown): string {
  if (!/^perpparrot:[a-z-]+:v1$/.test(domain)) throw new Error('invalid commitment domain');
  const envelope={domain,payload};jsonOnly(envelope);
  return '0x'+bytesToHex(keccak_256(utf8ToBytes(canonicalize(envelope)!)));
}
export function policyCommitment(policy: Policy): string {return commitment('perpparrot:policy:v1',policy);}
export function snapshotCommitment(frame: Frame, addresses: ReadonlyMap<number,string>): string {
  const {snapshotHash,...evidence}=frame;
  const sourceMapping=[...addresses].sort(([a],[b])=>a-b).map(([candidate,sourceAddress])=>({candidate,sourceAddress}));
  return commitment('perpparrot:snapshot:v1',{evidence,sourceMapping});
}
export function verifyInputCommitments(frame: Frame, policy: Policy, addresses: ReadonlyMap<number,string>): boolean {
  return frame.policyHash===policyCommitment(policy) && frame.snapshotHash===snapshotCommitment(frame,addresses);
}
