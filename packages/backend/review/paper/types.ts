import type {CommitteeReceipt} from '../committee/types.ts';
import type {FrozenConfiguration} from '../../../shared/src/frozen-runtime.ts';
export interface PaperSession {id:string;review:CommitteeReceipt|null;configuration:FrozenConfiguration|null;paused:boolean}
export interface PaperEvent {mode:'PAPER';economicAuthority:false;[key:string]:unknown}
export interface PaperStore {
  load(session:string):Promise<PaperSession>;
  pause(session:string,configurationHash:string,paused:boolean):Promise<void>;
  review(session:string,receipt:CommitteeReceipt):Promise<void>;
  freeze(session:string,receiptHash:string,configuration:FrozenConfiguration):Promise<void>;
  event(session:string,key:string,payload:PaperEvent):Promise<void>;
  get(session:string,key:string):Promise<PaperEvent|null>;
}
