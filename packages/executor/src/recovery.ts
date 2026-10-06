import {z} from 'zod';
import {decimal} from '../../shared/src/decimal.ts';
import {compileExecutionPreview} from './compiler.ts';
import {validateExecutionPreview} from '../../shared/src/execution-preview.ts';
import type {ExecutionPreview} from '../../shared/src/execution-preview.ts';
import type {MirrorInput} from '../../shared/src/mirror-state.ts';
export interface RunKey {chain:number;account:string;run:string;hash:string}
export interface PreviewClaim {claimed:boolean;state:'PREPARED'|'UNKNOWN'|'TERMINAL';nonce:number;receipt:unknown}
export interface PreviewStore {
  claim(key:RunKey,signer:string,nowMs:number):Promise<PreviewClaim>;
  unknown(key:RunKey):Promise<void>;
  finish(key:RunKey,receipt:unknown):Promise<void>;
}
const receiptSchema=z.object({mode:z.literal('PREVIEW'),reportHash:z.string().regex(/^0x[0-9a-f]{64}$/),
  orders:z.array(z.object({cloid:z.string().regex(/^0x[0-9a-f]{32}$/),state:z.enum(['FILLED','CANCELED','REJECTED']),filledSize:z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)}).strict()).max(10),
}).strict();
export type PreviewReceipt=z.infer<typeof receiptSchema>;
/** A simulation adapter, not a signer or exchange transport. No built-in broadcast. */
export interface PreviewVenue {
  simulate(report:ExecutionPreview,nonce:number):Promise<unknown>;
  reconcile(report:ExecutionPreview):Promise<unknown|null>;
}
function validateReceipt(value:unknown,report:ExecutionPreview):PreviewReceipt {
  const receipt=receiptSchema.parse(value);
  if(receipt.reportHash!==report.reportHash||receipt.orders.length!==report.orders.length||new Set(receipt.orders.map(o=>o.cloid)).size!==receipt.orders.length||receipt.orders.some(o=>!report.orders.some(order=>order.cloid===o.cloid)))throw new Error('incomplete reconciliation');
  for(const fill of receipt.orders) {
    const order=report.orders.find(order=>order.cloid===fill.cloid)!;
    const actual=decimal(fill.filledSize),requested=decimal(order.size);
    if(actual.n*requested.d>requested.n*actual.d||fill.state==='REJECTED'&&actual.n!==0n||fill.state==='FILLED'&&actual.n*requested.d!==requested.n*actual.d)throw new Error('invalid terminal fill size');
  }
  return receipt;
}
export class RecoverablePreviewExecutor {
  private readonly store:PreviewStore;
  private readonly venue:PreviewVenue;
  constructor(store:PreviewStore,venue:PreviewVenue){this.store=store;this.venue=venue;}
  async execute(value:unknown,input:MirrorInput,context:unknown,signer:string,nowMs:number):Promise<PreviewReceipt|null> {
    const report=validateExecutionPreview(value,nowMs),rebuilt=compileExecutionPreview({...input,nowMs},context);
    if(report.reportHash!==rebuilt.reportHash||!/^0x[0-9a-f]{40}$/.test(signer))throw new Error('preview evidence mismatch');
    const key={chain:report.chainId,account:report.account,run:report.runId,hash:report.reportHash};
    const claim=await this.store.claim(key,signer,nowMs);
    if(claim.state==='TERMINAL')return validateReceipt(claim.receipt,report);
    let raw:unknown;
    if(!claim.claimed) {
      raw=await this.venue.reconcile(report);
      if(raw===null)return null; // Unknown never authorizes a second submission.
    } else {
      try {raw=await this.venue.simulate(report,claim.nonce);}
      catch {await this.store.unknown(key);return null;}
    }
    try {
      const receipt=validateReceipt(raw,report);
      await this.store.finish(key,receipt);return receipt;
    } catch {await this.store.unknown(key);return null;}
  }
  /** Read-only recovery remains possible after report expiry. It cannot create
   * claims or submit/simulate another order. Only known durable runs may finish. */
  async reconcile(report:ExecutionPreview):Promise<PreviewReceipt|null> {
    validateExecutionPreview(report,report.createdAtMs);
    const key={chain:report.chainId,account:report.account,run:report.runId,hash:report.reportHash};
    const raw=await this.venue.reconcile(report);if(raw===null)return null;
    const receipt=validateReceipt(raw,report);await this.store.finish(key,receipt);return receipt;
  }
}
